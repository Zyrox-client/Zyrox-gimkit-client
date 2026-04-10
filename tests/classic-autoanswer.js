// ==UserScript==
// @name         Zyrox classic auto-answer
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Automatically answers questions in Gimkit Classic mode.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxClassicAutoAnswer]";
  const COLYSEUS_ROOM_DATA = 13;

  const state = {
    roomId: null,
    sockets: new Set(),
    questions: [],
    questionIdList: [],
    currentQuestionIndex: -1,
    sentQuestionIds: new Set(),
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
        let code = str.charCodeAt(i);
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

    return { channel: first.value, body: message };
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
      eventName,
      payload: eventPayload,
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
        state.currentQuestionIndex = Number.isInteger(data?.value?.questionIndex) ? data.value.questionIndex : -1;
      } else if (type === "PLAYER_QUESTION_LIST_INDEX") {
        state.currentQuestionIndex = Number.isInteger(data?.value) ? data.value : state.currentQuestionIndex;
      }
    }
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

  function answerCurrentQuestion() {
    const question = getCurrentQuestion();
    if (!question) return;

    const answer = parseQuestionAnswer(question);
    const questionId = question?._id || question?.id;
    if (!answer || !questionId || state.sentQuestionIds.has(questionId)) return;

    const sent = sendBlueboatMessage("QUESTION_ANSWERED", { questionId, answer });
    if (sent) {
      state.sentQuestionIds.add(questionId);
      console.log(LOG_PREFIX, "Answered question", { questionId, answer });
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

    const colyseus = decodeColyseusPacket(normalized);
    if (colyseus) {
      answerCurrentQuestion();
      return;
    }

    const blueboatBinary = decodeBlueboatBinary(normalized);
    if (!blueboatBinary) return;

    if (typeof blueboatBinary.eventName === "string" && blueboatBinary.eventName.startsWith("message-")) {
      state.roomId = blueboatBinary.eventName.slice("message-".length);
    }

    if (blueboatBinary.eventName === "blueboat_SEND_MESSAGE") {
      state.roomId = blueboatBinary.payload?.room || state.roomId;
    }

    if (blueboatBinary.payload && typeof blueboatBinary.payload === "object") {
      applyBlueboatStateUpdate(blueboatBinary.payload);
    }

    answerCurrentQuestion();
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
          inspectPacket(event.data).catch((err) => console.warn(LOG_PREFIX, "Failed to inspect packet:", err));
        });
      }
    };

    console.log(LOG_PREFIX, "Ready. Auto-answering Classic mode questions.");
  }

  install();
})();
