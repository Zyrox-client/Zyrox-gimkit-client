// ==UserScript==
// @name         Zyrox classic auto-answer
// @namespace    https://github.com/zyrox
// @version      0.3.1
// @description  Tracks Classic mode questions and exposes a one-shot answer command.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxClassicAutoAnswer]";
  const COLYSEUS_ROOM_DATA = 13;
  const ENGINE_PACKET_TYPES = { "0": "OPEN", "1": "CLOSE", "2": "PING", "3": "PONG", "4": "MESSAGE", "5": "UPGRADE", "6": "NOOP" };
  const SOCKET_PACKET_TYPES = { "0": "CONNECT", "1": "DISCONNECT", "2": "EVENT", "3": "ACK", "4": "ERROR", "5": "BINARY_EVENT", "6": "BINARY_ACK" };

  const state = {
    sockets: new Set(),
    roomId: null,
    questions: [],
    questionIdList: [],
    currentQuestionIndex: -1,
    lastQuestionIndex: -1,
    sentQuestionIds: new Set(),
  };

  function setCurrentQuestionIndex(nextIndex) {
    if (!Number.isInteger(nextIndex)) return;
    if (state.currentQuestionIndex !== -1 && nextIndex < state.currentQuestionIndex) {
      state.sentQuestionIds.clear();
      console.log(LOG_PREFIX, "Detected question index reset; cleared answered-question cache.");
    }
    state.lastQuestionIndex = state.currentQuestionIndex;
    state.currentQuestionIndex = nextIndex;
  }

  function resetAnsweredCache(reason) {
    state.sentQuestionIds.clear();
    console.log(LOG_PREFIX, `Cleared answered-question cache (${reason}).`);
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    return value == null ? [] : [value];
  }

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
        else {
          const codePoint = ((byte & 0x07) << 18) | ((view.getUint8(offset++) & 0x3f) << 12) | ((view.getUint8(offset++) & 0x3f) << 6) | (view.getUint8(offset++) & 0x3f);
          const cp = codePoint - 0x10000;
          out += String.fromCharCode((cp >> 10) + 0xd800, (cp & 1023) + 0xdc00);
        }
      }
      return out;
    };

    const read = () => {
      const token = view.getUint8(offset++);
      if (token < 0x80) return token;
      if (token < 0x90) {
        const size = token & 0x0f;
        const map = {};
        for (let i = 0; i < size; i++) map[read()] = read();
        return map;
      }
      if (token < 0xa0) {
        const size = token & 0x0f;
        const arr = [];
        for (let i = 0; i < size; i++) arr.push(read());
        return arr;
      }
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

  function msgpackEncode(value) {
    const bytes = [];
    const deferred = [];

    const write = (input) => {
      const type = typeof input;
      if (type === "string") {
        let len = 0;
        for (let i = 0; i < input.length; i++) {
          const code = input.charCodeAt(i);
          if (code < 128) len++;
          else if (code < 2048) len += 2;
          else if (code < 55296 || code > 57343) len += 3;
          else { i++; len += 4; }
        }
        if (len < 32) bytes.push(160 | len);
        else if (len < 256) bytes.push(217, len);
        else if (len < 65536) bytes.push(218, len >> 8, len & 255);
        else bytes.push(219, len >> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255);
        deferred.push({ type: "string", value: input, offset: bytes.length });
        bytes.length += len;
        return;
      }
      if (type === "number") {
        if (Number.isInteger(input) && Number.isFinite(input) && input >= 0 && input < 128) {
          bytes.push(input);
          return;
        }
        if (Number.isInteger(input) && Number.isFinite(input) && input >= 0 && input < 65536) {
          bytes.push(205, input >> 8, input & 255);
          return;
        }
        bytes.push(203);
        deferred.push({ type: "float64", value: input, offset: bytes.length });
        bytes.length += 8;
        return;
      }
      if (type === "boolean") { bytes.push(input ? 195 : 194); return; }
      if (input == null) { bytes.push(192); return; }
      if (Array.isArray(input)) {
        const len = input.length;
        if (len < 16) bytes.push(144 | len); else bytes.push(220, len >> 8, len & 255);
        for (const item of input) write(item);
        return;
      }
      const keys = Object.keys(input).filter((k) => typeof input[k] !== "function");
      const len = keys.length;
      if (len < 16) bytes.push(128 | len); else bytes.push(222, len >> 8, len & 255);
      for (const key of keys) { write(key); write(input[key]); }
    };

    write(value);

    const view = new DataView(new ArrayBuffer(bytes.length));
    for (let i = 0; i < bytes.length; i++) view.setUint8(i, bytes[i] & 255);

    for (const part of deferred) {
      if (part.type === "float64") {
        view.setFloat64(part.offset, part.value);
        continue;
      }
      let at = part.offset;
      const str = part.value;
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code < 128) view.setUint8(at++, code);
        else if (code < 2048) {
          view.setUint8(at++, 192 | (code >> 6));
          view.setUint8(at++, 128 | (code & 63));
        } else {
          view.setUint8(at++, 224 | (code >> 12));
          view.setUint8(at++, 128 | ((code >> 6) & 63));
          view.setUint8(at++, 128 | (code & 63));
        }
      }
    }

    return view.buffer;
  }

  function decodeColyseusPacket(packet) {
    if (!(packet instanceof ArrayBuffer)) return null;
    const bytes = new Uint8Array(packet);
    if (bytes[0] !== COLYSEUS_ROOM_DATA) return null;

    const first = msgpackDecode(packet, 1);
    if (!first) return null;

    let message = null;
    if (bytes.byteLength > first.offset) {
      const second = msgpackDecode(packet, first.offset);
      message = second?.value;
    }

    return { transport: "colyseus", channel: first.value, body: message };
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

    return {
      transport: "blueboat-binary",
      socketPacketType: decoded.type,
      eventName,
      payload: eventPayload,
      raw: decoded,
    };
  }

  function decodeEngineSocketString(text) {
    if (typeof text !== "string" || !text.length) return null;
    if (!/^[0-6]/.test(text[0])) return null;

    const engineCode = text[0];
    let cursor = 1;
    let socketCode = null;

    if (text.length > 1 && /[0-6]/.test(text[1])) {
      socketCode = text[1];
      cursor = 2;
    }

    let namespace = "/";
    if (text[cursor] === "/") {
      const comma = text.indexOf(",", cursor);
      if (comma !== -1) {
        namespace = text.slice(cursor, comma);
        cursor = comma + 1;
      }
    }

    const payloadRaw = text.slice(cursor);
    let payload = payloadRaw;
    const jsonStart = payloadRaw.search(/[\[{]/);
    if (jsonStart >= 0) {
      const jsonCandidate = payloadRaw.slice(jsonStart);
      try { payload = JSON.parse(jsonCandidate); } catch { payload = payloadRaw; }
    }

    return {
      transport: "engine.io/socket.io",
      engineCode,
      engineType: ENGINE_PACKET_TYPES[engineCode] || "UNKNOWN",
      socketCode,
      socketType: socketCode ? SOCKET_PACKET_TYPES[socketCode] || "UNKNOWN" : null,
      namespace,
      payload,
      raw: text,
    };
  }

  function parseQuestionAnswer(question) {
    if (!question) return null;
    if (question.type === "text") return question.answers?.[0]?.text || null;
    return question.answers?.find((a) => a?.correct)?.id || question.answers?.find((a) => a?.correct)?._id || null;
  }

  function getCurrentQuestion() {
    const currentId = state.questionIdList[state.currentQuestionIndex];
    if (!currentId) return null;
    return state.questions.find((q) => q?._id === currentId || q?.id === currentId) || null;
  }

  function getNextUnansweredQuestion() {
    const current = getCurrentQuestion();
    if (current) {
      const currentId = current?._id || current?.id;
      if (currentId && !state.sentQuestionIds.has(currentId)) return current;
    }

    for (const questionId of state.questionIdList) {
      if (!questionId || state.sentQuestionIds.has(questionId)) continue;
      const match = state.questions.find((q) => q?._id === questionId || q?.id === questionId);
      if (match) return match;
    }

    return state.questions.find((q) => {
      const id = q?._id || q?.id;
      return id && !state.sentQuestionIds.has(id);
    }) || null;
  }

  function sendBlueboatMessage(key, data) {
    const socket = [...state.sockets].at(-1);
    if (!socket || socket.readyState !== 1 || !state.roomId) return false;

    const payload = {
      type: 2,
      data: ["blueboat_SEND_MESSAGE", { room: state.roomId, key, data }],
      options: { compress: true },
      nsp: "/",
    };

    const encoded = msgpackEncode(payload);
    const out = new Uint8Array(1 + encoded.byteLength);
    out[0] = 4;
    out.set(new Uint8Array(encoded), 1);
    socket.send(out.buffer);
    return true;
  }

  function answerCurrentQuestionOnce() {
    const question = getNextUnansweredQuestion();
    if (!question) {
      return {
        ok: false,
        reason: "NO_QUESTION_AVAILABLE",
        trackedQuestions: state.questions.length,
        questionListSize: state.questionIdList.length,
        currentQuestionIndex: state.currentQuestionIndex,
      };
    }

    const answer = parseQuestionAnswer(question);
    const questionId = question?._id || question?.id;
    if (!questionId) {
      return { ok: false, reason: "MISSING_QUESTION_ID" };
    }
    if (state.sentQuestionIds.has(questionId)) {
      return { ok: false, reason: "ALREADY_ANSWERED", questionId };
    }
    if (!answer) {
      return { ok: false, reason: "NO_ANSWER_FOUND", questionId };
    }

    const ok = sendBlueboatMessage("QUESTION_ANSWERED", { questionId, answer });
    if (ok) {
      state.sentQuestionIds.add(questionId);
      console.log(LOG_PREFIX, "Sent single QUESTION_ANSWERED", { questionId, answer });
      return { ok: true, questionId, answer };
    }

    return { ok: false, reason: "SEND_FAILED", questionId, answer };
  }

  function applyBlueboatStateUpdate(packet) {
    const key = packet?.key;
    const data = packet?.data;
    if (typeof key !== "string") return;

    if (key === "STATE_UPDATE") {
      const type = data?.type;
      if (type === "GAME_QUESTIONS") {
        state.questions = Array.isArray(data?.value) ? data.value : [];
      } else if (type === "PLAYER_QUESTION_LIST") {
        state.questionIdList = data?.value?.questionList || [];
        if (Number.isInteger(data?.value?.questionIndex)) setCurrentQuestionIndex(data.value.questionIndex);
        resetAnsweredCache("PLAYER_QUESTION_LIST update");
      } else if (type === "PLAYER_QUESTION_LIST_INDEX") {
        if (Number.isInteger(data?.value)) setCurrentQuestionIndex(data.value);
      }
    } else if (key === "PLAYER_QUESTION_LIST" && data?.questionList) {
      state.questionIdList = data.questionList;
      if (Number.isInteger(data?.questionIndex)) setCurrentQuestionIndex(data.questionIndex);
      resetAnsweredCache("PLAYER_QUESTION_LIST direct update");
    } else if (key === "PLAYER_QUESTION_LIST_INDEX" && Number.isInteger(data)) {
      setCurrentQuestionIndex(data);
    } else if (key === "GAME_QUESTIONS" && Array.isArray(data)) {
      state.questions = data;
    } else if (key === "QUESTION_REVEALED" && data) {
      const q = data?.question || data;
      const questionId = q?._id || q?.id;
      if (questionId && !state.questions.find((item) => (item?._id || item?.id) === questionId)) {
        state.questions.push(q);
      }
    }
  }

  function extractBlueboatStateCandidates(payload) {
    const candidates = [];
    for (const item of asArray(payload)) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.key === "string") candidates.push(item);
      if (item.data && typeof item.data === "object" && typeof item.data.key === "string") candidates.push(item.data);
      if (Array.isArray(item.events)) {
        for (const eventItem of item.events) {
          if (eventItem && typeof eventItem === "object" && typeof eventItem.key === "string") {
            candidates.push(eventItem);
          }
        }
      }
    }
    return candidates;
  }

  function onDecodedPacket(decoded) {
    if (!decoded) return;
    if (decoded.transport === "colyseus") return;

    if (decoded.transport === "blueboat-binary") {
      if (typeof decoded.eventName === "string" && decoded.eventName.startsWith("message-")) {
        state.roomId = decoded.eventName.slice("message-".length);
      }
      if (decoded.eventName === "blueboat_SEND_MESSAGE") {
        state.roomId = decoded.payload?.room || state.roomId;
      }

      if (decoded.payload && typeof decoded.payload === "object") {
        const candidates = extractBlueboatStateCandidates(decoded.payload);
        for (const candidate of candidates) applyBlueboatStateUpdate(candidate);
      }

      return;
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

    if (typeof normalized === "string") {
      onDecodedPacket(decodeEngineSocketString(normalized));
      return;
    }

    onDecodedPacket(decodeColyseusPacket(normalized));
    onDecodedPacket(decodeBlueboatBinary(normalized));
  }

  function install() {
    const NativeWebSocket = window.WebSocket;

    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);

        const target = String(url || "");
        if (!target.includes("gimkitconnect.com")) return;

        state.sockets.add(this);

        this.addEventListener("message", (event) => {
          inspectPacket(event.data).catch((err) => console.warn(LOG_PREFIX, "Failed to inspect incoming packet:", err));
        });
      }

      send(data) {
        inspectPacket(data).catch((err) => console.warn(LOG_PREFIX, "Failed to inspect outgoing packet:", err));
        return super.send(data);
      }
    };

    window.__zyroxClassicAutoAnswer = {
      answerOne() {
        return answerCurrentQuestionOnce();
      },
      getState() {
        return {
          roomId: state.roomId,
          questions: state.questions.length,
          questionListSize: state.questionIdList.length,
          currentQuestionIndex: state.currentQuestionIndex,
          lastQuestionIndex: state.lastQuestionIndex,
          answeredCount: state.sentQuestionIds.size,
        };
      },
    };

    console.log(LOG_PREFIX, "Ready. Run __zyroxClassicAutoAnswer.answerOne() in console to send one answer.");
  }

  install();
})();
