// ==UserScript==
// @name         Gimkit Auto Answer (No UI)
// @description  Auto answer only (page-context). Includes internal colyseus socket hook when page socketManager is unavailable.
// @namespace    https://www.github.com/TheLazySquid/GimkitCheat/
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @version      1.3.0
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  function pageMain() {
    const LOG = "[AutoAnswer][page]";
    const TICK = 1000;

    const colyseusProtocol = { ROOM_DATA: 13 };

    function msgpackEncode(value) {
      const bytes = [];
      const deferred = [];
      const write = (input) => {
        const type = typeof input;
        if (type === "string") {
          let len = 0;
          for (let i = 0; i < input.length; i++) {
            const code = input.charCodeAt(i);
            if (code < 128) len++; else if (code < 2048) len += 2; else if (code < 55296 || code > 57343) len += 3; else { i++; len += 4; }
          }
          if (len < 32) bytes.push(160 | len); else if (len < 256) bytes.push(217, len); else bytes.push(218, len >> 8, len & 255);
          deferred.push({ type: "string", value: input, offset: bytes.length });
          bytes.length += len;
          return;
        }
        if (type === "number") {
          if (Number.isInteger(input) && input >= 0 && input < 128) { bytes.push(input); return; }
          if (Number.isInteger(input) && input >= 0 && input < 65536) { bytes.push(205, input >> 8, input & 255); return; }
          bytes.push(203); deferred.push({ type: "float64", value: input, offset: bytes.length }); bytes.length += 8; return;
        }
        if (type === "boolean") { bytes.push(input ? 195 : 194); return; }
        if (input == null) { bytes.push(192); return; }
        if (Array.isArray(input)) {
          const len = input.length;
          if (len < 16) bytes.push(144 | len); else bytes.push(220, len >> 8, len & 255);
          for (const item of input) write(item);
          return;
        }
        const keys = Object.keys(input);
        const len = keys.length;
        if (len < 16) bytes.push(128 | len); else bytes.push(222, len >> 8, len & 255);
        for (const key of keys) { write(key); write(input[key]); }
      };
      write(value);
      const view = new DataView(new ArrayBuffer(bytes.length));
      for (let i = 0; i < bytes.length; i++) view.setUint8(i, bytes[i] & 255);
      for (const part of deferred) {
        if (part.type === "float64") { view.setFloat64(part.offset, part.value); continue; }
        let offset = part.offset;
        const s = part.value;
        for (let i = 0; i < s.length; i++) {
          let code = s.charCodeAt(i);
          if (code < 128) view.setUint8(offset++, code);
          else if (code < 2048) { view.setUint8(offset++, 192 | (code >> 6)); view.setUint8(offset++, 128 | (code & 63)); }
          else { view.setUint8(offset++, 224 | (code >> 12)); view.setUint8(offset++, 128 | ((code >> 6) & 63)); view.setUint8(offset++, 128 | (code & 63)); }
        }
      }
      return view.buffer;
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
          else out += String.fromCharCode(((byte & 0x0f) << 12) | ((view.getUint8(offset++) & 0x3f) << 6) | (view.getUint8(offset++) & 0x3f));
        }
        return out;
      };
      const read = () => {
        const token = view.getUint8(offset++);
        if (token < 0x80) return token;
        if (token < 0x90) { const size = token & 0x0f; const map = {}; for (let i = 0; i < size; i++) map[read()] = read(); return map; }
        if (token < 0xa0) { const size = token & 0x0f; const arr = new Array(size); for (let i = 0; i < size; i++) arr[i] = read(); return arr; }
        if (token < 0xc0) return readString(token & 0x1f);
        if (token > 0xdf) return token - 256;
        switch (token) {
          case 192: return null;
          case 194: return false;
          case 195: return true;
          case 202: { const n = view.getFloat32(offset); offset += 4; return n; }
          case 203: { const n = view.getFloat64(offset); offset += 8; return n; }
          case 204: { const n = view.getUint8(offset); offset += 1; return n; }
          case 205: { const n = view.getUint16(offset); offset += 2; return n; }
          case 206: { const n = view.getUint32(offset); offset += 4; return n; }
          case 208: { const n = view.getInt8(offset); offset += 1; return n; }
          case 209: { const n = view.getInt16(offset); offset += 2; return n; }
          case 210: { const n = view.getInt32(offset); offset += 4; return n; }
          case 217: { const len = view.getUint8(offset); offset += 1; return readString(len); }
          case 218: { const len = view.getUint16(offset); offset += 2; return readString(len); }
          case 220: { const size = view.getUint16(offset); offset += 2; const arr = new Array(size); for (let i = 0; i < size; i++) arr[i] = read(); return arr; }
          case 222: { const size = view.getUint16(offset); offset += 2; const map = {}; for (let i = 0; i < size; i++) map[read()] = read(); return map; }
          default: return null;
        }
      };
      const value = read();
      return { value, offset };
    }

    function parseChangePacket(packet) {
      const out = [];
      for (const change of packet?.changes || []) {
        const data = {};
        const keys = change[1].map((index) => packet.values[index]);
        for (let i = 0; i < keys.length; i++) data[keys[i]] = change[2][i];
        out.push({ id: change[0], data });
      }
      return out;
    }

    class LocalSocketManager extends EventTarget {
      constructor() {
        super();
        this.socket = null;
        this.transportType = "unknown";
        this.playerId = null;
        this.install();
      }
      install() {
        const manager = this;
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(url, protocols) {
            super(url, protocols);
            if (String(url || "").includes("gimkitconnect.com")) manager.registerSocket(this);
          }
          send(data) {
            super.send(data);
          }
        };
      }
      registerSocket(socket) {
        this.socket = socket;
        this.transportType = "colyseus";
        console.log(LOG, "Registered WebSocket", socket.url);

        socket.addEventListener("message", (e) => {
          const decoded = this.decodeColyseus(e.data);
          if (!decoded) return;
          this.dispatchEvent(new CustomEvent("colyseusMessage", { detail: decoded }));
          if (decoded.type === "AUTH_ID") {
            this.playerId = decoded.message;
            console.log(LOG, "Got player id", this.playerId);
          }
          if (decoded.type === "DEVICES_STATES_CHANGES") {
            const parsed = parseChangePacket(decoded.message);
            this.dispatchEvent(new CustomEvent("deviceChanges", { detail: parsed }));
          }
        });
      }
      decodeColyseus(data) {
        const bytes = new Uint8Array(data);
        if (bytes[0] !== colyseusProtocol.ROOM_DATA) return null;
        const first = msgpackDecode(data, 1);
        if (!first) return null;
        let message;
        if (bytes.byteLength > first.offset) {
          const second = msgpackDecode(data, first.offset);
          message = second?.value;
        }
        return { type: first.value, message };
      }
      sendMessage(channel, payload) {
        if (!this.socket) return;
        const header = new Uint8Array([colyseusProtocol.ROOM_DATA]);
        const a = new Uint8Array(msgpackEncode(channel));
        const b = new Uint8Array(msgpackEncode(payload));
        const packet = new Uint8Array(header.length + a.length + b.length);
        packet.set(header, 0);
        packet.set(a, header.length);
        packet.set(b, header.length + a.length);
        this.socket.send(packet);
      }
    }

    const socketManager = window.socketManager || new LocalSocketManager();
    window.socketManager = socketManager;

    const state = {
      questions: [],
      answerDeviceId: null,
      currentQuestionId: null,
      questionIdList: [],
      currentQuestionIndex: -1,
    };

    function answerQuestion() {
      if (socketManager.transportType === "colyseus") {
        if (state.currentQuestionId == null || state.answerDeviceId == null) return;
        const question = state.questions.find((q) => q._id == state.currentQuestionId);
        if (!question) return;
        const packet = { key: "answered", deviceId: state.answerDeviceId, data: {} };
        if (question.type == "text") packet.data.answer = question.answers[0].text;
        else packet.data.answer = question.answers.find((a) => a.correct)?._id;
        if (!packet.data.answer) return;
        socketManager.sendMessage("MESSAGE_FOR_DEVICE", packet);
        console.log(LOG, "Answered colyseus", state.currentQuestionId);
      } else {
        const questionId = state.questionIdList[state.currentQuestionIndex];
        const question = state.questions.find((q) => q._id == questionId);
        if (!question) return;
        const answer = question.type == "mc" ? question.answers.find((a) => a.correct)?._id : question.answers[0]?.text;
        if (!answer) return;
        socketManager.sendMessage("QUESTION_ANSWERED", { answer, questionId });
        console.log(LOG, "Answered blueboat", questionId);
      }
    }

    socketManager.addEventListener("deviceChanges", (event) => {
      for (const { id, data } of event.detail || []) {
        for (const key in data || {}) {
          if (key === "GLOBAL_questions") {
            state.questions = JSON.parse(data[key]);
            state.answerDeviceId = id;
            console.log(LOG, "Got questions", state.questions.length);
          }
          if (socketManager.playerId && key === `PLAYER_${socketManager.playerId}_currentQuestionId`) {
            state.currentQuestionId = data[key];
          }
        }
      }
    });

    socketManager.addEventListener("blueboatMessage", (event) => {
      if (event.detail?.key !== "STATE_UPDATE") return;
      switch (event.detail.data.type) {
        case "GAME_QUESTIONS":
          state.questions = event.detail.data.value;
          break;
        case "PLAYER_QUESTION_LIST":
          state.questionIdList = event.detail.data.value.questionList;
          state.currentQuestionIndex = event.detail.data.value.questionIndex;
          break;
        case "PLAYER_QUESTION_LIST_INDEX":
          state.currentQuestionIndex = event.detail.data.value;
          break;
      }
    });

    setInterval(answerQuestion, TICK);
    console.log(LOG, "Started auto-answer", { transportType: socketManager.transportType });
  }

  const el = document.createElement("script");
  el.textContent = `;(${pageMain.toString()})();`;
  (document.head || document.documentElement).appendChild(el);
  el.remove();
})();
