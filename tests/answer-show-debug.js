// ==UserScript==
// @name         Zyrox answer show debug
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Logs the current Classic question to the console from packet data.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxAnswerShowDebug]";

  const state = {
    questions: [],
    questionIdList: [],
    currentQuestionIndex: -1,
    loggedQuestionIds: new Set(),
    hasLoggedFullSet: false,
  };

  function msgpackDecode(buffer, startOffset = 0) {
    const view = new DataView(buffer);
    let offset = startOffset;

    const readString = (len) => {
      let out = "";
      const end = offset + len;
      while (offset < end) {
        const byte = view.getUint8(offset++);
        if ((byte & 0x80) === 0) out += String.fromCharCode(byte);
        else if ((byte & 0xe0) === 0xc0) out += String.fromCharCode(((byte & 0x1f) << 6) | (view.getUint8(offset++) & 0x3f));
        else if ((byte & 0xf0) === 0xe0) out += String.fromCharCode(((byte & 0x0f) << 12) | ((view.getUint8(offset++) & 0x3f) << 6) | (view.getUint8(offset++) & 0x3f));
      }
      return out;
    };

    const read = () => {
      const token = view.getUint8(offset++);
      if (token < 0x80) return token;
      if (token < 0x90) { const size = token & 0x0f; const map = {}; for (let i = 0; i < size; i++) map[read()] = read(); return map; }
      if (token < 0xa0) { const size = token & 0x0f; const arr = []; for (let i = 0; i < size; i++) arr.push(read()); return arr; }
      if (token < 0xc0) return readString(token & 0x1f);
      if (token > 0xdf) return token - 256;

      switch (token) {
        case 192: return null;
        case 194: return false;
        case 195: return true;
        case 196: { const n = view.getUint8(offset); offset += 1; const out = buffer.slice(offset, offset + n); offset += n; return out; }
        case 197: { const n = view.getUint16(offset); offset += 2; const out = buffer.slice(offset, offset + n); offset += n; return out; }
        case 198: { const n = view.getUint32(offset); offset += 4; const out = buffer.slice(offset, offset + n); offset += n; return out; }
        case 202: { const v = view.getFloat32(offset); offset += 4; return v; }
        case 203: { const v = view.getFloat64(offset); offset += 8; return v; }
        case 204: { const v = view.getUint8(offset); offset += 1; return v; }
        case 205: { const v = view.getUint16(offset); offset += 2; return v; }
        case 206: { const v = view.getUint32(offset); offset += 4; return v; }
        case 208: { const v = view.getInt8(offset); offset += 1; return v; }
        case 209: { const v = view.getInt16(offset); offset += 2; return v; }
        case 210: { const v = view.getInt32(offset); offset += 4; return v; }
        case 217: { const n = view.getUint8(offset); offset += 1; return readString(n); }
        case 218: { const n = view.getUint16(offset); offset += 2; return readString(n); }
        case 219: { const n = view.getUint32(offset); offset += 4; return readString(n); }
        case 220: { const n = view.getUint16(offset); offset += 2; const arr = []; for (let i = 0; i < n; i++) arr.push(read()); return arr; }
        case 221: { const n = view.getUint32(offset); offset += 4; const arr = []; for (let i = 0; i < n; i++) arr.push(read()); return arr; }
        case 222: { const n = view.getUint16(offset); offset += 2; const map = {}; for (let i = 0; i < n; i++) map[read()] = read(); return map; }
        case 223: { const n = view.getUint32(offset); offset += 4; const map = {}; for (let i = 0; i < n; i++) map[read()] = read(); return map; }
        default: return null;
      }
    };

    return { value: read(), offset };
  }

  function decodeBlueboatBinary(packet) {
    if (!(packet instanceof ArrayBuffer)) return null;
    const bytes = new Uint8Array(packet);
    if (!bytes.byteLength || bytes[0] !== 4) return null;

    const decoded = msgpackDecode(packet.slice(1), 0)?.value;
    if (!decoded || typeof decoded !== "object") return null;

    const data = decoded?.data;
    const eventName = Array.isArray(data) ? data[0] : null;
    const eventPayload = Array.isArray(data) ? data[1] : data;

    return { eventName, payload: eventPayload };
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    return value == null ? [] : [value];
  }

  function extractBlueboatStateCandidates(payload) {
    const candidates = [];
    for (const item of asArray(payload)) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.key === "string") candidates.push(item);
      if (item.data && typeof item.data === "object" && typeof item.data.key === "string") candidates.push(item.data);
      if (Array.isArray(item.events)) {
        for (const eventItem of item.events) {
          if (eventItem && typeof eventItem === "object" && typeof eventItem.key === "string") candidates.push(eventItem);
        }
      }
    }
    return candidates;
  }

  function getQuestionById(questionId) {
    if (!questionId) return null;
    return state.questions.find((q) => q?._id === questionId || q?.id === questionId) || null;
  }

  function upsertQuestion(question) {
    const questionId = question?._id || question?.id;
    if (!questionId) return;

    const existingIndex = state.questions.findIndex((q) => (q?._id || q?.id) === questionId);
    if (existingIndex === -1) state.questions.push(question);
    else state.questions[existingIndex] = question;
  }

  function logQuestion(reason, question, index) {
    if (!question) return;

    const questionId = question?._id || question?.id;
    if (!questionId || state.loggedQuestionIds.has(questionId)) return;
    state.loggedQuestionIds.add(questionId);

    console.log(LOG_PREFIX, reason, {
      index,
      questionId,
      type: question.type,
      text: question.text,
      prompt: question.prompt,
      answers: question.answers,
      question,
    });
  }

  function getOrderedResolvedQuestions() {
    const ordered = [];
    for (let i = 0; i < state.questionIdList.length; i++) {
      const questionId = state.questionIdList[i];
      const question = getQuestionById(questionId);
      if (!question) return null;
      ordered.push({ index: i, questionId, question });
    }
    return ordered;
  }

  function logAllQuestionsOnce(reason) {
    if (state.hasLoggedFullSet) return;
    if (!state.questionIdList.length) return;

    const resolved = getOrderedResolvedQuestions();
    if (!resolved) return;

    state.hasLoggedFullSet = true;
    console.group(`${LOG_PREFIX} ${reason} (all questions)`);
    for (const entry of resolved) {
      state.loggedQuestionIds.add(entry.questionId);
      console.log(`${LOG_PREFIX} question`, {
        index: entry.index,
        questionId: entry.questionId,
        type: entry.question.type,
        text: entry.question.text,
        prompt: entry.question.prompt,
        answers: entry.question.answers,
        question: entry.question,
      });
    }
    console.groupEnd();
  }

  function logCurrentQuestion(reason) {
    const currentId = state.questionIdList[state.currentQuestionIndex];
    const question = getQuestionById(currentId);
    logQuestion(reason, question, state.currentQuestionIndex);
  }

  function applyBlueboatStateUpdate(packet) {
    const key = packet?.key;
    const data = packet?.data;
    if (typeof key !== "string") return;

    if (key === "STATE_UPDATE") {
      const type = data?.type;
      if (type === "GAME_QUESTIONS") {
        state.questions = Array.isArray(data?.value) ? data.value : [];
        for (let i = 0; i < state.questionIdList.length; i++) {
          const q = getQuestionById(state.questionIdList[i]);
          logQuestion("GAME_QUESTIONS list", q, i);
        }
        logAllQuestionsOnce("GAME_QUESTIONS");
        logCurrentQuestion("GAME_QUESTIONS current");
      } else if (type === "PLAYER_QUESTION_LIST") {
        state.questionIdList = data?.value?.questionList || [];
        state.hasLoggedFullSet = false;
        if (Number.isInteger(data?.value?.questionIndex)) state.currentQuestionIndex = data.value.questionIndex;
        for (let i = 0; i < state.questionIdList.length; i++) {
          const q = getQuestionById(state.questionIdList[i]);
          logQuestion("PLAYER_QUESTION_LIST", q, i);
        }
        logAllQuestionsOnce("PLAYER_QUESTION_LIST");
        logCurrentQuestion("PLAYER_QUESTION_LIST current");
      } else if (type === "PLAYER_QUESTION_LIST_INDEX") {
        if (Number.isInteger(data?.value)) state.currentQuestionIndex = data.value;
        logAllQuestionsOnce("PLAYER_QUESTION_LIST_INDEX");
        logCurrentQuestion("PLAYER_QUESTION_LIST_INDEX");
      }
    } else if (key === "PLAYER_QUESTION_LIST" && data?.questionList) {
      state.questionIdList = data.questionList;
      state.hasLoggedFullSet = false;
      if (Number.isInteger(data?.questionIndex)) state.currentQuestionIndex = data.questionIndex;
      for (let i = 0; i < state.questionIdList.length; i++) {
        const q = getQuestionById(state.questionIdList[i]);
        logQuestion("PLAYER_QUESTION_LIST direct", q, i);
      }
      logAllQuestionsOnce("PLAYER_QUESTION_LIST direct");
      logCurrentQuestion("PLAYER_QUESTION_LIST direct current");
    } else if (key === "PLAYER_QUESTION_LIST_INDEX" && Number.isInteger(data)) {
      state.currentQuestionIndex = data;
      logAllQuestionsOnce("PLAYER_QUESTION_LIST_INDEX direct");
      logCurrentQuestion("PLAYER_QUESTION_LIST_INDEX direct");
    } else if (key === "GAME_QUESTIONS" && Array.isArray(data)) {
      state.questions = data;
      for (let i = 0; i < state.questionIdList.length; i++) {
        const q = getQuestionById(state.questionIdList[i]);
        logQuestion("GAME_QUESTIONS direct", q, i);
      }
      logAllQuestionsOnce("GAME_QUESTIONS direct");
      logCurrentQuestion("GAME_QUESTIONS direct current");
    } else if (key === "QUESTION_REVEALED" && data) {
      const q = data?.question || data;
      upsertQuestion(q);
      const qid = q?._id || q?.id;
      const index = state.questionIdList.findIndex((id) => id === qid);
      logQuestion("QUESTION_REVEALED", q, index);
      logAllQuestionsOnce("QUESTION_REVEALED");
      logCurrentQuestion("QUESTION_REVEALED current");
    }
  }

  async function normalizeData(raw) {
    if (raw instanceof ArrayBuffer) return raw;
    if (ArrayBuffer.isView(raw)) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    if (typeof Blob !== "undefined" && raw instanceof Blob) return raw.arrayBuffer();
    return raw;
  }

  async function inspectPacket(raw) {
    const normalized = await normalizeData(raw);
    if (!(normalized instanceof ArrayBuffer)) return;

    const decoded = decodeBlueboatBinary(normalized);
    if (!decoded?.payload || typeof decoded.payload !== "object") return;

    const candidates = extractBlueboatStateCandidates(decoded.payload);
    for (const candidate of candidates) applyBlueboatStateUpdate(candidate);
  }

  const nativeAddEventListener = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (type, listener, options) {
    if (type === "message" && !this.__zyroxAnswerShowPatched) {
      this.__zyroxAnswerShowPatched = true;
      nativeAddEventListener.call(this, "message", (event) => {
        inspectPacket(event.data).catch(() => {});
      });
    }
    return nativeAddEventListener.call(this, type, listener, options);
  };

  const nativeOnMessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
  if (nativeOnMessage?.set) {
    Object.defineProperty(WebSocket.prototype, "onmessage", {
      configurable: true,
      enumerable: nativeOnMessage.enumerable,
      get: nativeOnMessage.get,
      set(handler) {
        if (!this.__zyroxAnswerShowPatched) {
          this.__zyroxAnswerShowPatched = true;
          this.addEventListener("message", (event) => {
            inspectPacket(event.data).catch(() => {});
          });
        }
        return nativeOnMessage.set.call(this, handler);
      },
    });
  }

  console.log(LOG_PREFIX, "Loaded. Watching packets for current question updates.");
})();
