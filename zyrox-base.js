// ==UserScript==
// @name         Zyrox client (gimkit)
// @namespace    https://github.com/zyrox
// @version      1.8.2
// @description  A modern userscript hacked client for gimkit
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/Zyrox-client/Zyrox-gimkit-client/refs/heads/main/zyrox-base.js
// @downloadURL  https://raw.githubusercontent.com/Zyrox-client/Zyrox-gimkit-client/refs/heads/main/zyrox-base.js
// @icon         https://raw.githubusercontent.com/Zyrox-client/Zyrox-gimkit-client/refs/heads/main/images/logo.png
// @license      MIT
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  // Some userscript runtimes execute bundled code that expects a global `Module`.
  // with `enable/disable` methods. Provide a minimal compatible fallback.
  if (typeof globalThis.Module === "undefined") {
    globalThis.Module = class Module {
      constructor(name = "Module", options = {}) {
        this.name = name;
        this.enabled = false;
        this.onEnable = typeof options.onEnable === "function" ? options.onEnable : () => {};
        this.onDisable = typeof options.onDisable === "function" ? options.onDisable : () => {};
      }

      enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.onEnable();
      }

      disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.onDisable();
      }
    };
  }

  if (window.__ZYROX_UI_MOUNTED__) return;
  window.__ZYROX_UI_MOUNTED__ = true;

  // ---------------------------------------------------------------------------
  // AUTO-ANSWER PAGE-CONTEXT INJECTION
  // Injected as a real <script> tag so it runs in page scope and patches
  // window.WebSocket BEFORE Gimkit creates its connection.
  // Mirrors autoanswer.js 1:1, but exposes window.__zyroxAutoAnswer.start/stop
  // so the Zyrox module toggle controls it.
  // ---------------------------------------------------------------------------
  (function injectAutoAnswerPageContext() {
    function pageMain() {
      const LOG = "[AutoAnswer][page]";
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
            case 217: { const n = view.getUint8(offset); offset += 1; return readString(n); }
            case 218: { const n = view.getUint16(offset); offset += 2; return readString(n); }
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
          this.blueboatRoomId = null;
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
              manager.onSend(data);
              super.send(data);
            }
          };
        }
        registerSocket(socket) {
          this.socket = socket;
          console.log(LOG, "Registered WebSocket", socket.url);
          socket.addEventListener("message", (e) => {
            const firstByte = (() => {
              try {
                return new Uint8Array(e.data)[0];
              } catch (_) {
                return null;
              }
            })();
            if (this.transportType === "unknown" && firstByte != null) {
              this.transportType = firstByte === 4 ? "blueboat" : "colyseus";
            }
            if (this.transportType === "blueboat") {
              const decoded = this.decodeBlueboat(e.data);
              if (!decoded) return;
              this.dispatchEvent(new CustomEvent("blueboatMessage", { detail: decoded }));
              if (typeof decoded.eventName === "string" && decoded.eventName.startsWith("message-")) {
                this.blueboatRoomId = decoded.eventName.slice("message-".length);
              }
            } else {
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
            }
          });
        }
        decodeBlueboat(data) {
          const bytes = new Uint8Array(data);
          if (!bytes.byteLength || bytes[0] !== 4) return null;
          const decoded = msgpackDecode(data.slice(1), 0)?.value;
          const payload = Array.isArray(decoded?.data) ? decoded.data[1] : decoded?.data;
          return {
            eventName: Array.isArray(decoded?.data) ? decoded.data[0] : null,
            payload,
          };
        }
        onSend(data) {
          if (this.transportType !== "blueboat") return;
          const decoded = this.decodeBlueboat(data);
          if (!decoded) return;
          if (decoded?.payload?.room) this.blueboatRoomId = decoded.payload.room;
          if (decoded?.payload?.roomId) this.blueboatRoomId = decoded.payload.roomId;
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
          if (this.transportType === "blueboat") {
            if (!this.blueboatRoomId) return;
            const encoded = msgpackEncode({
              type: 2,
              data: ["blueboat_SEND_MESSAGE", { room: this.blueboatRoomId, key: channel, data: payload }],
              options: { compress: true },
              nsp: "/",
            });
            const out = new Uint8Array(1 + encoded.byteLength);
            out[0] = 4;
            out.set(new Uint8Array(encoded), 1);
            this.socket.send(out.buffer);
            return;
          }
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
        sentQuestionIds: new Set(),
      };

      function asArray(value) {
        if (Array.isArray(value)) return value;
        return value == null ? [] : [value];
      }

      function parseQuestionAnswer(question) {
        if (!question) return null;
        if (question.type === "text") return question.answers?.[0]?.text || null;
        return question.answers?.find((a) => a?.correct)?.id || question.answers?.find((a) => a?.correct)?._id || null;
      }

      function findQuestionById(id) {
        return state.questions.find((q) => q?._id == id || q?.id == id) || null;
      }

      function setCurrentQuestionIndex(nextIndex) {
        if (!Number.isInteger(nextIndex)) return;
        if (state.currentQuestionIndex !== -1 && nextIndex < state.currentQuestionIndex) {
          state.sentQuestionIds.clear();
        }
        state.currentQuestionIndex = nextIndex;
      }

      function resetAnsweredCache() {
        state.sentQuestionIds.clear();
      }

      function getNextUnansweredQuestion() {
        const currentId = state.questionIdList[state.currentQuestionIndex];
        if (currentId) {
          const current = findQuestionById(currentId);
          const id = current?._id || current?.id;
          if (current && id && !state.sentQuestionIds.has(id)) return current;
        }

        for (const questionId of state.questionIdList) {
          if (!questionId || state.sentQuestionIds.has(questionId)) continue;
          const match = findQuestionById(questionId);
          if (match) return match;
        }

        return state.questions.find((q) => {
          const id = q?._id || q?.id;
          return id && !state.sentQuestionIds.has(id);
        }) || null;
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
            resetAnsweredCache();
          } else if (type === "PLAYER_QUESTION_LIST_INDEX") {
            if (Number.isInteger(data?.value)) setCurrentQuestionIndex(data.value);
          }
        } else if (key === "PLAYER_QUESTION_LIST" && data?.questionList) {
          state.questionIdList = data.questionList;
          if (Number.isInteger(data?.questionIndex)) setCurrentQuestionIndex(data.questionIndex);
          resetAnsweredCache();
        } else if (key === "PLAYER_QUESTION_LIST_INDEX" && Number.isInteger(data)) {
          setCurrentQuestionIndex(data);
        } else if (key === "GAME_QUESTIONS" && Array.isArray(data)) {
          state.questions = data;
        } else if (key === "QUESTION_REVEALED" && data) {
          const question = data?.question || data;
          const questionId = question?._id || question?.id;
          if (questionId && !findQuestionById(questionId)) state.questions.push(question);
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
              if (eventItem && typeof eventItem === "object" && typeof eventItem.key === "string") candidates.push(eventItem);
            }
          }
        }
        return candidates;
      }

      function answerQuestion() {
        if (socketManager.transportType === "colyseus") {
          if (state.currentQuestionId == null || state.answerDeviceId == null) return;
          const question = findQuestionById(state.currentQuestionId);
          if (!question) return;
          const packet = { key: "answered", deviceId: state.answerDeviceId, data: {} };
          if (question.type == "text") packet.data.answer = question.answers[0].text;
          else packet.data.answer = question.answers.find((a) => a.correct)?._id;
          if (!packet.data.answer) return;
          socketManager.sendMessage("MESSAGE_FOR_DEVICE", packet);
          console.log(LOG, "Answered colyseus", state.currentQuestionId);
        } else {
          const question = getNextUnansweredQuestion();
          if (!question) return;
          const questionId = question?._id || question?.id;
          if (!questionId || state.sentQuestionIds.has(questionId)) return;
          const answer = parseQuestionAnswer(question);
          if (!answer) return;
          socketManager.sendMessage("QUESTION_ANSWERED", { answer, questionId });
          state.sentQuestionIds.add(questionId);
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
        if (event.detail?.eventName === "blueboat_SEND_MESSAGE" && event.detail?.payload?.room) {
          socketManager.blueboatRoomId = event.detail.payload.room;
        }
        const candidates = extractBlueboatStateCandidates(event.detail?.payload);
        for (const candidate of candidates) applyBlueboatStateUpdate(candidate);
      });

      // Expose start/stop so the Zyrox module toggle controls the interval
      let _timerId = null;
      let _running = false;
      let _baseSpeed = 1000;
      const BLUEBOAT_EXTRA_DELAY_MS = 500;

      function getCurrentDelay() {
        if (socketManager.transportType === "blueboat") return _baseSpeed + BLUEBOAT_EXTRA_DELAY_MS;
        return _baseSpeed;
      }

      function scheduleNextTick() {
        if (!_running) return;
        const delay = Math.max(200, Number(getCurrentDelay()) || 1000);
        _timerId = setTimeout(() => {
          answerQuestion();
          scheduleNextTick();
        }, delay);
      }

      window.__zyroxAutoAnswer = {
        start(speed = 1000) {
          _baseSpeed = Math.max(200, Number(speed) || 1000);
          _running = true;
          if (_timerId) clearTimeout(_timerId);
          scheduleNextTick();
        },
        stop() {
          _running = false;
          if (_timerId) { clearTimeout(_timerId); _timerId = null; }
        },
      };
      console.log(LOG, "Page context ready, waiting for module toggle.");
    }

    const el = document.createElement("script");
    el.textContent = `;(${pageMain.toString()})();`;
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  })();

  (function injectEspPageContextBridge() {
    function pageMain() {
      const LOG = "[ESP][page]";
      const shared = {
        ready: false,
        lastUpdate: 0,
        localPlayerId: null,
        localTeamId: null,
        camera: null,
        players: [],
      };
      window.__zyroxEspShared = shared;

      function tick() {
        const serializer = window?.serializer;
        const characters = serializer?.state?.characters?.$items;
        const camera = window?.stores?.phaser?.scene?.cameras?.cameras?.[0];
        const localPlayerId = window?.socketManager?.playerId ?? null;
        const localCharacter = localPlayerId != null ? characters?.get?.(localPlayerId) : null;
        const localTeamId = localCharacter?.teamId ?? null;

        if (!characters || typeof characters[Symbol.iterator] !== "function" || !camera || localPlayerId == null || localTeamId == null) {
          shared.ready = false;
          shared.lastUpdate = Date.now();
          requestAnimationFrame(tick);
          return;
        }

        const outPlayers = [];
        for (const [id, character] of characters) {
          const x = Number(character?.x);
          const y = Number(character?.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          outPlayers.push({
            id: String(id ?? character?.id ?? "unknown"),
            name: String(character?.name ?? character?.displayName ?? character?.username ?? id ?? "Unknown"),
            teamId: character?.teamId ?? null,
            x,
            y,
          });
        }

        shared.ready = true;
        shared.lastUpdate = Date.now();
        shared.localPlayerId = localPlayerId;
        shared.localTeamId = localTeamId;
        shared.camera = {
          midX: Number(camera?.midPoint?.x ?? 0),
          midY: Number(camera?.midPoint?.y ?? 0),
          zoom: Number(camera?.zoom ?? 1),
        };
        shared.players = outPlayers;
        requestAnimationFrame(tick);
      }

      requestAnimationFrame(tick);
      console.log(LOG, "Bridge ready");
    }

    const el = document.createElement("script");
    el.textContent = `;(${pageMain.toString()})();`;
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  })();

  function readUserscriptVersion() {
    // Update this variable whenever you bump @version above.
    const CLIENT_VERSION = "1.7.7";
    return CLIENT_VERSION;
  }

  const CONFIG = {
    toggleKey: "\\",
    defaultToggleKey: "\\",
    title: "Zyrox",
    subtitle: "Client",
    version: readUserscriptVersion(),
    logoUrl: "https://raw.githubusercontent.com/Zyrox-client/Zyrox-gimkit-client/refs/heads/main/images/logo.png",
  };

  // --- Core Utilities & Networking (Extracted from Gimkit Cheat) ---

  const colyseusProtocol = {
    HANDSHAKE: 9,
    JOIN_ROOM: 10,
    ERROR: 11,
    LEAVE_ROOM: 12,
    ROOM_DATA: 13,
    ROOM_STATE: 14,
    ROOM_STATE_PATCH: 15,
    ROOM_DATA_SCHEMA: 16,
    ROOM_DATA_BYTES: 17,
  };

  function utf8Read(view, offset) {
    const length = view[offset++];
    let string = "";
    for (let i = offset, end = offset + length; i < end; i++) {
      const byte = view[i];
      if ((byte & 0x80) === 0x00) {
        string += String.fromCharCode(byte);
      } else if ((byte & 0xe0) === 0xc0) {
        string += String.fromCharCode(((byte & 0x1f) << 6) | (view[++i] & 0x3f));
      } else if ((byte & 0xf0) === 0xe0) {
        string += String.fromCharCode(((byte & 0x0f) << 12) | ((view[++i] & 0x3f) << 6) | ((view[++i] & 0x3f) << 0));
      }
    }
    return string;
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
          else {
            i++;
            len += 4;
          }
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
        if (Number.isInteger(input) && Number.isFinite(input)) {
          if (input >= 0) {
            if (input < 128) bytes.push(input);
            else if (input < 256) bytes.push(204, input);
            else if (input < 65536) bytes.push(205, input >> 8, input & 255);
            else if (input < 4294967296) bytes.push(206, input >> 24, (input >> 16) & 255, (input >> 8) & 255, input & 255);
            else {
              const hi = Math.floor(input / Math.pow(2, 32));
              const lo = input >>> 0;
              bytes.push(207, hi >> 24, (hi >> 16) & 255, (hi >> 8) & 255, hi & 255, lo >> 24, (lo >> 16) & 255, (lo >> 8) & 255, lo & 255);
            }
          } else if (input >= -32) bytes.push(input);
          else if (input >= -128) bytes.push(208, input & 255);
          else if (input >= -32768) bytes.push(209, (input >> 8) & 255, input & 255);
          else if (input >= -2147483648) bytes.push(210, (input >> 24) & 255, (input >> 16) & 255, (input >> 8) & 255, input & 255);
          else {
            const hi = Math.floor(input / Math.pow(2, 32));
            const lo = input >>> 0;
            bytes.push(211, hi >> 24, (hi >> 16) & 255, (hi >> 8) & 255, hi & 255, lo >> 24, (lo >> 16) & 255, (lo >> 8) & 255, lo & 255);
          }
          return;
        }
        bytes.push(203);
        deferred.push({ type: "float64", value: input, offset: bytes.length });
        bytes.length += 8;
        return;
      }
      if (type === "boolean") {
        bytes.push(input ? 195 : 194);
        return;
      }
      if (input == null) {
        bytes.push(192);
        return;
      }
      if (Array.isArray(input)) {
        const len = input.length;
        if (len < 16) bytes.push(144 | len);
        else if (len < 65536) bytes.push(220, len >> 8, len & 255);
        else bytes.push(221, len >> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255);
        for (const item of input) write(item);
        return;
      }
      const keys = Object.keys(input).filter((k) => typeof input[k] !== "function");
      const len = keys.length;
      if (len < 16) bytes.push(128 | len);
      else if (len < 65536) bytes.push(222, len >> 8, len & 255);
      else bytes.push(223, len >> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255);
      for (const key of keys) {
        write(key);
        write(input[key]);
      }
    };

    write(value);
    const view = new DataView(new ArrayBuffer(bytes.length));
    for (let i = 0; i < bytes.length; i++) view.setUint8(i, bytes[i] & 255);

    for (const part of deferred) {
      if (part.type === "float64") {
        view.setFloat64(part.offset, part.value);
        continue;
      }
      let offset = part.offset;
      const value = part.value;
      for (let i = 0; i < value.length; i++) {
        let code = value.charCodeAt(i);
        if (code < 128) view.setUint8(offset++, code);
        else if (code < 2048) {
          view.setUint8(offset++, 192 | (code >> 6));
          view.setUint8(offset++, 128 | (code & 63));
        } else if (code < 55296 || code > 57343) {
          view.setUint8(offset++, 224 | (code >> 12));
          view.setUint8(offset++, 128 | ((code >> 6) & 63));
          view.setUint8(offset++, 128 | (code & 63));
        } else {
          i++;
          code = 65536 + (((code & 1023) << 10) | (value.charCodeAt(i) & 1023));
          view.setUint8(offset++, 240 | (code >> 18));
          view.setUint8(offset++, 128 | ((code >> 12) & 63));
          view.setUint8(offset++, 128 | ((code >> 6) & 63));
          view.setUint8(offset++, 128 | (code & 63));
        }
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
        const arr = new Array(size);
        for (let i = 0; i < size; i++) arr[i] = read();
        return arr;
      }
      if (token < 0xc0) return readString(token & 0x1f);
      if (token > 0xdf) return token - 256;
      switch (token) {
        case 192: return null;
        case 194: return false;
        case 195: return true;
        case 196: { const n = view.getUint8(offset); offset += 1; const b = buffer.slice(offset, offset + n); offset += n; return b; }
        case 197: { const n = view.getUint16(offset); offset += 2; const b = buffer.slice(offset, offset + n); offset += n; return b; }
        case 198: { const n = view.getUint32(offset); offset += 4; const b = buffer.slice(offset, offset + n); offset += n; return b; }
        case 202: { const v = view.getFloat32(offset); offset += 4; return v; }
        case 203: { const v = view.getFloat64(offset); offset += 8; return v; }
        case 204: { const v = view.getUint8(offset); offset += 1; return v; }
        case 205: { const v = view.getUint16(offset); offset += 2; return v; }
        case 206: { const v = view.getUint32(offset); offset += 4; return v; }
        case 207: { const hi = view.getUint32(offset); const lo = view.getUint32(offset + 4); offset += 8; return (hi * Math.pow(2, 32)) + lo; }
        case 208: { const v = view.getInt8(offset); offset += 1; return v; }
        case 209: { const v = view.getInt16(offset); offset += 2; return v; }
        case 210: { const v = view.getInt32(offset); offset += 4; return v; }
        case 211: { const hi = view.getInt32(offset); const lo = view.getUint32(offset + 4); offset += 8; return (hi * Math.pow(2, 32)) + lo; }
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

  // Simplified msgpack-like encoding/decoding for Blueboat
  const blueboat = (() => {
    function encode(t, e, s) {
      let o = Array.isArray(t) ? { type: 2, data: t, options: { compress: !0 }, nsp: "/" } : { type: 2, data: ["blueboat_SEND_MESSAGE", { room: s, key: t, data: e }], options: { compress: !0 }, nsp: "/" };
      return (function(t) {
        let e = [], i = [], s = function t(e, n, i) {
          let s = typeof i, o = 0, r = 0, a = 0, c = 0, l = 0, u = 0;
          if ("string" === s) {
            l = (function(t) {
              let e = 0, n = 0, i = 0, s = t.length;
              for (i = 0; i < s; i++) (e = t.charCodeAt(i)) < 128 ? n += 1 : e < 2048 ? n += 2 : e < 55296 || 57344 <= e ? n += 3 : (i++, n += 4);
              return n;
            })(i);
            if (l < 32) e.push(160 | l), u = 1;
            else if (l < 256) e.push(217, l), u = 2;
            else if (l < 65536) e.push(218, l >> 8, l), u = 3;
            else e.push(219, l >> 24, l >> 16, l >> 8, l), u = 5;
            return n.push({ h: i, u: l, t: e.length }), u + l;
          }
          if ("number" === s) {
            if (Math.floor(i) === i && isFinite(i)) {
              if (i >= 0) {
                if (i < 128) return e.push(i), 1;
                if (i < 256) return e.push(204, i), 2;
                if (i < 65536) return e.push(205, i >> 8, i), 3;
                if (i < 4294967296) return e.push(206, i >> 24, i >> 16, i >> 8, i), 5;
                a = i / Math.pow(2, 32) >> 0; c = i >>> 0; e.push(207, a >> 24, a >> 16, a >> 8, a, c >> 24, c >> 16, c >> 8, c); return 9;
              } else {
                if (i >= -32) return e.push(i), 1;
                if (i >= -128) return e.push(208, i), 2;
                if (i >= -32768) return e.push(209, i >> 8, i), 3;
                if (i >= -2147483648) return e.push(210, i >> 24, i >> 16, i >> 8, i), 5;
                a = Math.floor(i / Math.pow(2, 32)); c = i >>> 0; e.push(211, a >> 24, a >> 16, a >> 8, a, c >> 24, c >> 16, c >> 8, c); return 9;
              }
            } else {
              e.push(203); n.push({ o: i, u: 8, t: e.length }); return 9;
            }
          }
          if ("object" === s) {
            if (null === i) return e.push(192), 1;
            if (Array.isArray(i)) {
              l = i.length;
              if (l < 16) e.push(144 | l), u = 1;
              else if (l < 65536) e.push(220, l >> 8, l), u = 3;
              else e.push(221, l >> 24, l >> 16, l >> 8, l), u = 5;
              for (o = 0; o < l; o++) u += t(e, n, i[o]);
              return u;
            }
            let d = [], f = "", p = Object.keys(i);
            for (o = 0, r = p.length; o < r; o++) "function" != typeof i[f = p[o]] && d.push(f);
            l = d.length;
            if (l < 16) e.push(128 | l), u = 1;
            else if (l < 65536) e.push(222, l >> 8, l), u = 3;
            else e.push(223, l >> 24, l >> 16, l >> 8, l), u = 5;
            for (o = 0; o < l; o++) u += t(e, n, f = d[o]), u += t(e, n, i[f]);
            return u;
          }
          if ("boolean" === s) return e.push(i ? 195 : 194), 1;
          return 0;
        }(e, i, t);
        let o = new ArrayBuffer(s), r = new DataView(o), a = 0, c = 0, l = -1;
        if (i.length > 0) l = i[0].t;
        for (let u, h = 0, d = 0, f = 0, p = e.length; f < p; f++) {
          r.setUint8(c + f, e[f]);
          if (f + 1 === l) {
            u = i[a]; h = u.u; d = c + l;
            if (u.l) { let g = new Uint8Array(u.l); for (let E = 0; E < h; E++) r.setUint8(d + E, g[E]); }
            else if (u.h) { (function(t, e, n) { for (let i = 0, s = 0, o = n.length; s < o; s++) (i = n.charCodeAt(s)) < 128 ? t.setUint8(e++, i) : (i < 2048 ? t.setUint8(e++, 192 | i >> 6) : (i < 55296 || 57344 <= i ? t.setUint8(e++, 224 | i >> 12) : (s++, i = 65536 + ((1023 & i) << 10 | 1023 & n.charCodeAt(s)), t.setUint8(e++, 240 | i >> 18), t.setUint8(e++, 128 | i >> 12 & 63)), t.setUint8(e++, 128 | i >> 6 & 63)), t.setUint8(e++, 128 | 63 & i)); })(r, d, u.h); }
            else if (void 0 !== u.o) r.setFloat64(d, u.o);
            c += h; if (i[++a]) l = i[a].t;
          }
        }
        let y = Array.from(new Uint8Array(o)); y.unshift(4); return new Uint8Array(y).buffer;
      })(o);
    }

    function decode(packet) {
      function e(t) {
        this.t = 0;
        if (t instanceof ArrayBuffer) { this.i = t; this.s = new DataView(this.i); }
        else { if (!ArrayBuffer.isView(t)) return null; this.i = t.buffer; this.s = new DataView(this.i, t.byteOffset, t.byteLength); }
      }
      e.prototype.g = function(t) { let e = new Array(t); for (let n = 0; n < t; n++) e[n] = this.v(); return e; };
      e.prototype.M = function(t) { let e = {}; for (let n = 0; n < t; n++) e[this.v()] = this.v(); return e; };
      e.prototype.h = function(t) {
        let e = (function(t, e, n) {
          let i = "", s = 0, o = e, r = e + n;
          for (; o < r; o++) {
            let a = t.getUint8(o);
            if (0 != (128 & a)) {
              if (192 != (224 & a)) {
                if (224 != (240 & a)) {
                  s = (7 & a) << 18 | (63 & t.getUint8(++o)) << 12 | (63 & t.getUint8(++o)) << 6 | (63 & t.getUint8(++o)) << 0;
                  if (65536 <= s) { s -= 65536; i += String.fromCharCode(55296 + (s >>> 10), 56320 + (1023 & s)); }
                  else i += String.fromCharCode(s);
                } else i += String.fromCharCode((15 & a) << 12 | (63 & t.getUint8(++o)) << 6 | (63 & t.getUint8(++o)) << 0);
              } else i += String.fromCharCode((31 & a) << 6 | 63 & t.getUint8(++o));
            } else i += String.fromCharCode(a);
          }
          return i;
        })(this.s, this.t, t);
        this.t += t; return e;
      };
      e.prototype.l = function(t) { let e = this.i.slice(this.t, this.t + t); this.t += t; return e; };
      e.prototype.v = function() {
        if (!this.s) return null;
        let t, e = this.s.getUint8(this.t++), n = 0, i = 0, s = 0, o = 0;
        if (e < 192) return e < 128 ? e : e < 144 ? this.M(15 & e) : e < 160 ? this.g(15 & e) : this.h(31 & e);
        if (223 < e) return -1 * (255 - e + 1);
        switch (e) {
          case 192: return null;
          case 194: return !1;
          case 195: return !0;
          case 196: n = this.s.getUint8(this.t); this.t += 1; return this.l(n);
          case 197: n = this.s.getUint16(this.t); this.t += 2; return this.l(n);
          case 198: n = this.s.getUint32(this.t); this.t += 4; return this.l(n);
          case 202: t = this.s.getFloat32(this.t); this.t += 4; return t;
          case 203: t = this.s.getFloat64(this.t); this.t += 8; return t;
          case 204: t = this.s.getUint8(this.t); this.t += 1; return t;
          case 205: t = this.s.getUint16(this.t); this.t += 2; return t;
          case 206: t = this.s.getUint32(this.t); this.t += 4; return t;
          case 207: s = this.s.getUint32(this.t) * Math.pow(2, 32); o = this.s.getUint32(this.t + 4); this.t += 8; return s + o;
          case 208: t = this.s.getInt8(this.t); this.t += 1; return t;
          case 209: t = this.s.getInt16(this.t); this.t += 2; return t;
          case 210: t = this.s.getInt32(this.t); this.t += 4; return t;
          case 211: s = this.s.getInt32(this.t) * Math.pow(2, 32); o = this.s.getUint32(this.t + 4); this.t += 8; return s + o;
          case 217: n = this.s.getUint8(this.t); this.t += 1; return this.h(n);
          case 218: n = this.s.getUint16(this.t); this.t += 2; return this.h(n);
          case 219: n = this.s.getUint32(this.t); this.t += 4; return this.h(n);
          case 220: n = this.s.getUint16(this.t); this.t += 2; return this.g(n);
          case 221: n = this.s.getUint32(this.t); this.t += 4; return this.g(n);
          case 222: n = this.s.getUint16(this.t); this.t += 2; this.M(n); break;
          case 223: n = this.s.getUint32(this.t); this.t += 4; this.M(n); break;
        }
        return null;
      };
      let q = (function(t) { let n = new e(t = t.slice(1)), i = n.v(); if (n.t === t.byteLength) return i; return null; })(packet);
      return q?.data?.[1];
    }
    return { encode, decode };
  })();

  class SocketManager extends EventTarget {
    constructor() {
      super();
      this.socket = null;
      this.transportType = "unknown";
      this.blueboatRoomId = null;
      this.playerId = null;
      this.setup();
    }
    setup() {
      const manager = this;
      const shouldTrackSocketUrl = (url) => String(url || "").includes("gimkitconnect.com");
      class NewWebSocket extends WebSocket {
        constructor(url, params) {
          super(url, params);
          if (shouldTrackSocketUrl(url)) manager.registerSocket(this);
        }
        send(data) {
          manager.onSend(data);
          super.send(data);
        }
      }
      const nativeXMLSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function() {
        this.addEventListener("load", () => {
          if (!this.responseURL.endsWith("/matchmaker/join")) return;
          try {
            const response = JSON.parse(this.responseText);
            manager.blueboatRoomId = response.roomId;
          } catch (_) {}
        });
        nativeXMLSend.apply(this, arguments);
      };
      window.WebSocket = NewWebSocket;
      globalThis.socketManager = this;
    }
    registerSocket(socket) {
      this.socket = socket;
      const socketUrl = String(socket?.url || "");
      const looksLikeColyseus = socketUrl.includes("gimkitconnect.com") && !socketUrl.includes("/socket.io/");
      if (window.Phaser || looksLikeColyseus) {
        this.transportType = "colyseus";
        this.addEventListener("colyseusMessage", (e) => {
          if (e.detail.type !== "DEVICES_STATES_CHANGES") return;
          this.dispatchEvent(new CustomEvent("deviceChanges", { detail: parseChangePacket(e.detail.message) }));
        });
      } else {
        this.transportType = "blueboat";
      }
      socket.addEventListener("message", (e) => {
        const firstByte = (() => {
          try {
            return new Uint8Array(e.data)[0];
          } catch (_) {
            return null;
          }
        })();
        if (this.transportType === "unknown" && firstByte != null) {
          if (Object.values(colyseusProtocol).includes(firstByte)) this.transportType = "colyseus";
          else this.transportType = "blueboat";
        }

        let decoded;
        if (this.transportType === "colyseus") {
          decoded = this.decodeColyseus(e);
          if (decoded) {
            this.dispatchEvent(new CustomEvent("colyseusMessage", { detail: decoded }));
            if (decoded.type === "AUTH_ID") {
              this.playerId = decoded.message;
            }
          }
        } else {
          decoded = blueboat.decode(e.data);
          if (decoded) this.dispatchEvent(new CustomEvent("blueboatMessage", { detail: decoded }));
        }
      });
    }
    onSend(data) {
      if (this.transportType === "blueboat" && !this.blueboatRoomId) {
        const decoded = blueboat.decode(data);
        if (decoded?.roomId) this.blueboatRoomId = decoded.roomId;
        if (decoded?.room) this.blueboatRoomId = decoded.room;
      }
    }
    sendMessage(channel, data) {
      if (!this.socket) return;
      if (!this.blueboatRoomId && this.transportType === "blueboat") return;
      let encoded;
      if (this.transportType === "colyseus") {
        const header = new Uint8Array([colyseusProtocol.ROOM_DATA]);
        const channelEncoded = msgpackEncode(channel);
        const packetEncoded = msgpackEncode(data);
        encoded = new Uint8Array(header.length + channelEncoded.byteLength + packetEncoded.byteLength);
        encoded.set(header, 0);
        encoded.set(new Uint8Array(channelEncoded), header.length);
        encoded.set(new Uint8Array(packetEncoded), header.length + channelEncoded.byteLength);
        this.socket.send(encoded);
      } else {
        encoded = blueboat.encode(channel, data, this.blueboatRoomId);
        this.socket.send(encoded);
      }
    }
    decodeColyseus(event) {
      const bytes = new Uint8Array(event.data);
      const code = bytes[0];
      if (code === colyseusProtocol.ROOM_DATA) {
        const first = msgpackDecode(event.data, 1);
        if (!first) return null;
        let message;
        if (bytes.byteLength > first.offset) {
          const second = msgpackDecode(event.data, first.offset);
          message = second?.value;
        }
        return { type: first.value, message };
      }
      return null;
    }
  }

  const socketManager = new SocketManager();

  const DRAWIT_SKIP = new Set(["DRAW_MODE_LD"]);
  const drawItHookedSockets = new WeakSet();
  let drawItHookInstalled = false;

  function bbDecodeDrawItExact(buffer) {
    try {
      const first = new Uint8Array(buffer)[0];
      if (first >= 0x30 && first <= 0x36) return null;
      function BB(buf) {
        this.t = 0;
        this.i = (buf instanceof ArrayBuffer ? buf : buf.buffer).slice(1);
        this.s = new DataView(this.i);
      }
      BB.prototype.str = function(n) {
        let s = "";
        for (let i = this.t, e = this.t + n; i < e; i++) {
          let a = this.s.getUint8(i);
          if (a < 128) s += String.fromCharCode(a);
          else if ((a & 0xe0) === 0xc0) s += String.fromCharCode((a & 0x1f) << 6 | (this.s.getUint8(++i) & 0x3f));
          else if ((a & 0xf0) === 0xe0) s += String.fromCharCode((a & 0x0f) << 12 | (this.s.getUint8(++i) & 0x3f) << 6 | (this.s.getUint8(++i) & 0x3f));
        }
        this.t += n;
        return s;
      };
      BB.prototype.arr = function(n) {
        const a = [];
        for (let i = 0; i < n; i++) a.push(this.p());
        return a;
      };
      BB.prototype.map = function(n) {
        const o = {};
        for (let i = 0; i < n; i++) {
          const k = this.p();
          o[k] = this.p();
        }
        return o;
      };
      BB.prototype.bin = function(n) {
        const v = this.i.slice(this.t, this.t + n);
        this.t += n;
        return v;
      };
      BB.prototype.p = function() {
        if (this.t >= this.s.byteLength) return undefined;
        const b = this.s.getUint8(this.t++);
        if (b < 0x80) return b;
        if (b < 0x90) return this.map(b & 0x0f);
        if (b < 0xa0) return this.arr(b & 0x0f);
        if (b < 0xc0) return this.str(b & 0x1f);
        if (b > 0xdf) return -(0x100 - b);
        switch (b) {
          case 0xc0: return null;
          case 0xc2: return false;
          case 0xc3: return true;
          case 0xc4: { const n = this.s.getUint8(this.t); this.t += 1; return this.bin(n); }
          case 0xca: { const v = this.s.getFloat32(this.t); this.t += 4; return v; }
          case 0xcb: { const v = this.s.getFloat64(this.t); this.t += 8; return v; }
          case 0xcc: { const v = this.s.getUint8(this.t); this.t += 1; return v; }
          case 0xcd: { const v = this.s.getUint16(this.t); this.t += 2; return v; }
          case 0xce: { const v = this.s.getUint32(this.t); this.t += 4; return v; }
          case 0xd0: { const v = this.s.getInt8(this.t); this.t += 1; return v; }
          case 0xd1: { const v = this.s.getInt16(this.t); this.t += 2; return v; }
          case 0xd2: { const v = this.s.getInt32(this.t); this.t += 4; return v; }
          case 0xd9: { const n = this.s.getUint8(this.t); this.t += 1; return this.str(n); }
          case 0xda: { const n = this.s.getUint16(this.t); this.t += 2; return this.str(n); }
          case 0xdc: { const n = this.s.getUint16(this.t); this.t += 2; return this.arr(n); }
          case 0xdd: { const n = this.s.getUint32(this.t); this.t += 4; return this.arr(n); }
          case 0xde: { const n = this.s.getUint16(this.t); this.t += 2; return this.map(n); }
          case 0xdf: { const n = this.s.getUint32(this.t); this.t += 4; return this.map(n); }
          default: return `<0x${b.toString(16)}>`;
        }
      };
      const parsed = new BB(buffer).p();
      if (Array.isArray(parsed?.data)) {
        const inner = parsed.data[1];
        return { key: inner?.key ?? parsed.data[0], data: inner?.data ?? inner };
      }
      return parsed ?? null;
    } catch (_) {
      return null;
    }
  }

  function logAnswerCandidatesDrawItExact(stateUpdateData) {
    const rows = Array.isArray(stateUpdateData) ? stateUpdateData : [stateUpdateData];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if (!Array.isArray(row.value)) continue;
      for (const item of row.value) {
        const directKey = item?.key;
        const nestedKey = item?.value?.key;
        const fieldKey = directKey ?? nestedKey;
        const directValue = item?.value;
        const nestedValue = item?.value?.value;
        const fieldValue = typeof nestedValue === "undefined" ? directValue : nestedValue;
        if (!fieldKey) continue;
        if (fieldKey !== "term") continue;
        if (typeof fieldValue !== "string") continue;
        const answer = fieldValue.trim();
        if (!answer) continue;
        console.log(answer);
        applyDrawItAnswerReveal(answer);
        if (answerPopupState.enabled) showAnswerPopup(answer);
      }
    }
  }

  function hookSocketDrawIt(ws) {
    if (drawItHookedSockets.has(ws)) return;
    drawItHookedSockets.add(ws);
    ws.addEventListener("message", (e) => {
      const decoded = bbDecodeDrawItExact(e.data);
      if (!decoded?.key) return;
      const key = decoded.key;
      if (DRAWIT_SKIP.has(key)) return;
      if (key === "STATE_UPDATE") logAnswerCandidatesDrawItExact(decoded.data);
    });
  }

  function installDrawItAnswerHook() {
    if (drawItHookInstalled) return;
    drawItHookInstalled = true;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (!this.url?.startsWith("ws://localhost")) hookSocketDrawIt(this);
      originalSend.call(this, data);
    };
  }
  installDrawItAnswerHook();

  const autoAnswerState = {
    questions: [],
    answerDeviceId: null,
    currentQuestionId: null,
    questionIdList: [],
    currentQuestionIndex: -1,
  };
  const AUTO_ANSWER_TICK = 1000;
  let autoAnswerEnabled = false;
  let answerInterval = null;

  function answerQuestion() {
    if (socketManager.transportType === "colyseus") {
      if (autoAnswerState.currentQuestionId == null || autoAnswerState.answerDeviceId == null) return;
      const question = autoAnswerState.questions.find((q) => q._id == autoAnswerState.currentQuestionId);
      if (!question) return;
      const packet = { key: "answered", deviceId: autoAnswerState.answerDeviceId, data: {} };
      if (question.type == "text") packet.data.answer = question.answers[0].text;
      else packet.data.answer = question.answers.find((a) => a.correct)?._id;
      if (!packet.data.answer) return;
      socketManager.sendMessage("MESSAGE_FOR_DEVICE", packet);
    } else {
      const questionId = autoAnswerState.questionIdList[autoAnswerState.currentQuestionIndex];
      const question = autoAnswerState.questions.find((q) => q._id == questionId);
      if (!question) return;
      const answer = question.type == "mc" ? question.answers.find((a) => a.correct)?._id : question.answers[0]?.text;
      if (!answer) return;
      socketManager.sendMessage("QUESTION_ANSWERED", { answer, questionId });
    }
  }

  const autoAnswerModule = new Module("Auto Answer", {
    onEnable: () => {
      console.log("Auto Answer enabled");
      autoAnswerEnabled = true;
    },
    onDisable: () => {
      console.log("Auto Answer disabled");
      autoAnswerEnabled = false;
    },
  });

  socketManager.addEventListener("deviceChanges", event => {
    for (const { id, data } of event.detail || []) {
      for (const key in data || {}) {
        if (key === "GLOBAL_questions") {
          autoAnswerState.questions = JSON.parse(data[key]);
          autoAnswerState.answerDeviceId = id;
        }
        if (key === `PLAYER_${socketManager.playerId}_currentQuestionId`) {
          autoAnswerState.currentQuestionId = data[key];
        }
      }
    }
  });

  socketManager.addEventListener("blueboatMessage", event => {
    if (event.detail?.key !== "STATE_UPDATE") return;

    switch (event.detail.data.type) {
      case "GAME_QUESTIONS":
        autoAnswerState.questions = event.detail.data.value;
        break;
      case "PLAYER_QUESTION_LIST":
        autoAnswerState.questionIdList = event.detail.data.value.questionList;
        autoAnswerState.currentQuestionIndex = event.detail.data.value.questionIndex;
        break;
      case "PLAYER_QUESTION_LIST_INDEX":
        autoAnswerState.currentQuestionIndex = event.detail.data.value;
        break;
    }
  });

  socketManager.addEventListener("blueboatMessage", (event) => {
    if (event.detail?.key !== "STATE_UPDATE") return;
    const answers = extractDrawItAnswerCandidates(event.detail.data);
    if (!answers.length) return;
    const latestAnswer = answers[answers.length - 1];
    applyDrawItAnswerReveal(latestAnswer);
    if (answerPopupState.enabled) showAnswerPopup(latestAnswer);
  });

  answerInterval = setInterval(() => {
    if (!autoAnswerEnabled) return;
    answerQuestion();
  }, AUTO_ANSWER_TICK);

  const ESP_LOG = "[ESP]";
  const espState = {
    enabled: false,
    canvas: null,
    ctx: null,
    intervalId: null,
    stores: null,
    storesPromise: null,
    seenPlayers: new Map(),
    waitLogTick: 0,
  };

  function espLog(message, extra) {
    if (extra !== undefined) console.log(`${ESP_LOG} ${message}`, extra);
    else console.log(`${ESP_LOG} ${message}`);
  }

  function createEspCanvas() {
    if (espState.canvas?.parentNode) {
      espLog("Canvas already exists; reusing existing canvas.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.position = "fixed";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";
    canvas.style.zIndex = "9999";
    canvas.style.pointerEvents = "none";
    canvas.style.userSelect = "none";
    document.body.appendChild(canvas);
    espState.canvas = canvas;
    espState.ctx = canvas.getContext("2d");
    if (!espState.ctx) {
      espLog("Failed to get canvas 2D context");
      canvas.remove();
      espState.canvas = null;
      return;
    }
    espLog("Canvas created");
  }

  function destroyEspCanvas() {
    if (!espState.canvas) return;
    espState.canvas.remove();
    espState.canvas = null;
    espState.ctx = null;
    espLog("Canvas destroyed");
  }

  function resizeEspCanvas() {
    if (!espState.canvas?.parentNode) return;
    espState.canvas.width = window.innerWidth;
    espState.canvas.height = window.innerHeight;
    espLog(`Canvas resized to ${espState.canvas.width}x${espState.canvas.height}`);
  }

  async function resolveEspStores() {
    if (espState.stores) return espState.stores;
    if (espState.storesPromise) return espState.storesPromise;
    espState.storesPromise = (async () => {
      if (!document.body) {
        await new Promise((resolve) => window.addEventListener("DOMContentLoaded", resolve, { once: true }));
      }
      const moduleScript = document.querySelector("script[src][type='module']");
      if (!moduleScript?.src) throw new Error("Failed to find game module script");

      const response = await fetch(moduleScript.src);
      const text = await response.text();
      const gameScriptUrl = text.match(/FixSpinePlugin-[^.]+\.js/)?.[0];
      if (!gameScriptUrl) throw new Error("Failed to find game script URL");

      const gameScript = await import(`/assets/${gameScriptUrl}`);
      const stores = Object.values(gameScript).find((value) => value && value.assignment);
      if (!stores) throw new Error("Failed to resolve stores export");

      window.stores = stores;
      espState.stores = stores;
      espLog("Resolved stores via module import");
      return stores;
    })();
    try {
      return await espState.storesPromise;
    } finally {
      espState.storesPromise = null;
    }
  }

  function primeSharedPlayerData() {
    if (espState.stores || espState.storesPromise) return;
    const attemptResolve = () => {
      resolveEspStores().catch((error) => {
        espLog("Shared stores resolve failed; retrying", error);
        setTimeout(() => {
          if (!espState.stores) attemptResolve();
        }, 1500);
      });
    };
    attemptResolve();
  }

  primeSharedPlayerData();

  function getCharacterPosition(character) {
    const x = Number(character?.x ?? character?.position?.x ?? character?.body?.x);
    const y = Number(character?.y ?? character?.position?.y ?? character?.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function getCharacters(stores) {
    const manager = stores?.phaser?.scene?.characterManager;
    const map = manager?.characters;
    if (!map) return [];
    if (typeof map.values === "function") return Array.from(map.values());
    if (Array.isArray(map)) return map;
    return Object.values(map);
  }

  function getCharacterEntries(stores) {
    const manager = stores?.phaser?.scene?.characterManager;
    const map = manager?.characters;
    if (!map) return [];
    if (typeof map.entries === "function") {
      return Array.from(map.entries(), ([id, character]) => ({ id, character }));
    }
    if (Array.isArray(map)) {
      return map.map((character, index) => ({ id: character?.id ?? character?.characterId ?? index, character }));
    }
    return Object.entries(map).map(([id, character]) => ({ id, character }));
  }

  function getMainCharacter(stores) {
    const mainId = stores?.phaser?.mainCharacter?.id;
    const manager = stores?.phaser?.scene?.characterManager;
    const map = manager?.characters;
    if (!map) return null;
    if (mainId != null && typeof map.get === "function") return map.get(mainId) || null;
    return getCharacters(stores).find((character) => character?.id === mainId || character?.characterId === mainId) || null;
  }

  function getCharacterTeam(character) {
    return character?.teamId ?? character?.team?.id ?? character?.state?.teamId ?? character?.data?.teamId ?? null;
  }

  function getCharacterId(character) {
    return character?.id ?? character?.characterId ?? character?.playerId ?? character?.entityId ?? null;
  }

  function getSerializerCharacterById(id) {
    if (id == null) return null;
    const map = window?.serializer?.state?.characters?.$items;
    if (!map || typeof map.get !== "function") return null;
    return map.get(id) || map.get(String(id)) || null;
  }

  function findSerializerCharacterByPosition(character) {
    const map = window?.serializer?.state?.characters?.$items;
    if (!map || typeof map.values !== "function") return null;
    const x = Number(character?.x ?? character?.position?.x);
    const y = Number(character?.y ?? character?.position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const candidate of map.values()) {
      const cx = Number(candidate?.x ?? candidate?.position?.x);
      const cy = Number(candidate?.y ?? candidate?.position?.y);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      if (Math.abs(cx - x) < 0.5 && Math.abs(cy - y) < 0.5) return candidate;
    }
    return null;
  }

  function getCharacterName(character, fallbackId = null) {
    const id = getCharacterId(character) ?? fallbackId;
    const serializerCharacter = getSerializerCharacterById(id) ?? findSerializerCharacterByPosition(character);
    return character?.name
      ?? character?.nametag?.name
      ?? character?.displayName
      ?? character?.state?.name
      ?? character?.state?.nametag?.name
      ?? character?.username
      ?? character?.playerName
      ?? character?.profile?.name
      ?? character?.meta?.name
      ?? character?.data?.name
      ?? character?.data?.nametag?.name
      ?? serializerCharacter?.name
      ?? serializerCharacter?.nametag?.name
      ?? serializerCharacter?.displayName
      ?? serializerCharacter?.username
      ?? "Player";
  }

  function formatEspLabel(playerName, distance, namesDistanceOnly, style) {
    const safeName = String(playerName || "Player");
    const distanceText = `${Math.floor(Number(distance) || 0)}m`;
    const showName = namesDistanceOnly?.showName !== undefined ? namesDistanceOnly.showName : true;
    const showDistance = namesDistanceOnly?.showDistance !== undefined ? namesDistanceOnly.showDistance : true;
    if (!showName && !showDistance) return "";
    if (showName && !showDistance) return safeName;
    if (!showName && showDistance) return distanceText;
    switch (style) {
      case "dash":
        return `${safeName} - ${distanceText}`;
      case "pipe":
        return `${safeName} | ${distanceText}`;
      case "distanceFirst":
        return `${distanceText} • ${safeName}`;
      case "paren":
        return `${safeName} (${distanceText})`;
      case "dot":
      default:
        return `${safeName} • ${distanceText}`;
    }
  }

  function resolveNameDistanceVisibility(cfg, isTeammate) {
    const nameKey = isTeammate ? "teammateNameTextEnabled" : "nameTextEnabled";
    const distanceKey = isTeammate ? "teammateDistanceTextEnabled" : "distanceTextEnabled";
    const explicitName = cfg?.[nameKey];
    const explicitDistance = cfg?.[distanceKey];
    if (typeof explicitName === "boolean" || typeof explicitDistance === "boolean") {
      return {
        showName: explicitName !== false,
        showDistance: explicitDistance !== false,
      };
    }
    const legacyNamesEnabled = isTeammate ? (cfg?.teammateNames !== false) : (cfg?.names !== false);
    const legacyDistanceOnly = isTeammate ? (cfg?.teammateNamesDistanceOnly === true) : (cfg?.namesDistanceOnly === true);
    if (!legacyNamesEnabled) return { showName: false, showDistance: false };
    if (legacyDistanceOnly) return { showName: false, showDistance: true };
    return { showName: true, showDistance: true };
  }

  function projectWorldToScreen(position, cameraSnapshot, viewportWidth, viewportHeight) {
    const x = Number(position?.x);
    const y = Number(position?.y);
    const camX = Number(cameraSnapshot?.midX);
    const camY = Number(cameraSnapshot?.midY);
    const zoom = Number(cameraSnapshot?.zoom ?? 1) || 1;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(camX) || !Number.isFinite(camY)) return null;
    return {
      x: (x - camX) * zoom + viewportWidth / 2,
      y: (y - camY) * zoom + viewportHeight / 2,
      zoom,
    };
  }

  function getEspRenderConfig() {
    const defaults = {
      showEnemies: true,
      showTeammates: true,
      hitbox: true,
      hitboxSize: 150,
      hitboxWidth: 3,
      hitboxColor: "#ff4444",
      teammateHitbox: true,
      teammateHitboxSize: 150,
      teammateHitboxWidth: 3,
      teammateHitboxColor: "#36d17c",
      names: true,
      namesDistanceOnly: false,
      nameTextEnabled: true,
      distanceTextEnabled: true,
      nameSize: 22,
      nameColor: "#7a0c0c",
      nameOutline: true,
      nameOutlineColor: "#000000",
      nameOutlineWidth: 1,
      nameDistanceStyle: "dot",
      teammateNames: true,
      teammateNamesDistanceOnly: false,
      teammateNameTextEnabled: true,
      teammateDistanceTextEnabled: true,
      teammateNameSize: 22,
      teammateNameColor: "#baf7d2",
      teammateNameOutline: true,
      teammateNameOutlineColor: "#ffffff",
      teammateNameOutlineWidth: 1,
      teammateNameDistanceStyle: "dot",
      offscreenStyle: "tracers",
      offscreenTheme: "classic",
      alwaysTracer: false,
      tracerWidth: 3,
      tracerColor: "#ff4444",
      teammateOffscreenStyle: "tracers",
      teammateOffscreenTheme: "classic",
      teammateAlwaysTracer: false,
      teammateTracerWidth: 3,
      teammateTracerColor: "#36d17c",
      arrowSize: 14,
      arrowColor: "#ff4444",
      teammateArrowSize: 14,
      teammateArrowColor: "#36d17c",
      arrowStyle: "regular",
      teammateArrowStyle: "regular",
      valueTextColor: window.__zyroxEspValueTextColor || "#ffffff",
    };
    const liveCfg = window.__zyroxEspConfig;
    if (liveCfg && typeof liveCfg === "object") return { ...defaults, ...liveCfg };
    return defaults;
  }

  function getHealthBarsConfig() {
    const defaults = {
      enabled: true,
      width: 54,
      height: 6,
      yOffset: 32,
      showText: true,
    };
    const liveCfg = window.__zyroxHealthBarsConfig;
    return liveCfg && typeof liveCfg === "object" ? { ...defaults, ...liveCfg } : defaults;
  }

  function readNumericCandidate(source, paths) {
    if (!source) return null;
    for (const path of paths) {
      const parts = path.split(".");
      let node = source;
      for (const part of parts) node = node?.[part];
      const value = Number(node);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function getCharacterHealthSnapshot(character, fallbackId = null) {
    const cid = getCharacterId(character) ?? fallbackId;
    const serializerCharacter = getSerializerCharacterById(cid) ?? findSerializerCharacterByPosition(character);
    const candidates = [character, serializerCharacter];
    let current = null;
    let max = null;
    for (const source of candidates) {
      if (!source) continue;
      if (current == null) {
        current = readNumericCandidate(source, ["health", "hp", "currentHealth", "state.health", "stats.health", "data.health"]);
      }
      if (max == null) {
        max = readNumericCandidate(source, ["maxHealth", "maxHp", "healthMax", "state.maxHealth", "stats.maxHealth", "data.maxHealth"]);
      }
      if (current != null && max != null) break;
    }
    if (current == null) return null;
    if (max == null || max <= 0) {
      if (current <= 100) max = 100;
      else return null;
    }
    return { current: Math.max(0, current), max: Math.max(1, max) };
  }

  function renderEspPlayers(stores) {
    const ctx = espState.ctx;
    const canvas = espState.canvas;
    if (!ctx || !canvas) {
      espLog("Missing data: no canvas/context; rendering skip.");
      return;
    }
    const camera = stores?.phaser?.scene?.cameras?.cameras?.[0];
    const me = getMainCharacter(stores);
    if (!camera || !me) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const myTeam = getCharacterTeam(me);
    const espCfg = getEspRenderConfig();
    const healthCfg = getHealthBarsConfig();
    const showHealthBars = state.enabledModules?.has("Health Bars") && healthCfg.enabled !== false;
    const camX = Number(camera?.midPoint?.x);
    const camY = Number(camera?.midPoint?.y);
    const zoom = Number(camera?.zoom ?? 1) || 1;
    if (!Number.isFinite(camX) || !Number.isFinite(camY)) return;

    const activeIds = new Set();
    const now = performance.now();

    for (const entry of getCharacterEntries(stores)) {
      const character = entry.character;
      const characterId = entry.id ?? getCharacterId(character);
      if (!character || character === me) continue;
      const pos = getCharacterPosition(character);
      if (!pos) continue;
      const stableId = String(characterId ?? `${Math.round(pos.x)}:${Math.round(pos.y)}`);
      activeIds.add(stableId);
      const angle = Math.atan2(pos.y - camY, pos.x - camX);
      const distance = Math.hypot(pos.x - camX, pos.y - camY) * zoom;
      const rawX = (pos.x - camX) * zoom + canvas.width / 2;
      const rawY = (pos.y - camY) * zoom + canvas.height / 2;
      const prev = espState.seenPlayers.get(stableId);
      let screenX = rawX;
      let screenY = rawY;
      if (prev) {
        const delta = Math.hypot(rawX - prev.x, rawY - prev.y);
        if (delta < 300) {
          const blend = 0.38;
          screenX = prev.x + (rawX - prev.x) * blend;
          screenY = prev.y + (rawY - prev.y) * blend;
        }
      }
      espState.seenPlayers.set(stableId, { x: screenX, y: screenY, t: now });
      const onScreen = screenX >= 0 && screenX <= canvas.width && screenY >= 0 && screenY <= canvas.height;
      const isTeammate = myTeam !== null && getCharacterTeam(character) === myTeam;
      if (isTeammate && espCfg.showTeammates === false) continue;
      if (!isTeammate && espCfg.showEnemies === false) continue;
      const showHitbox = isTeammate ? espCfg.teammateHitbox !== false : espCfg.hitbox !== false;
      const nameDistanceVisibility = resolveNameDistanceVisibility(espCfg, isTeammate);
      const chosenDistanceStyle = isTeammate ? espCfg.teammateNameDistanceStyle : espCfg.nameDistanceStyle;
      const distanceStyle = ["dot", "dash", "pipe", "paren", "distanceFirst"].includes(chosenDistanceStyle)
        ? chosenDistanceStyle
        : "dot";
      const chosenOffscreenStyle = isTeammate ? espCfg.teammateOffscreenStyle : espCfg.offscreenStyle;
      const offscreenStyle = chosenOffscreenStyle === "arrows" || chosenOffscreenStyle === "none"
        ? chosenOffscreenStyle
        : "tracers";
      const offscreenTheme = String(isTeammate ? espCfg.teammateOffscreenTheme : espCfg.offscreenTheme || "classic");
      const alwaysTracer = isTeammate ? espCfg.teammateAlwaysTracer === true : espCfg.alwaysTracer === true;
      const chosenArrowStyle = isTeammate ? espCfg.teammateArrowStyle : espCfg.arrowStyle;
      const arrowStyle = ["regular", "dot", "modern"].includes(chosenArrowStyle) ? chosenArrowStyle : "regular";
      const hitboxColor = isTeammate
        ? (espCfg.teammateHitboxColor || espCfg.hitboxColor || "green")
        : (espCfg.hitboxColor || "red");
      const tracerColor = isTeammate
        ? (espCfg.teammateTracerColor || espCfg.tracerColor || "green")
        : (espCfg.tracerColor || "red");
      const arrowColor = isTeammate
        ? (espCfg.teammateArrowColor || espCfg.arrowColor || "green")
        : (espCfg.arrowColor || "red");
      const nameColor = isTeammate
        ? (espCfg.teammateNameColor || espCfg.nameColor || "#000000")
        : (espCfg.nameColor || "#000000");
      const nameOutlineEnabled = isTeammate ? espCfg.teammateNameOutline !== false : espCfg.nameOutline !== false;
      const nameOutlineColor = isTeammate
        ? (espCfg.teammateNameOutlineColor || espCfg.nameOutlineColor || "#000000")
        : (espCfg.nameOutlineColor || "#000000");
      const hitboxSize = Math.max(12, Number(isTeammate ? espCfg.teammateHitboxSize : espCfg.hitboxSize) || 80);
      const hitboxWidth = Math.max(1, Number(isTeammate ? espCfg.teammateHitboxWidth : espCfg.hitboxWidth) || 3);
      const nameSize = Math.max(8, Number(isTeammate ? espCfg.teammateNameSize : espCfg.nameSize) || 20);
      const nameOutlineWidth = Math.max(1, Number(isTeammate ? espCfg.teammateNameOutlineWidth : espCfg.nameOutlineWidth) || 3);
      const tracerWidth = Math.max(1, Number(isTeammate ? espCfg.teammateTracerWidth : espCfg.tracerWidth) || 3);
      const arrowSize = Math.max(6, Number(isTeammate ? espCfg.teammateArrowSize : espCfg.arrowSize) || 14);

      if (onScreen && showHitbox) {
        const boxSize = Math.max(24, hitboxSize / zoom);
        ctx.beginPath();
        ctx.lineWidth = hitboxWidth;
        ctx.strokeStyle = hitboxColor;
        ctx.strokeRect(screenX - boxSize / 2, screenY - boxSize / 2, boxSize, boxSize);
      }

      const shouldDrawOffscreen = !onScreen && offscreenStyle !== "none";
      const shouldDrawTracer = offscreenStyle === "tracers" && (alwaysTracer || !onScreen);

      let labelX = onScreen ? screenX : Math.cos(angle) * Math.min(250, distance) + canvas.width / 2;
      let labelY = onScreen ? (screenY - 18) : Math.sin(angle) * Math.min(250, distance) + canvas.height / 2;

      if (shouldDrawOffscreen || shouldDrawTracer) {
        const margin = 20;
        const halfW = canvas.width / 2 - margin;
        const halfH = canvas.height / 2 - margin;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const scale = Math.min(
          Math.abs(halfW / (dx || 0.0001)),
          Math.abs(halfH / (dy || 0.0001))
        );
        const endX = canvas.width / 2 + dx * scale;
        const endY = canvas.height / 2 + dy * scale;

        if (shouldDrawTracer) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(canvas.width / 2, canvas.height / 2);
          ctx.lineTo(onScreen ? screenX : endX, onScreen ? screenY : endY);
          ctx.lineWidth = tracerWidth;
          ctx.strokeStyle = tracerColor;
          if (offscreenTheme === "dashed") ctx.setLineDash([8, 6]);
          if (offscreenTheme === "neon") {
            ctx.shadowColor = tracerColor;
            ctx.shadowBlur = 10;
          }
          ctx.stroke();
          ctx.restore();
        } else if (offscreenStyle === "arrows" && !onScreen) {
          const headLength = arrowSize;
          const headAngle = Math.PI / 6;
          const a1 = angle - headAngle;
          const a2 = angle + headAngle;
          ctx.save();
          ctx.beginPath();
          if (arrowStyle === "dot") {
            ctx.arc(endX, endY, Math.max(4, headLength * 0.35), 0, Math.PI * 2);
            ctx.fillStyle = arrowColor;
          } else if (arrowStyle === "modern") {
            const tailX = endX - Math.cos(angle) * headLength;
            const tailY = endY - Math.sin(angle) * headLength;
            const perpX = Math.cos(angle + Math.PI / 2) * (headLength * 0.45);
            const perpY = Math.sin(angle + Math.PI / 2) * (headLength * 0.45);
            ctx.moveTo(endX, endY);
            ctx.quadraticCurveTo(tailX + perpX, tailY + perpY, tailX, tailY);
            ctx.quadraticCurveTo(tailX - perpX, tailY - perpY, endX, endY);
            ctx.fillStyle = arrowColor;
          } else {
            ctx.moveTo(endX, endY);
            ctx.lineTo(endX - Math.cos(a1) * headLength, endY - Math.sin(a1) * headLength);
            ctx.moveTo(endX, endY);
            ctx.lineTo(endX - Math.cos(a2) * headLength, endY - Math.sin(a2) * headLength);
          }
          ctx.lineWidth = tracerWidth;
          ctx.strokeStyle = arrowColor;
          if (offscreenTheme === "dashed") ctx.setLineDash([6, 5]);
          if (offscreenTheme === "neon") {
            ctx.shadowColor = arrowColor;
            ctx.shadowBlur = 10;
          }
          if (arrowStyle === "dot" || arrowStyle === "modern") ctx.fill();
          else ctx.stroke();
          ctx.restore();
          labelX = endX;
          labelY = endY - Math.max(16, headLength * 1.2);
        }
      }

      if (!nameDistanceVisibility.showName && !nameDistanceVisibility.showDistance) continue;
      ctx.fillStyle = nameColor;
      ctx.font = `${nameSize}px ${espCfg.font || "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const labelText = formatEspLabel(getCharacterName(character, characterId), distance, nameDistanceVisibility, distanceStyle);
      const textWidth = Math.max(1, ctx.measureText(labelText).width);
      const pad = Math.max(8, nameSize * 0.35);
      const halfText = textWidth / 2;
      const drawX = Math.min(canvas.width - halfText - pad, Math.max(halfText + pad, labelX));
      const drawY = Math.min(canvas.height - nameSize - pad, Math.max(nameSize * 0.7 + pad, labelY));
      if (nameOutlineEnabled) {
        ctx.lineWidth = nameOutlineWidth;
        ctx.strokeStyle = nameOutlineColor;
        ctx.lineJoin = "round";
        ctx.strokeText(labelText, drawX, drawY);
      }
      ctx.fillText(labelText, drawX, drawY);

    }

    for (const [id, data] of espState.seenPlayers) {
      if (!activeIds.has(id) && now - Number(data?.t ?? 0) > 900) {
        espState.seenPlayers.delete(id);
      }
    }
  }

  function renderEspTick() {
    if (!espState.enabled || !espState.ctx || !espState.canvas) return;
    const stores = espState.stores ?? window.stores;
    if (!stores) {
      espState.waitLogTick += 1;
      if (espState.waitLogTick % 60 === 0) espLog("Waiting for stores...");
      espState.ctx.clearRect(0, 0, espState.canvas.width, espState.canvas.height);
      return;
    }
    espState.waitLogTick = 0;
    renderEspPlayers(stores);
  }

  function startEsp() {
    if (espState.enabled) {
      espLog("ESP already enabled; skipping duplicate start.");
      return;
    }
    espState.enabled = true;
    espLog("ESP initialized");
    createEspCanvas();
    resizeEspCanvas();
    resolveEspStores().catch((error) => espLog("Failed to resolve stores", error));
    if (espState.intervalId != null) {
      clearInterval(espState.intervalId);
      espState.intervalId = null;
    }
    espState.intervalId = setInterval(renderEspTick, 1000 / 30);
  }

  function stopEsp() {
    if (!espState.enabled) {
      espLog("ESP already disabled; skipping duplicate stop.");
      return;
    }
    espState.enabled = false;
    if (espState.intervalId != null) {
      clearInterval(espState.intervalId);
      espState.intervalId = null;
    }
    espState.seenPlayers.clear();
    destroyEspCanvas();
    espLog("ESP stopped and cleaned up");
  }

  window.addEventListener("resize", resizeEspCanvas);

  // ---------------------------------------------------------------------------
  // CROSSHAIR MODULE
  // Renders a crosshair at the mouse cursor position and optionally a line
  // from the center of the screen to the cursor.
  // ---------------------------------------------------------------------------
  const crosshairState = {
    enabled: false,
    canvas: null,
    ctx: null,
    mouseX: 0,
    mouseY: 0,
    rafId: null,
  };

  function getCrosshairConfig() {
    const defaults = {
      enabled: true,
      style: "x",
      color: "#ff3b3b",
      crosshairSize: 25,
      lineSize: 4,
      showLine: false,
      lineColor: "#ff3b3b",
      tracerLineSize: 1.5,
      hoverHighlight: true,
      hoverColor: "#ffff00",
    };
    const stored = window.__zyroxCrosshairConfig;
    return stored && typeof stored === "object" ? { ...defaults, ...stored } : defaults;
  }

  function createCrosshairCanvas() {
    if (crosshairState.canvas?.parentNode) return;
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:10000;pointer-events:none;user-select:none;";
    document.body.appendChild(canvas);
    crosshairState.canvas = canvas;
    crosshairState.ctx = canvas.getContext("2d");
  }

  function destroyCrosshairCanvas() {
    if (crosshairState.rafId != null) { cancelAnimationFrame(crosshairState.rafId); crosshairState.rafId = null; }
    crosshairState.canvas?.remove();
    crosshairState.canvas = null;
    crosshairState.ctx = null;
  }

  function resizeCrosshairCanvas() {
    if (!crosshairState.canvas) return;
    crosshairState.canvas.width = window.innerWidth;
    crosshairState.canvas.height = window.innerHeight;
  }

  function renderCrosshairFrame() {
    if (!crosshairState.enabled) return;
    crosshairState.rafId = requestAnimationFrame(renderCrosshairFrame);
    const ctx = crosshairState.ctx;
    const canvas = crosshairState.canvas;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cfg = getCrosshairConfig();
    if (!cfg.enabled) return;

    const mx = crosshairState.mouseX;
    const my = crosshairState.mouseY;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    const crosshairSize = typeof cfg.crosshairSize === "number" ? cfg.crosshairSize : 25;
    const lineSize      = typeof cfg.lineSize      === "number" ? cfg.lineSize      : 4;
    const tracerSize    = typeof cfg.tracerLineSize === "number" ? cfg.tracerLineSize : 1.5;

    // --- Player hover detection ---
    let hoveringPlayer = false;
    if (cfg.hoverHighlight) {
      try {
        const stores = espState.stores ?? window.stores ?? null;
        const camera = stores?.phaser?.scene?.cameras?.cameras?.[0];
        const me = stores ? getMainCharacter(stores) : null;
        if (camera && me) {
          const camX = Number(camera?.midPoint?.x);
          const camY = Number(camera?.midPoint?.y);
          const zoom = Number(camera?.zoom ?? 1) || 1;
          const hitRadius = (Math.max(20, 120 / zoom) / 2) * 3;
          if (Number.isFinite(camX) && Number.isFinite(camY)) {
            for (const { character } of getCharacterEntries(stores)) {
              if (!character || character === me) continue;
              const pos = getCharacterPosition(character);
              if (!pos) continue;
              const sx = (pos.x - camX) * zoom + canvas.width / 2;
              const sy = (pos.y - camY) * zoom + canvas.height / 2;
              if (Math.hypot(mx - sx, my - sy) <= hitRadius) {
                hoveringPlayer = true;
                break;
              }
            }
          }
        }
      } catch (_) { /* stores not ready yet */ }
    }

    const col = hoveringPlayer ? (cfg.hoverColor || "#ffff00") : (cfg.color || "#ff3b3b");

    // Draw line from center to cursor if enabled
    if (cfg.showLine) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(mx, my);
      ctx.lineWidth = tracerSize;
      ctx.strokeStyle = cfg.lineColor || "#ff3b3b";
      ctx.globalAlpha = 0.65;
      ctx.stroke();
      ctx.restore();
    }

    // Draw crosshair at cursor
    ctx.save();
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = lineSize;
    ctx.globalAlpha = 0.92;
    const style = cfg.style || "cross";

    if (style === "dot") {
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(1, crosshairSize * 0.35), 0, Math.PI * 2);
      ctx.fill();
    } else if (style === "solid") {
      // Solid cross — lines go straight through the center with no gap
      const arm = crosshairSize;
      ctx.beginPath();
      ctx.moveTo(mx - arm, my); ctx.lineTo(mx + arm, my);
      ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my + arm);
      ctx.stroke();
    } else if (style === "crossdot") {
      // Cross with gap + filled center dot
      const arm = crosshairSize;
      const gap = Math.max(1, crosshairSize * 0.4);
      ctx.beginPath();
      ctx.moveTo(mx - arm, my); ctx.lineTo(mx - gap, my);
      ctx.moveTo(mx + gap, my); ctx.lineTo(mx + arm, my);
      ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my - gap);
      ctx.moveTo(mx, my + gap); ctx.lineTo(mx, my + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(1.5, lineSize * 1.2), 0, Math.PI * 2);
      ctx.fill();
    } else if (style === "circle") {
      ctx.beginPath();
      ctx.arc(mx, my, crosshairSize, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(1, crosshairSize * 0.2), 0, Math.PI * 2);
      ctx.fill();
    } else if (style === "circlecross") {
      // Circle with solid cross lines through the center
      ctx.beginPath();
      ctx.arc(mx, my, crosshairSize, 0, Math.PI * 2);
      ctx.stroke();
      const arm = crosshairSize;
      ctx.beginPath();
      ctx.moveTo(mx - arm, my); ctx.lineTo(mx + arm, my);
      ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my + arm);
      ctx.stroke();
    } else if (style === "plus") {
      // Thick plus sign
      ctx.lineWidth = lineSize * 1.5;
      const arm = crosshairSize;
      const gap = Math.max(1, crosshairSize * 0.3);
      ctx.beginPath();
      ctx.moveTo(mx - arm, my); ctx.lineTo(mx - gap, my);
      ctx.moveTo(mx + gap, my); ctx.lineTo(mx + arm, my);
      ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my - gap);
      ctx.moveTo(mx, my + gap); ctx.lineTo(mx, my + arm);
      ctx.stroke();
    } else if (style === "x") {
      // Diagonal X crosshair
      const arm = crosshairSize * 0.75;
      const gap = Math.max(1, crosshairSize * 0.28);
      ctx.beginPath();
      ctx.moveTo(mx - arm, my - arm); ctx.lineTo(mx - gap, my - gap);
      ctx.moveTo(mx + gap, my + gap); ctx.lineTo(mx + arm, my + arm);
      ctx.moveTo(mx + arm, my - arm); ctx.lineTo(mx + gap, my - gap);
      ctx.moveTo(mx - gap, my + gap); ctx.lineTo(mx - arm, my + arm);
      ctx.stroke();
    } else {
      // Default "cross" — thin with center gap
      const arm = crosshairSize;
      const gap = Math.max(1, crosshairSize * 0.4);
      ctx.beginPath();
      ctx.moveTo(mx - arm, my); ctx.lineTo(mx - gap, my);
      ctx.moveTo(mx + gap, my); ctx.lineTo(mx + arm, my);
      ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my - gap);
      ctx.moveTo(mx, my + gap); ctx.lineTo(mx, my + arm);
      ctx.stroke();
    }
    ctx.restore();
  }

  function startCrosshair() {
    if (crosshairState.enabled) return;
    primeSharedPlayerData();
    crosshairState.enabled = true;
    createCrosshairCanvas();
    renderCrosshairFrame();
  }

  function stopCrosshair() {
    if (!crosshairState.enabled) return;
    crosshairState.enabled = false;
    destroyCrosshairCanvas();
  }

  document.addEventListener("mousemove", (e) => {
    const dx = e.clientX - crosshairState.mouseX;
    const dy = e.clientY - crosshairState.mouseY;
    const len = Math.hypot(dx, dy);
    if (len > 0.0001) {
      autoAimState.aimDirX = dx / len;
      autoAimState.aimDirY = dy / len;
    }
    crosshairState.mouseX = e.clientX;
    crosshairState.mouseY = e.clientY;
  }, { passive: true });

  window.addEventListener("resize", resizeCrosshairCanvas);

  // ---------------------------------------------------------------------------
  // TRIGGER ASSIST MODULE
  // Uses shared ESP bridge data and cursor position to trigger fire when
  // player targets are within a configurable cursor radius.
  // ---------------------------------------------------------------------------
  const triggerAssistState = {
    enabled: false,
    loopId: null,
    canvas: null,
    ctx: null,
    lastFireAt: 0,
    mouseHeld: false,
    releaseTimeoutId: null,
    target: null,
    statusText: "Idle",
  };

  const autoAimState = {
    enabled: false,
    rafId: null,
    canvas: null,
    ctx: null,
    target: null,
    statusText: "Idle",
    lastAimX: 0,
    lastAimY: 0,
    aimDirX: 1,
    aimDirY: 0,
    lastTickAt: 0,
    lastTargetId: null,
    targetLockUntil: 0,
    targetVelX: 0,
    targetVelY: 0,
    lastTargetSampleAt: 0,
  };

  const autoAimInputState = {
    leftMouseDown: false,
    reroutedShotActive: false,
  };

  function getTriggerAssistConfig() {
    const defaults = {
      enabled: true,
      teamCheck: true,
      fovPx: 85,
      holdToFire: false,
      fireRateMs: 45,
      requireLOS: false,
      onlyWhenGameFocused: true,
      showTargetRing: true,
    };
    const stored = window.__zyroxTriggerAssistConfig;
    return stored && typeof stored === "object" ? { ...defaults, ...stored } : defaults;
  }

  function getAutoAimConfig() {
    const defaults = {
      enabled: true,
      teamCheck: true,
      fovDeg: 180,
      smoothing: 0.2,
      maxStepPx: 32,
      minStepPx: 0.75,
      deadzonePx: 1.8,
      predictionMs: 70,
      lockMs: 0,
      stickToTarget: false,
      onlyWhenGameFocused: true,
      requireMouseDown: false,
      showDebugDot: true,
    };
    const stored = window.__zyroxAutoAimConfig;
    if (stored && typeof stored === "object") {
      const merged = { ...defaults, ...stored };
      if (merged.fovDeg == null && Number.isFinite(Number(stored.fovPx))) {
        merged.fovDeg = Math.max(15, Math.min(180, Number(stored.fovPx)));
      }
      return merged;
    }
    return defaults;
  }

  function createTriggerAssistCanvas() {
    if (triggerAssistState.canvas?.parentNode) return;
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:10001;pointer-events:none;user-select:none;";
    document.body.appendChild(canvas);
    triggerAssistState.canvas = canvas;
    triggerAssistState.ctx = canvas.getContext("2d");
  }

  function destroyTriggerAssistCanvas() {
    triggerAssistState.canvas?.remove();
    triggerAssistState.canvas = null;
    triggerAssistState.ctx = null;
  }

  function resizeTriggerAssistCanvas() {
    if (!triggerAssistState.canvas) return;
    triggerAssistState.canvas.width = window.innerWidth;
    triggerAssistState.canvas.height = window.innerHeight;
  }

  function createAutoAimCanvas() {
    if (autoAimState.canvas?.parentNode) return;
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:10002;pointer-events:none;user-select:none;";
    document.body.appendChild(canvas);
    autoAimState.canvas = canvas;
    autoAimState.ctx = canvas.getContext("2d");
  }

  function destroyAutoAimCanvas() {
    autoAimState.canvas?.remove();
    autoAimState.canvas = null;
    autoAimState.ctx = null;
  }

  function resizeAutoAimCanvas() {
    if (!autoAimState.canvas) return;
    autoAimState.canvas.width = window.innerWidth;
    autoAimState.canvas.height = window.innerHeight;
  }

  function getGameCanvas() {
    const stores = espState.stores ?? window.stores;
    return stores?.phaser?.game?.canvas
      ?? stores?.phaser?.scene?.game?.canvas
      ?? document.querySelector("canvas");
  }

  function fireCanvasPointerEvent(type, canvas, x, y) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + Math.max(0, Math.min(rect.width, x));
    const clientY = rect.top + Math.max(0, Math.min(rect.height, y));
    const init = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === "pointerup" || type === "mouseup" ? 0 : 1,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    canvas.dispatchEvent(new PointerEvent(type, init));
  }

  function fireCanvasMouseEvent(type, canvas, x, y, buttons = 0) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + Math.max(0, Math.min(rect.width, x));
    const clientY = rect.top + Math.max(0, Math.min(rect.height, y));
    canvas.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX,
      clientY,
    }));
  }

  function syncAimPointer(canvas, x, y, buttons = 0) {
    fireCanvasPointerEvent("pointermove", canvas, x, y);
    fireCanvasMouseEvent("mousemove", canvas, x, y, buttons);
    const clientX = Math.max(0, Math.min(window.innerWidth, Number(x) || 0));
    const clientY = Math.max(0, Math.min(window.innerHeight, Number(y) || 0));
    const moveInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX,
      clientY,
    };
    document.dispatchEvent(new MouseEvent("mousemove", moveInit));
    window.dispatchEvent(new MouseEvent("mousemove", moveInit));
    try {
      const pointerInit = {
        ...moveInit,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      };
      document.dispatchEvent(new PointerEvent("pointermove", pointerInit));
      window.dispatchEvent(new PointerEvent("pointermove", pointerInit));
    } catch (_) { }
  }

  function releaseFireHold() {
    if (!triggerAssistState.mouseHeld) return;
    const canvas = getGameCanvas();
    if (canvas) {
      syncAimPointer(canvas, crosshairState.mouseX, crosshairState.mouseY, 0);
      fireCanvasPointerEvent("pointerup", canvas, crosshairState.mouseX, crosshairState.mouseY);
      fireCanvasMouseEvent("mouseup", canvas, crosshairState.mouseX, crosshairState.mouseY, 0);
    }
    triggerAssistState.mouseHeld = false;
  }

  function attemptFire(hold, forceRelease = false, point = null) {
    const canvas = getGameCanvas();
    if (!canvas) return false;
    canvas.focus?.({ preventScroll: true });
    const aimX = Number(point?.x ?? crosshairState.mouseX);
    const aimY = Number(point?.y ?? crosshairState.mouseY);

    if (forceRelease) {
      releaseFireHold();
      return true;
    }

    if (hold) {
      syncAimPointer(canvas, aimX, aimY, 1);
      if (!triggerAssistState.mouseHeld) {
        fireCanvasPointerEvent("pointerdown", canvas, aimX, aimY);
        fireCanvasMouseEvent("mousedown", canvas, aimX, aimY, 1);
        triggerAssistState.mouseHeld = true;
      }
      return true;
    }

    syncAimPointer(canvas, aimX, aimY, 1);
    fireCanvasPointerEvent("pointerdown", canvas, aimX, aimY);
    fireCanvasMouseEvent("mousedown", canvas, aimX, aimY, 1);
    setTimeout(() => {
      syncAimPointer(canvas, aimX, aimY, 0);
      fireCanvasPointerEvent("pointerup", canvas, aimX, aimY);
      fireCanvasMouseEvent("mouseup", canvas, aimX, aimY, 0);
    }, 12);
    return true;
  }

  function findTriggerTarget(cfg) {
    const snapshot = getAutoAimPlayerSnapshot();
    if (!snapshot?.camera || !Array.isArray(snapshot.players)) return null;
    const mx = crosshairState.mouseX;
    const my = crosshairState.mouseY;
    const espCfg = getEspRenderConfig();
    const baseHitbox = Math.max(12, Number(espCfg.hitboxSize) || 150);
    const width = window.innerWidth;
    const height = window.innerHeight;
    const margin = 80;
    let best = null;
    for (const player of snapshot.players) {
      if (!player) continue;
      const pid = String(player.id ?? "");
      if (!pid || (snapshot.localPlayerId != null && pid === String(snapshot.localPlayerId))) continue;
      if (cfg.teamCheck && snapshot.localTeamId != null && player.teamId === snapshot.localTeamId) continue;
      const screen = projectWorldToScreen(player, snapshot.camera, width, height);
      if (!screen) continue;
      if (screen.x < -margin || screen.x > width + margin || screen.y < -margin || screen.y > height + margin) continue;
      const boxSize = Math.max(24, baseHitbox / Math.max(0.01, Number(screen.zoom) || 1));
      const half = boxSize * 0.5;
      if (mx < screen.x - half || mx > screen.x + half || my < screen.y - half || my > screen.y + half) continue;
      const dist = Math.hypot(mx - screen.x, my - screen.y);
      if (!best || dist < best.distancePx) {
        best = {
          player,
          screenX: screen.x,
          screenY: screen.y,
          distancePx: dist,
          hitboxSizePx: boxSize,
        };
      }
    }
    return best;
  }

  function getAutoAimPlayerSnapshot() {
    const shared = window.__zyroxEspShared;
    if (shared?.ready && Array.isArray(shared.players) && shared.camera) {
      return {
        localPlayerId: shared.localPlayerId ?? null,
        localTeamId: shared.localTeamId ?? null,
        camera: shared.camera,
        players: shared.players,
      };
    }

    const stores = espState.stores ?? window.stores ?? null;
    const me = stores ? getMainCharacter(stores) : null;
    const cam = stores?.phaser?.scene?.cameras?.cameras?.[0];
    if (!me || !cam) return null;
    const mePos = getCharacterPosition(me);
    const meId = String(getCharacterId(me) ?? stores?.phaser?.mainCharacter?.id ?? "");
    const meTeam = getCharacterTeam(me);
    const fallbackPlayers = [];
    for (const { id, character } of getCharacterEntries(stores)) {
      const pos = getCharacterPosition(character);
      if (!pos) continue;
      fallbackPlayers.push({
        id: String(id ?? getCharacterId(character) ?? ""),
        name: String(getCharacterName(character, id)),
        teamId: getCharacterTeam(character),
        x: pos.x,
        y: pos.y,
      });
    }
    return {
      localPlayerId: meId || (mePos ? `${mePos.x}:${mePos.y}` : null),
      localTeamId: meTeam ?? null,
      camera: {
        midX: Number(cam?.midPoint?.x ?? 0),
        midY: Number(cam?.midPoint?.y ?? 0),
        zoom: Number(cam?.zoom ?? 1),
      },
      players: fallbackPlayers,
    };
  }

  function findAutoAimTarget(cfg) {
    const snapshot = getAutoAimPlayerSnapshot();
    if (!snapshot?.camera || !Array.isArray(snapshot.players)) return null;
    const mx = crosshairState.mouseX;
    const my = crosshairState.mouseY;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const margin = 80;
    const fovDeg = Math.max(15, Math.min(180, Number(cfg.fovDeg) || 120));
    const stickyFovDeg = Math.min(180, fovDeg * 1.15);
    const aimDirX = Number(autoAimState.aimDirX) || 1;
    const aimDirY = Number(autoAimState.aimDirY) || 0;
    const angleToAimDir = (toX, toY) => {
      const len = Math.hypot(toX, toY);
      if (len <= 0.001) return 0;
      const nx = toX / len;
      const ny = toY / len;
      const dot = Math.max(-1, Math.min(1, nx * aimDirX + ny * aimDirY));
      return Math.acos(dot) * (180 / Math.PI);
    };
    const canUseSticky = cfg.stickToTarget && autoAimState.target?.player;
    const now = performance.now();
    const isWithinLockWindow = autoAimState.lastTargetId != null && now < autoAimState.targetLockUntil;
    let stickyCandidate = null;
    let best = null;

    for (const player of snapshot.players) {
      if (!player) continue;
      const pid = String(player.id ?? "");
      if (!pid || (snapshot.localPlayerId != null && pid === String(snapshot.localPlayerId))) continue;
      if (cfg.teamCheck && snapshot.localTeamId != null && player.teamId === snapshot.localTeamId) continue;
      const screen = projectWorldToScreen(player, snapshot.camera, width, height);
      if (!screen) continue;
      if (screen.x < -margin || screen.x > width + margin || screen.y < -margin || screen.y > height + margin) continue;
      const dist = Math.hypot(mx - screen.x, my - screen.y);
      const angleDelta = angleToAimDir(screen.x - mx, screen.y - my);
      const score = dist;
      if (angleDelta <= fovDeg && (!best || score < best.score)) {
        best = { player, playerId: pid, screenX: screen.x, screenY: screen.y, distancePx: dist, angleDelta, score };
      }
      if (canUseSticky && pid === String(autoAimState.target.playerId) && angleDelta <= stickyFovDeg) {
        stickyCandidate = { player, playerId: pid, screenX: screen.x, screenY: screen.y, distancePx: dist, angleDelta, score };
      } else if (isWithinLockWindow && pid === String(autoAimState.lastTargetId) && angleDelta <= stickyFovDeg) {
        stickyCandidate = { player, playerId: pid, screenX: screen.x, screenY: screen.y, distancePx: dist, angleDelta, score };
      }
    }
    return stickyCandidate || best;
  }

  function renderAutoAimOverlay(cfg) {
    const ctx = autoAimState.ctx;
    const canvas = autoAimState.canvas;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!cfg.showDebugDot || !autoAimState.target) return;
    const pulse = (Math.sin(performance.now() / 140) + 1) * 0.5;
    const tx = autoAimState.target.screenX;
    const ty = autoAimState.target.screenY;
    ctx.save();
    ctx.fillStyle = `rgba(255, 255, 255, ${0.55 + pulse * 0.2})`;
    ctx.strokeStyle = `rgba(255, 92, 92, ${0.7 + pulse * 0.2})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(tx, ty, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(tx, ty, 7 + pulse * 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function autoAimTick() {
    if (!autoAimState.enabled) return;
    const now = performance.now();
    const dtMs = autoAimState.lastTickAt > 0 ? (now - autoAimState.lastTickAt) : (1000 / 60);
    autoAimState.lastTickAt = now;
    const dtFactor = Math.max(0.45, Math.min(2.2, dtMs / (1000 / 60)));
    const cfg = getAutoAimConfig();
    if (!cfg.enabled) {
      autoAimState.target = null;
      autoAimState.statusText = "Disabled in config";
      renderAutoAimOverlay(cfg);
      return;
    }
    if (cfg.onlyWhenGameFocused && (!document.hasFocus() || document.visibilityState !== "visible")) {
      autoAimState.target = null;
      autoAimState.statusText = "Waiting for focus";
      renderAutoAimOverlay(cfg);
      return;
    }
    if (cfg.requireMouseDown && !autoAimInputState.leftMouseDown) {
      autoAimState.target = null;
      autoAimState.statusText = "Waiting for mouse hold";
      renderAutoAimOverlay(cfg);
      return;
    }

    const target = findAutoAimTarget(cfg);
    autoAimState.target = target;
    if (!target) {
      const hasShared = window.__zyroxEspShared?.ready;
      const hasStores = Boolean((espState.stores ?? window.stores)?.phaser?.scene);
      autoAimState.statusText = (!hasShared && !hasStores) ? "Waiting for match data" : "No target";
      renderAutoAimOverlay(cfg);
      return;
    }

    const canvas = getGameCanvas();
    const smoothing = Math.max(0, Math.min(1, Number(cfg.smoothing) || 0.2));
    const maxStep = Math.max(2, Number(cfg.maxStepPx) || 32);
    const minStep = Math.max(0.05, Number(cfg.minStepPx) || 0.75);
    const deadzone = Math.max(0, Number(cfg.deadzonePx) || 1.8);
    const predictionMs = Math.max(0, Math.min(220, Number(cfg.predictionMs) || 70));
    const lockMs = Math.max(0, Number(cfg.lockMs) || 220);

    if (target.playerId != null) {
      if (autoAimState.lastTargetId !== String(target.playerId)) {
        autoAimState.targetVelX = 0;
        autoAimState.targetVelY = 0;
      }
      if (autoAimState.target) {
        const sampleDelta = Math.max(1, now - (autoAimState.lastTargetSampleAt || now));
        const rawVelX = (target.screenX - autoAimState.target.screenX) / sampleDelta;
        const rawVelY = (target.screenY - autoAimState.target.screenY) / sampleDelta;
        const velBlend = 0.28;
        autoAimState.targetVelX = autoAimState.targetVelX * (1 - velBlend) + rawVelX * velBlend;
        autoAimState.targetVelY = autoAimState.targetVelY * (1 - velBlend) + rawVelY * velBlend;
      }
      autoAimState.lastTargetSampleAt = now;
      autoAimState.lastTargetId = String(target.playerId);
      autoAimState.targetLockUntil = now + lockMs;
    }

    const predictedX = target.screenX + autoAimState.targetVelX * predictionMs;
    const predictedY = target.screenY + autoAimState.targetVelY * predictionMs;
    const dx = predictedX - crosshairState.mouseX;
    const dy = predictedY - crosshairState.mouseY;
    const dist = Math.hypot(dx, dy);
    if (dist > deadzone) {
      const adaptiveSmoothing = Math.pow(smoothing, dtFactor);
      const baseStep = dist * adaptiveSmoothing;
      const step = Math.min(maxStep * dtFactor, Math.max(minStep, baseStep));
      const ratio = Math.min(1, step / dist);
      const nextX = crosshairState.mouseX + dx * ratio;
      const nextY = crosshairState.mouseY + dy * ratio;
      const moveX = nextX - crosshairState.mouseX;
      const moveY = nextY - crosshairState.mouseY;
      const moveLen = Math.hypot(moveX, moveY);
      if (moveLen > 0.0001) {
        autoAimState.aimDirX = moveX / moveLen;
        autoAimState.aimDirY = moveY / moveLen;
      }
      crosshairState.mouseX = nextX;
      crosshairState.mouseY = nextY;
      autoAimState.lastAimX = nextX;
      autoAimState.lastAimY = nextY;
      if (canvas) syncAimPointer(canvas, nextX, nextY, autoAimInputState.leftMouseDown ? 1 : 0);
    }
    autoAimState.statusText = `Locked: ${target.player?.name ?? "Player"}`;
    renderAutoAimOverlay(cfg);
  }

  function autoAimLoop() {
    if (!autoAimState.enabled) return;
    autoAimTick();
    autoAimState.rafId = requestAnimationFrame(autoAimLoop);
  }

  function startAutoAim() {
    if (autoAimState.enabled) return;
    primeSharedPlayerData();
    autoAimState.enabled = true;
    autoAimState.target = null;
    autoAimState.lastTargetId = null;
    autoAimState.targetLockUntil = 0;
    autoAimState.targetVelX = 0;
    autoAimState.targetVelY = 0;
    autoAimState.lastTickAt = 0;
    autoAimState.statusText = "Armed";
    createAutoAimCanvas();
    if (autoAimState.rafId != null) cancelAnimationFrame(autoAimState.rafId);
    autoAimState.rafId = requestAnimationFrame(autoAimLoop);
  }

  function stopAutoAim() {
    if (!autoAimState.enabled) return;
    autoAimState.enabled = false;
    if (autoAimState.rafId != null) {
      cancelAnimationFrame(autoAimState.rafId);
      autoAimState.rafId = null;
    }
    autoAimState.target = null;
    autoAimState.lastTargetId = null;
    autoAimState.targetLockUntil = 0;
    autoAimState.targetVelX = 0;
    autoAimState.targetVelY = 0;
    autoAimState.statusText = "Idle";
    destroyAutoAimCanvas();
  }

  function renderTriggerAssistOverlay(cfg) {
    const ctx = triggerAssistState.ctx;
    const canvas = triggerAssistState.canvas;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!cfg.showTargetRing || !triggerAssistState.target) return;
    const pulse = (Math.sin(performance.now() / 120) + 1) * 0.5;
    const ringR = Math.max(10, Number(cfg.fovPx) || 85);
    ctx.save();
    const ringGradient = ctx.createRadialGradient(
      crosshairState.mouseX,
      crosshairState.mouseY,
      Math.max(1, ringR * 0.1),
      crosshairState.mouseX,
      crosshairState.mouseY,
      ringR
    );
    ringGradient.addColorStop(0, "rgba(255, 130, 130, 0.12)");
    ringGradient.addColorStop(1, "rgba(255, 40, 40, 0.02)");
    ctx.fillStyle = ringGradient;
    ctx.beginPath();
    ctx.arc(crosshairState.mouseX, crosshairState.mouseY, ringR, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(255, 70, 70, ${0.7 + pulse * 0.25})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(crosshairState.mouseX, crosshairState.mouseY, ringR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = `rgba(255, 225, 120, ${0.55 + pulse * 0.35})`;
    ctx.beginPath();
    ctx.moveTo(crosshairState.mouseX, crosshairState.mouseY);
    ctx.lineTo(triggerAssistState.target.screenX, triggerAssistState.target.screenY);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(255, 255, 120, ${0.8 + pulse * 0.2})`;
    ctx.beginPath();
    ctx.arc(triggerAssistState.target.screenX, triggerAssistState.target.screenY, 10 + pulse * 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function triggerAssistTick() {
    if (!triggerAssistState.enabled) return;
    const cfg = getTriggerAssistConfig();
    if (!cfg.enabled) {
      triggerAssistState.statusText = "Disabled in config";
      triggerAssistState.target = null;
      releaseFireHold();
      renderTriggerAssistOverlay(cfg);
      return;
    }
    if (cfg.onlyWhenGameFocused && (!document.hasFocus() || document.visibilityState !== "visible")) {
      triggerAssistState.statusText = "Waiting for focus";
      triggerAssistState.target = null;
      releaseFireHold();
      renderTriggerAssistOverlay(cfg);
      return;
    }

    const target = findTriggerTarget(cfg);
    triggerAssistState.target = target;
    if (!target) {
      const hasShared = window.__zyroxEspShared?.ready;
      const hasStores = Boolean((espState.stores ?? window.stores)?.phaser?.scene);
      triggerAssistState.statusText = (!hasShared && !hasStores) ? "Waiting for match data" : "No target";
      releaseFireHold();
      renderTriggerAssistOverlay(cfg);
      return;
    }

    triggerAssistState.statusText = `Inside Hitbox: ${target.player?.name ?? "Player"}`;
    const now = Date.now();
    const minDelay = Math.max(16, Number(cfg.fireRateMs) || 45);
    if (cfg.holdToFire) {
      attemptFire(true, false, null);
    } else if (now - triggerAssistState.lastFireAt >= minDelay && attemptFire(false, false, null)) {
      triggerAssistState.lastFireAt = now;
    }

    if (triggerAssistState.releaseTimeoutId != null) clearTimeout(triggerAssistState.releaseTimeoutId);
    triggerAssistState.releaseTimeoutId = setTimeout(() => {
      if (!document.hasFocus() || document.visibilityState !== "visible") releaseFireHold();
    }, Math.max(160, minDelay * 2));

    renderTriggerAssistOverlay(cfg);
  }

  function startTriggerAssist() {
    if (triggerAssistState.enabled) return;
    primeSharedPlayerData();
    triggerAssistState.enabled = true;
    createTriggerAssistCanvas();
    triggerAssistState.statusText = "Armed";
    if (triggerAssistState.loopId != null) clearInterval(triggerAssistState.loopId);
    triggerAssistState.loopId = setInterval(triggerAssistTick, 1000 / 60);
  }

  function stopTriggerAssist() {
    if (!triggerAssistState.enabled) return;
    triggerAssistState.enabled = false;
    if (triggerAssistState.loopId != null) {
      clearInterval(triggerAssistState.loopId);
      triggerAssistState.loopId = null;
    }
    if (triggerAssistState.releaseTimeoutId != null) {
      clearTimeout(triggerAssistState.releaseTimeoutId);
      triggerAssistState.releaseTimeoutId = null;
    }
    releaseFireHold();
    triggerAssistState.target = null;
    triggerAssistState.statusText = "Idle";
    destroyTriggerAssistCanvas();
  }

  window.addEventListener("blur", () => {
    autoAimInputState.leftMouseDown = false;
    autoAimInputState.reroutedShotActive = false;
    autoAimState.target = null;
    releaseFireHold();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      autoAimInputState.leftMouseDown = false;
      autoAimInputState.reroutedShotActive = false;
      autoAimState.target = null;
      releaseFireHold();
    }
  });
  window.addEventListener("resize", resizeTriggerAssistCanvas);
  window.addEventListener("resize", resizeAutoAimCanvas);
  function isEventInsideUi(target) {
    const el = target instanceof Element ? target : null;
    return Boolean(el?.closest(".zyrox-root, .zyrox-config-backdrop, .zyrox-settings, .zyrox-config"));
  }

  function shouldRerouteManualShot(event) {
    if (!event || event.button !== 0) return false;
    if (isEventInsideUi(event.target)) return false;
    if (!autoAimState.enabled || !autoAimState.target) return false;
    if (triggerAssistState.enabled) return false;
    const cfg = getAutoAimConfig();
    if (!cfg.enabled) return false;
    if (cfg.onlyWhenGameFocused && (!document.hasFocus() || document.visibilityState !== "visible")) return false;
    return true;
  }

  window.addEventListener("mousedown", (event) => {
    if (!shouldRerouteManualShot(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    autoAimInputState.leftMouseDown = true;
    autoAimInputState.reroutedShotActive = true;
    attemptFire(false, false, { x: crosshairState.mouseX, y: crosshairState.mouseY });
  }, true);

  window.addEventListener("mouseup", (event) => {
    if (event.button !== 0 || isEventInsideUi(event.target)) return;
    if (!autoAimInputState.reroutedShotActive) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    autoAimInputState.leftMouseDown = false;
    autoAimInputState.reroutedShotActive = false;
  }, true);

  window.addEventListener("mousedown", (event) => {
    if (event.button === 0 && !isEventInsideUi(event.target)) autoAimInputState.leftMouseDown = true;
  }, { passive: true });
  window.addEventListener("mouseup", (event) => {
    if (event.button === 0) {
      autoAimInputState.leftMouseDown = false;
      autoAimInputState.reroutedShotActive = false;
    }
  }, { passive: true });

  const answerPopupState = {
    enabled: false,
    container: null,
    timeoutId: null,
    lastAnswer: "",
    lastShownAt: 0,
    lastRenderedAnswer: "",
  };
  const drawItAnswerRevealState = {
    enabled: false,
    selectorMode: "auto",
    lastAnswer: "",
    syncIntervalId: null,
  };

  function getAnswerRevealConfig() {
    if (typeof state !== "undefined" && state?.moduleConfig instanceof Map) {
      const saved = state.moduleConfig.get("Answer Reveal");
      if (saved && typeof saved === "object") {
        return {
          selectorMode: saved.selectorMode === "strict" ? "strict" : "auto",
        };
      }
    }
    return { selectorMode: "auto" };
  }

  function findDrawItMaskedTermElement(selectorMode = "auto") {
    const strictSelectors = [
      ".sc-iKrZTU.cVnVFI span",
      ".sc-iKrZTU.cVnVFI",
      "[data-qa='term-mask']",
      "[data-testid='term-mask']",
      "[class*='term'][class*='mask']",
    ];
    const autoSelectors = [
      ...strictSelectors,
      "[class*='word'][class*='mask']",
      "[class*='draw'][class*='term']",
      ".hSIGsV .cVnVFI span",
      ".hSIGsV .cVnVFI",
      "[data-qa*='term']",
      "[data-testid*='term']",
    ];
    const selectors = selectorMode === "strict" ? strictSelectors : autoSelectors;
    for (const selector of selectors) {
      const hit = document.querySelector(selector);
      if (hit && typeof hit.textContent === "string") return hit;
    }
    return null;
  }

  function applyDrawItAnswerReveal(answerText) {
    if (!drawItAnswerRevealState.enabled) return;
    const answer = String(answerText || "").trim();
    if (!answer) return;
    drawItAnswerRevealState.lastAnswer = answer;
    forceDrawItAnswerReveal();
  }

  function forceDrawItAnswerReveal() {
    if (!drawItAnswerRevealState.enabled) return;
    const answer = String(drawItAnswerRevealState.lastAnswer || "").trim();
    if (!answer) return;
    const target = findDrawItMaskedTermElement(drawItAnswerRevealState.selectorMode);
    if (!target) return;
    if (!target.dataset.zyroxOriginalMask) {
      target.dataset.zyroxOriginalMask = String(target.textContent || "");
    }
    if (target.textContent !== answer) target.textContent = answer;
  }

  function restoreDrawItAnswerMask() {
    const target = findDrawItMaskedTermElement(drawItAnswerRevealState.selectorMode);
    if (!target) return;
    const originalMask = target.dataset.zyroxOriginalMask;
    if (typeof originalMask === "string" && originalMask.length) {
      target.textContent = originalMask;
      delete target.dataset.zyroxOriginalMask;
    }
  }

  function startDrawItAnswerReveal() {
    const cfg = getAnswerRevealConfig();
    drawItAnswerRevealState.selectorMode = cfg.selectorMode;
    drawItAnswerRevealState.enabled = true;
    if (!drawItAnswerRevealState.syncIntervalId) {
      drawItAnswerRevealState.syncIntervalId = setInterval(forceDrawItAnswerReveal, 50);
    }
  }

  function stopDrawItAnswerReveal() {
    drawItAnswerRevealState.enabled = false;
    drawItAnswerRevealState.lastAnswer = "";
    if (drawItAnswerRevealState.syncIntervalId) {
      clearInterval(drawItAnswerRevealState.syncIntervalId);
      drawItAnswerRevealState.syncIntervalId = null;
    }
    restoreDrawItAnswerMask();
  }

  const ANSWER_POPUP_PRESETS = {
    default: { accent: "#ff4a4a", textColor: "#ffffff", durationMs: 2600, panelBg: "rgba(8, 10, 14, 0.92)", headerStart: "rgba(255, 74, 74, 0.30)", headerEnd: "rgba(45, 12, 12, 0.95)" },
    green: { accent: "#2dff75", textColor: "#e8fff1", durationMs: 2400, panelBg: "rgba(7, 20, 12, 0.92)", headerStart: "rgba(45, 255, 117, 0.30)", headerEnd: "rgba(15, 47, 27, 0.95)" },
    ice: { accent: "#6cd8ff", textColor: "#eaf7ff", durationMs: 2400, panelBg: "rgba(8, 17, 24, 0.92)", headerStart: "rgba(108, 216, 255, 0.30)", headerEnd: "rgba(19, 48, 66, 0.95)" },
    grayscale: { accent: "#d4d4d4", textColor: "#f1f1f1", durationMs: 2600, panelBg: "rgba(18, 18, 18, 0.92)", headerStart: "rgba(143, 143, 143, 0.30)", headerEnd: "rgba(29, 29, 29, 0.95)" },
  };

  function normalizePopupPresetName(name) {
    const key = String(name || "default").toLowerCase();
    return Object.prototype.hasOwnProperty.call(ANSWER_POPUP_PRESETS, key) ? key : "default";
  }

  function getGlobalPresetName() {
    const name = typeof state !== "undefined" ? state?.globalPreset : "default";
    return normalizePopupPresetName(name || "default");
  }

  function getEffectivePopupPresetName(selectedPresetName) {
    const selected = normalizePopupPresetName(selectedPresetName);
    return selected === "default" ? getGlobalPresetName() : selected;
  }

  function applyAnswerPopupPreset(cfg, presetName) {
    const name = normalizePopupPresetName(presetName);
    const preset = ANSWER_POPUP_PRESETS[getEffectivePopupPresetName(name)] || ANSWER_POPUP_PRESETS.default;
    cfg.preset = name;
    cfg.accent = preset.accent;
    cfg.textColor = preset.textColor;
    cfg.durationMs = preset.durationMs;
  }

  function getAnswerPopupConfig() {
    const defaults = {
      preset: "default",
      text: "answer",
      durationMs: 2600,
      accent: "#ff4a4a",
      textColor: "#ffffff",
    };
    let cfg = defaults;
    if (typeof state !== "undefined" && state?.moduleConfig instanceof Map) {
      const saved = state.moduleConfig.get("Answer Popup");
      if (saved && typeof saved === "object") cfg = { ...defaults, ...saved };
    }
    const selectedPreset = normalizePopupPresetName(cfg.preset || "default");
    const effectivePresetName = getEffectivePopupPresetName(selectedPreset);
    const preset = ANSWER_POPUP_PRESETS[effectivePresetName] || ANSWER_POPUP_PRESETS.default;
    const usePresetOnly = selectedPreset === "default";
    return {
      globalPreset: getGlobalPresetName(),
      preset: selectedPreset,
      effectivePreset: effectivePresetName,
      text: String(cfg.text ?? defaults.text),
      durationMs: Math.max(
        400,
        Number(usePresetOnly ? preset.durationMs : (cfg.durationMs ?? preset.durationMs ?? defaults.durationMs)) || defaults.durationMs,
      ),
      accent: String(usePresetOnly ? preset.accent : (cfg.accent ?? preset.accent ?? defaults.accent)),
      textColor: String(usePresetOnly ? preset.textColor : (cfg.textColor ?? preset.textColor ?? defaults.textColor)),
      panelBg: String(preset.panelBg ?? ANSWER_POPUP_PRESETS.default.panelBg),
      headerStart: String(preset.headerStart ?? ANSWER_POPUP_PRESETS.default.headerStart),
      headerEnd: String(preset.headerEnd ?? ANSWER_POPUP_PRESETS.default.headerEnd),
      headerText: String(usePresetOnly ? preset.textColor : (cfg.textColor ?? preset.textColor ?? defaults.textColor)),
    };
  }

  function ensureAnswerPopupContainer() {
    if (answerPopupState.container?.isConnected) return answerPopupState.container;
    const popup = document.createElement("div");
    popup.className = "zyrox-answer-popup";
    popup.style.cssText = [
      "position:fixed",
      "left:50%",
      "top:92px",
      "transform:translate(-50%, -18px)",
      "min-width:260px",
      "max-width:min(86vw,640px)",
      "padding:0",
      "border-radius:12px",
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif",
      "z-index:2147483647",
      "opacity:0",
      "pointer-events:none",
      "transition:opacity .18s ease, transform .18s ease",
      "box-shadow:0 14px 34px rgba(0,0,0,.45)",
      "border:1px solid rgba(255,255,255,.14)",
      "display:none",
      "overflow:hidden",
      "white-space:normal",
      "overflow-wrap:anywhere",
    ].join(";");
    document.documentElement.appendChild(popup);
    answerPopupState.container = popup;
    return popup;
  }

  function showAnswerPopup(answerText) {
    if (!answerPopupState.enabled) return;
    const answer = String(answerText || "").trim();
    if (!answer) return;
    const now = Date.now();
    if (answer === answerPopupState.lastAnswer && now - answerPopupState.lastShownAt < 700) return;
    answerPopupState.lastAnswer = answer;
    answerPopupState.lastShownAt = now;
    answerPopupState.lastRenderedAnswer = answer;

    const popup = ensureAnswerPopupContainer();
    const cfg = getAnswerPopupConfig();
    popup.style.background = cfg.panelBg;
    popup.style.color = cfg.textColor;
    popup.style.borderLeft = `4px solid ${cfg.accent}`;
    popup.style.border = "1px solid rgba(255,255,255,.14)";
    popup.style.boxShadow = "0 14px 34px rgba(0,0,0,.45)";
    const label = cfg.text.trim();
    popup.innerHTML = `
      <div style="padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.1);background:linear-gradient(90deg, ${cfg.headerStart}, ${cfg.headerEnd});color:${cfg.headerText};font-size:13px;font-weight:700;text-transform:capitalize;">${label || "answer"}</div>
      <div style="padding:10px 12px;font-size:16px;font-weight:700;line-height:1.25;"><span style="color:${cfg.accent};">${answer}</span></div>
    `;

    popup.style.display = "block";
    popup.style.opacity = "1";
    popup.style.transform = "translate(-50%, 0)";
    if (answerPopupState.timeoutId) clearTimeout(answerPopupState.timeoutId);
    answerPopupState.timeoutId = setTimeout(() => {
      popup.style.opacity = "0";
      popup.style.transform = "translate(-50%, -18px)";
      setTimeout(() => {
        if (popup.style.opacity === "0") popup.style.display = "none";
      }, 180);
    }, cfg.durationMs);
  }

  function refreshVisibleAnswerPopup() {
    if (!answerPopupState.container) return;
    if (answerPopupState.container.style.display === "none") return;
    const answer = String(answerPopupState.lastRenderedAnswer || "").trim();
    if (!answer) return;
    const cfg = getAnswerPopupConfig();
    answerPopupState.container.style.background = cfg.panelBg;
    answerPopupState.container.style.color = cfg.textColor;
    answerPopupState.container.style.borderLeft = `4px solid ${cfg.accent}`;
    const label = cfg.text.trim();
    answerPopupState.container.innerHTML = `
      <div style="padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.1);background:linear-gradient(90deg, ${cfg.headerStart}, ${cfg.headerEnd});color:${cfg.headerText};font-size:13px;font-weight:700;text-transform:capitalize;">${label || "answer"}</div>
      <div style="padding:10px 12px;font-size:16px;font-weight:700;line-height:1.25;"><span style="color:${cfg.accent};">${answer}</span></div>
    `;
  }

  function startAnswerPopup() {
    answerPopupState.enabled = true;
  }

  function stopAnswerPopup() {
    answerPopupState.enabled = false;
    if (answerPopupState.timeoutId) {
      clearTimeout(answerPopupState.timeoutId);
      answerPopupState.timeoutId = null;
    }
    if (answerPopupState.container) {
      answerPopupState.container.style.opacity = "0";
      answerPopupState.container.style.display = "none";
    }
    answerPopupState.lastRenderedAnswer = "";
  }

  const ANIMATION_SKIP_MODULE_NAME = "Animation skip (UI)";
  const LEGACY_ANIMATION_SKIP_MODULE_NAME = "Animation Skip";
  const ANIMATION_SKIP_STYLE_ID = "zyrox-animation-skip-style";
  let originalElementAnimate = null;
  let animationSkipRouteWatcher = null;

  function shouldPauseAnimationSkipForJoinMenu() {
    return String(location?.pathname || "").startsWith("/join");
  }

  function applyAnimationSkipState(enabled) {
    if (!enabled) {
      const styleEl = document.getElementById(ANIMATION_SKIP_STYLE_ID);
      if (styleEl) styleEl.remove();
      if (originalElementAnimate && typeof Element !== "undefined") {
        Element.prototype.animate = originalElementAnimate;
        originalElementAnimate = null;
      }
      return;
    }

    let styleEl = document.getElementById(ANIMATION_SKIP_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = ANIMATION_SKIP_STYLE_ID;
      document.documentElement.appendChild(styleEl);
    }
    styleEl.textContent = `
      *, *::before, *::after {
        transition: none !important;
        transition-duration: 0ms !important;
        transition-delay: 0ms !important;
        animation: none !important;
        animation-duration: 0ms !important;
        animation-delay: 0ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
      }
    `;

    if (!originalElementAnimate && typeof Element !== "undefined" && typeof Element.prototype?.animate === "function") {
      originalElementAnimate = Element.prototype.animate;
      Element.prototype.animate = function patchedAnimate(keyframes, options) {
        const normalized = typeof options === "number" ? { duration: options } : { ...(options || {}) };
        normalized.duration = 0;
        normalized.delay = 0;
        normalized.endDelay = 0;
        normalized.iterations = 1;
        const animation = originalElementAnimate.call(this, keyframes, normalized);
        try { animation.finish(); } catch (_) {}
        return animation;
      };
    }
  }

  function startAnimationSkip() {
    const syncMode = () => applyAnimationSkipState(!shouldPauseAnimationSkipForJoinMenu());
    syncMode();
    if (animationSkipRouteWatcher) clearInterval(animationSkipRouteWatcher);
    animationSkipRouteWatcher = setInterval(syncMode, 400);
  }

  function stopAnimationSkip() {
    if (animationSkipRouteWatcher) {
      clearInterval(animationSkipRouteWatcher);
      animationSkipRouteWatcher = null;
    }
    applyAnimationSkipState(false);
  }

  const MODULE_BEHAVIORS = {
    [ANIMATION_SKIP_MODULE_NAME]: {
      onEnable: startAnimationSkip,
      onDisable: stopAnimationSkip,
    },
    "ESP": {
      onEnable: startEsp,
      onDisable: stopEsp,
    },
    "Crosshair": {
      onEnable: startCrosshair,
      onDisable: stopCrosshair,
    },
    "Triggerbot (Autoshoot)": {
      onEnable: startTriggerAssist,
      onDisable: stopTriggerAssist,
    },
    "Aimbot": {
      onEnable: startAutoAim,
      onDisable: stopAutoAim,
    },
    "Answer Popup": {
      onEnable: startAnswerPopup,
      onDisable: stopAnswerPopup,
    },
    "Answer Reveal": {
      onEnable: startDrawItAnswerReveal,
      onDisable: stopDrawItAnswerReveal,
    },
  };
  const WORKING_MODULES = new Set(["Auto Answer", ANIMATION_SKIP_MODULE_NAME, "ESP", "Crosshair", "Triggerbot (Autoshoot)", "Aimbot", "Answer Popup", "Answer Reveal"]);
  const MODULE_DESCRIPTIONS = {
    "Auto Answer": "Automatically submits the best answer after a delay.",
    [ANIMATION_SKIP_MODULE_NAME]: "Skips most UI/menu animations (CSS + Web Animations API) so interfaces appear instantly.",
    "ESP": "Shows players with tracers, names, and off-screen indicators.",
    "Crosshair": "Draws a customizable crosshair and optional center line.",
    "Triggerbot (Autoshoot)": "Fires automatically when an enemy is in your aim radius.",
    "Aimbot": "Smoothly snaps your aim to nearby enemy players.",
    "Answer Reveal": "Reveals Draw It prompts/answers inside the drawing round.",
    "Answer Popup": "Displays detected Draw It answers in a popup.",
  };

  // --- End of Core Utilities ---

  const MENU_LAYOUT = {
    general: {
      title: "General",
      groups: [
        {
          name: "Core",
          modules: [
            {
              name: "Auto Answer",
              description: MODULE_DESCRIPTIONS["Auto Answer"],
              settings: [
                { id: "speed", label: "Answer Delay", type: "slider", min: 200, max: 3000, step: 50, default: 1000 },
              ],
            },
          ],
        },
        {
          name: "Visual",
          modules: [
            {
              name: "ESP",
              description: MODULE_DESCRIPTIONS["ESP"],
              settings: [
                { id: "hitbox", label: "Hitbox", type: "checkbox", default: true },
                { id: "hitboxSize", label: "Hitbox Size", type: "slider", min: 24, max: 270, step: 2, default: 150, unit: "px" },
                { id: "hitboxWidth", label: "Hitbox Width", type: "slider", min: 1, max: 10, step: 1, default: 3, unit: "px" },
                { id: "hitboxColor", label: "Hitbox Color", type: "color", default: "#ff3b3b" },
                { id: "names", label: "Names", type: "checkbox", default: true },
                { id: "namesDistanceOnly", label: "Distance Only", type: "checkbox", default: false },
                { id: "nameSize", label: "Name Size", type: "slider", min: 10, max: 32, step: 1, default: 22, unit: "px" },
                { id: "nameColor", label: "Name Color", type: "color", default: "#7a0c0c" },
                {
                  id: "offscreenStyle",
                  label: "Off-screen Indicator",
                  type: "select",
                  default: "tracers",
                  options: [
                    { value: "none", label: "None" },
                    { value: "tracers", label: "Tracers" },
                    { value: "arrows", label: "Arrows" },
                  ],
                },
                {
                  id: "offscreenTheme",
                  label: "Off-screen Theme",
                  type: "select",
                  default: "classic",
                  options: [
                    { value: "classic", label: "Classic" },
                    { value: "dashed", label: "Dashed" },
                    { value: "neon", label: "Neon" },
                  ],
                },
                { id: "alwaysTracer", label: "Always Show Tracer", type: "checkbox", default: false },
                { id: "tracerWidth", label: "Tracer Width", type: "slider", min: 1, max: 8, step: 1, default: 3, unit: "px" },
                { id: "tracerColor", label: "Tracer Color", type: "color", default: "#ff3b3b" },
                { id: "arrowSize", label: "Arrow Size", type: "slider", min: 8, max: 30, step: 1, default: 14, unit: "px" },
                { id: "arrowColor", label: "Arrow Color", type: "color", default: "#ff3b3b" },
                {
                  id: "arrowStyle",
                  label: "Arrow Style",
                  type: "select",
                  default: "regular",
                  options: [
                    { value: "regular", label: "Regular Arrow" },
                    { value: "dot", label: "Dot" },
                    { value: "modern", label: "Modern Arrow" },
                  ],
                },
              ],
            },
          ],
        },
        {
          name: "Quality of life",
          modules: [
            {
              name: ANIMATION_SKIP_MODULE_NAME,
              description: MODULE_DESCRIPTIONS[ANIMATION_SKIP_MODULE_NAME],
              settings: [],
            },
          ],
        },
        {
          name: "Combat",
          modules: [
            {
              name: "Crosshair",
              description: MODULE_DESCRIPTIONS["Crosshair"],
              settings: [
                { id: "enabled",       label: "Show Crosshair",  type: "checkbox", default: true },
                { id: "style",         label: "Style",            type: "select",   default: "x",
                  options: [
                    { value: "cross",       label: "Cross (gap)" },
                    { value: "solid",       label: "Solid Cross" },
                    { value: "crossdot",    label: "Cross + Dot" },
                    { value: "dot",         label: "Dot" },
                    { value: "circle",      label: "Circle" },
                    { value: "circlecross", label: "Circle + Cross" },
                    { value: "plus",        label: "Plus (thick)" },
                    { value: "x",           label: "X (diagonal)" },
                  ],
                },
                { id: "color",         label: "Crosshair Color",  type: "color",    default: "#ff3b3b" },
                { id: "crosshairSize", label: "Crosshair Size",   type: "slider",   default: 25, min: 4, max: 40, step: 1, unit: "px" },
                { id: "lineSize",      label: "Cursor Width",      type: "slider",   default: 4,  min: 1, max: 6,  step: 0.5, unit: "px" },
                { id: "showLine",       label: "Show Line",         type: "checkbox", default: false },
                { id: "lineColor",      label: "Line Color",        type: "color",    default: "#ff3b3b" },
                { id: "tracerLineSize", label: "Tracer Thickness",  type: "slider",   default: 1.5, min: 0.5, max: 5, step: 0.5, unit: "px" },
                { id: "hoverHighlight", label: "Player Hover",      type: "checkbox", default: true },
                { id: "hoverColor",     label: "Hover Color",       type: "color",    default: "#ffff00" },
              ],
            },
            {
              name: "Triggerbot (Autoshoot)",
              description: MODULE_DESCRIPTIONS["Triggerbot (Autoshoot)"],
              settings: [
                { id: "enabled",             label: "Enabled",                  type: "checkbox", default: true },
                { id: "teamCheck",           label: "Ignore Teammates",         type: "checkbox", default: true },
                { id: "fovPx",               label: "FOV Radius",               type: "slider",   default: 85, min: 8, max: 220, step: 1, unit: "px" },
                { id: "holdToFire",          label: "Hold Fire While Targeted", type: "checkbox", default: false },
                { id: "fireRateMs",          label: "Fire Rate Limit",          type: "slider",   default: 45, min: 16, max: 500, step: 1, unit: "ms" },
                { id: "requireLOS",          label: "Require LOS (future)",     type: "checkbox", default: false },
                { id: "onlyWhenGameFocused", label: "Only When Focused",        type: "checkbox", default: true },
                { id: "showTargetRing",      label: "Show Target Ring",         type: "checkbox", default: true },
              ],
            },
            {
              name: "Aimbot",
              description: MODULE_DESCRIPTIONS["Aimbot"],
              settings: [
                { id: "enabled",             label: "Enabled",               type: "checkbox", default: true },
                { id: "teamCheck",           label: "Ignore Teammates",      type: "checkbox", default: true },
                { id: "fovDeg",              label: "Aim FOV",               type: "slider",   default: 180, min: 15, max: 180, step: 1, unit: "°" },
                { id: "smoothing",           label: "Smoothing",             type: "slider",   default: 0.2, min: 0, max: 1, step: 0.01 },
                { id: "maxStepPx",           label: "Max Step",              type: "slider",   default: 32, min: 2, max: 120, step: 1, unit: "px" },
                { id: "minStepPx",           label: "Min Step",              type: "slider",   default: 0.75, min: 0, max: 8, step: 0.05, unit: "px" },
                { id: "deadzonePx",          label: "Deadzone",              type: "slider",   default: 1.8, min: 0, max: 12, step: 0.1, unit: "px" },
                { id: "predictionMs",        label: "Prediction",            type: "slider",   default: 70, min: 0, max: 220, step: 1, unit: "ms" },
                { id: "lockMs",              label: "Target Lock",           type: "slider",   default: 0, min: 0, max: 800, step: 5, unit: "ms" },
                { id: "stickToTarget",       label: "Stick To Target",       type: "checkbox", default: false },
                { id: "onlyWhenGameFocused", label: "Only When Focused",     type: "checkbox", default: true },
                { id: "requireMouseDown",    label: "Require Left Mouse",    type: "checkbox", default: false },
                { id: "showDebugDot",        label: "Show Debug Dot",        type: "checkbox", default: true },
              ],
            },
          ],
        },
      ],
    },
    gamemodeSpecific: {
      title: "Gamemode Specific",
      groups: [
        {
          name: "Draw It",
          modules: [
            {
              name: "Answer Reveal",
              description: MODULE_DESCRIPTIONS["Answer Reveal"],
              settings: [
                {
                  id: "selectorMode",
                  label: "Selector Mode",
                  type: "select",
                  default: "auto",
                  options: [
                    { value: "auto", label: "Auto" },
                    { value: "strict", label: "Strict" },
                  ],
                },
              ],
            },
            {
              name: "Answer Popup",
              description: MODULE_DESCRIPTIONS["Answer Popup"],
              settings: [
                {
                  id: "preset",
                  label: "Preset",
                  type: "select",
                  default: "default",
                  options: [
                    { value: "default", label: "Default (Red)" },
                    { value: "green", label: "Green" },
                    { value: "ice", label: "Ice" },
                    { value: "grayscale", label: "Grayscale" },
                  ],
                },
                { id: "text", label: "Popup Text", type: "text", default: "answer" },
                { id: "durationMs", label: "Display Duration", type: "slider", min: 600, max: 8000, step: 100, default: 2600, unit: "ms" },
                { id: "accent", label: "Accent Color", type: "color", default: "#ff4a4a" },
                { id: "textColor", label: "Text Color", type: "color", default: "#ffffff" },
              ],
            },
          ],
        },
      ],
    },
  };

  const state = {
    visible: true,
    searchQuery: "",
    shellWidth: 1160,
    shellHeight: 640,
    enabledModules: new Set(),
    moduleItems: new Map(),
    modulePanels: new Map(),
    moduleEntries: [],
    moduleConfig: new Map(),
    collapsedPanels: {},
    listeningForBind: null,
    listeningForMenuBind: false,
    searchAutofocus: true,
    hideBrokenModules: true,
    displayMode: "loose",
    looseInitialized: false,
    loosePositions: {
      topbar: { x: 12, y: 12 },
    },
    loosePanelPositions: {},
    mergedRootPosition: { left: 20, top: 28 },
    globalPreset: "default",
    modules: new Map(),
  };

  // Bumped to v3 — includes display-mode and loose layout position persistence
  const STORAGE_KEY = "zyrox_client_settings_v3";
  const DEFAULT_FOOTER_HTML = () => `<span>Press <b>${CONFIG.toggleKey}</b> to show/hide menu</span><span>Right click modules for settings</span>`;

  function debounce(fn, waitMs = 120) {
    let timerId = null;
    return (...args) => {
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(() => {
        timerId = null;
        fn(...args);
      }, waitMs);
    };
  }

  // Defer all DOM work — WebSocket is already patched above at document-start.
  function initUi() {

  const style = document.createElement("style");
  style.textContent = `
    .zyrox-root,
    .zyrox-config-backdrop {
      --zyx-border: #ff6f6f99;
      --zyx-border-soft: rgba(255, 255, 255, 0.12);
      --zyx-text: #d6d6df;
      --zyx-text-strong: #fff;
      --zyx-header-text: #fff;
      --zyx-header-bg-start: rgba(255, 74, 74, 0.24);
      --zyx-header-bg-end: rgba(60, 18, 18, 0.92);
      --zyx-topbar-bg-start: rgba(255, 74, 74, 0.22);
      --zyx-topbar-bg-end: rgba(56, 16, 16, 0.9);
      --zyx-icon-color: #ffdada;
      --zyx-outline-color: #ff5b5bcc;
      --zyx-slider-color: #ff6b6b;
      --zyx-panel-count-text: #ffd9d9;
      --zyx-panel-count-border: rgba(255, 100, 100, 0.45);
      --zyx-panel-count-bg: rgba(8, 8, 10, 0.6);
      --zyx-settings-header-start: rgba(255, 61, 61, .3);
      --zyx-settings-header-end: rgba(45, 12, 12, .95);
      --zyx-settings-sidebar-bg: rgba(24, 24, 32, .22);
      --zyx-settings-body-bg: linear-gradient(180deg, rgba(18, 18, 22, 0.97), rgba(8, 8, 10, 0.97));
      --zyx-settings-text: #ffe5e5;
      --zyx-settings-subtext: #c2c2ce;
      --zyx-settings-card-bg: rgba(255,255,255,.03);
      --zyx-settings-card-border: rgba(255,255,255,.08);
      --zyx-select-bg: rgba(20, 20, 28, 0.9);
      --zyx-select-text: #ffe5e5;
      --zyx-input-bg: rgba(20, 20, 28, 0.9);
      --zyx-input-text: #ffe5e5;
      --zyx-accent-soft: #ffbdbd;
      --zyx-search-text: #ffe6e6;
      --zyx-checkmark-color: #ff6b6b;
      --zyx-module-hover-bg: rgba(30, 30, 36, 0.9);
      --zyx-module-hover-border: rgba(255, 255, 255, 0.14);
      --zyx-module-active-start: rgba(255, 61, 61, 0.32);
      --zyx-module-active-end: rgba(40, 10, 10, 0.8);
      --zyx-module-active-border: rgba(255, 61, 61, 0.52);
      --zyx-hover-shift: 2px;
      --zyx-shell-blur: 10px;
      --zyx-muted: #9b9bab;
      --zyx-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
      --zyx-radius-xl: 14px;
      --zyx-radius-lg: 12px;
      --zyx-radius-md: 10px;
      --zyx-font: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      /* FIX: button accent colours are now CSS variables, updated by applyAppearance() */
      --zyx-btn-bg: rgba(255, 61, 61, 0.12);
      --zyx-btn-hover-bg: rgba(255, 61, 61, 0.2);
    }

    .zyrox-root {
      all: initial;
      position: fixed;
      top: 28px;
      left: 20px;
      z-index: 2147483647;
      color: var(--zyx-text);
      user-select: none;
      font-family: var(--zyx-font);
    }

    .zyrox-root * { box-sizing: border-box; font-family: inherit; }

    .zyrox-config-backdrop {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483648;
      background: rgba(0, 0, 0, 0.26);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--zyx-settings-text);
      font-family: var(--zyx-font);
    }

    .zyrox-config-backdrop * { box-sizing: border-box; font-family: inherit; }
    .zyrox-hidden { display: none !important; }

    .zyrox-shell {
      position: relative;
      display: inline-flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px;
      width: 1160px;
      height: 640px;
      border-radius: var(--zyx-radius-xl);
      border: 1px solid var(--zyx-border-soft);
      background: linear-gradient(150deg, #ff3d3d22, rgba(0, 0, 0, 0.45));
      backdrop-filter: blur(var(--zyx-shell-blur)) saturate(115%);
      box-shadow: var(--zyx-shadow);
      overflow: auto;
    }

    .zyrox-topbar {
      min-height: 42px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      border-radius: var(--zyx-radius-lg);
      border: 1px solid var(--zyx-border);
      background: linear-gradient(125deg, var(--zyx-topbar-bg-start), var(--zyx-topbar-bg-end));
      cursor: move;
    }

    .zyrox-topbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Hide legacy topbar category controls from older builds/state */
    .zyrox-collapse-row,
    .zyrox-collapse-btn {
      display: none !important;
    }

    .zyrox-shell.loose-mode {
      padding: 0;
      width: auto !important;
      height: auto !important;
      min-width: 0;
      min-height: 0;
      border: none;
      box-shadow: none;
      background: transparent !important;
      backdrop-filter: none !important;
      overflow: visible;
    }

    .zyrox-shell.loose-mode .zyrox-footer,
    .zyrox-shell.loose-mode .zyrox-resize-handle {
      display: none;
    }

    .zyrox-shell.loose-mode .zyrox-topbar {
      position: absolute;
      top: 0;
      left: 0;
      width: fit-content;
      min-height: 38px;
      padding: 6px 10px;
      z-index: 4;
    }

    .zyrox-shell.loose-mode .zyrox-section {
      display: contents;
    }

    .zyrox-shell.loose-mode .zyrox-section-label {
      display: none;
    }

    .zyrox-shell.loose-mode .zyrox-panels {
      display: block;
      overflow: visible;
      max-height: none;
      padding: 0;
    }

    .zyrox-shell.loose-mode .zyrox-panel {
      position: absolute;
      width: 212px;
      z-index: 3;
    }

    .zyrox-shell.loose-mode .zyrox-panel-header {
      cursor: move;
    }


    .zyrox-brand { display: flex; align-items: center; gap: 10px; color: var(--zyx-text-strong); }

    .zyrox-logo {
      width: 30px;
      height: 30px;
      border-radius: 6px;
      object-fit: contain;
      box-shadow: 0 0 0 1px rgba(255,255,255,.25), 0 0 18px rgba(255,61,61,.45);
      outline: 1px solid var(--zyx-icon-color);
    }

    .zyrox-brand .title { font-size: 13px; font-weight: 700; line-height: 1; }
    .zyrox-brand .subtitle { font-size: 11px; font-weight: 500; color: rgba(255,255,255,.7); }

    .zyrox-chip {
      font-size: 10px;
      color: var(--zyx-settings-text);
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--zyx-outline-color);
      border-radius: 999px;
      padding: 4px 8px;
      line-height: 1;
    }

    .zyrox-keybind-btn {
      font-size: 11px;
      color: var(--zyx-icon-color);
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--zyx-outline-color);
      border-radius: 8px;
      padding: 4px 8px;
      line-height: 1;
      cursor: pointer;
    }

    .zyrox-settings-btn {
      width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      color: var(--zyx-icon-color);
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--zyx-outline-color);
      border-radius: 8px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
    }

    .zyrox-search {
      width: 190px;
      height: 28px;
      border-radius: 8px;
      border: 1px solid var(--zyx-outline-color);
      background: rgba(10, 8, 8, 0.72);
      color: var(--zyx-search-text);
      padding: 0 10px;
      font-size: 12px;
      outline: none;
    }

    .zyrox-search:focus {
      background: rgba(15, 12, 12, 0.8);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .zyrox-section { display: flex; flex-direction: column; gap: 7px; }
    .zyrox-section-label {
      font-size: 11px;
      letter-spacing: 0.25px;
      color: var(--zyx-accent-soft);
      padding-left: 2px;
      text-transform: uppercase;
    }

    .zyrox-panels {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: flex-start;
      align-content: flex-start;
      overflow: auto;
      max-width: 100%;
      padding-bottom: 2px;
      max-height: 38vh;
    }

    /* FIX: was hardcoded rgba(255, 61, 61, 0.3) — now follows theme */
    .zyrox-panels::-webkit-scrollbar { width: 8px; height: 8px; }
    .zyrox-panels::-webkit-scrollbar-thumb { background: var(--zyx-btn-hover-bg); border-radius: 999px; }

    .zyrox-panel {
      width: 212px;
      border-radius: var(--zyx-radius-lg);
      border: 1px solid var(--zyx-border-soft);
      background: linear-gradient(180deg, rgba(24, 24, 30, 0.9), rgba(10, 10, 12, 0.9));
      overflow: hidden;
    }

    .zyrox-panel-header {
      min-height: 33px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 600;
      color: var(--zyx-header-text);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: linear-gradient(90deg, var(--zyx-header-bg-start), var(--zyx-header-bg-end));
    }

    .zyrox-panel-collapse-btn {
      font-size: 10px;
      color: var(--zyx-panel-count-text);
      background: var(--zyx-panel-count-bg);
      border: 1px solid var(--zyx-panel-count-border);
      border-radius: 999px;
      padding: 3px 7px;
      line-height: 1;
      cursor: pointer;
    }

    .zyrox-panel-collapse-btn.collapsed {
      opacity: 0.62;
    }

    .zyrox-module-list { margin: 0; padding: 7px; list-style: none; display: flex; flex-direction: column; gap: 5px; }

    .zyrox-module {
      min-height: 30px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 10px;
      font-size: 13px;
      font-weight: 500;
      color: var(--zyx-text);
      border: 1px solid transparent;
      border-radius: var(--zyx-radius-md);
      background: rgba(255, 255, 255, 0.03);
      transition: transform .11s ease, background .11s ease, border-color .11s ease, color .11s ease;
      cursor: pointer;
      white-space: nowrap;
    }

    .zyrox-module:hover {
      background: var(--zyx-module-hover-bg);
      border-color: var(--zyx-module-hover-border);
      color: var(--zyx-settings-text);
      transform: translateX(var(--zyx-hover-shift));
    }

    .zyrox-module.active {
      color: #fff;
      background: linear-gradient(90deg, var(--zyx-module-active-start), var(--zyx-module-active-end));
      border-color: var(--zyx-module-active-border);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
    }

    .zyrox-bind-label {
      font-size: 10px;
      color: var(--zyx-muted);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 2px 5px;
      line-height: 1;
      background: rgba(0, 0, 0, 0.35);
    }

    .zyrox-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      color: var(--zyx-muted);
      font-size: 11px;
      padding: 0 3px;
    }

    .zyrox-config {
      position: relative;
      z-index: 2147483649;
      min-width: 340px;
      border-radius: 11px;
      border: 1px solid var(--zyx-border);
      background: linear-gradient(180deg, rgba(18, 18, 22, 0.97), rgba(8, 8, 10, 0.97));
      box-shadow: var(--zyx-shadow);
      overflow: hidden;
    }

    .zyrox-config.hidden { display: none !important; }
    /* FIX: config header now uses settings-header vars so it follows the theme */
    .zyrox-config-header { padding: 11px 13px; border-bottom: 1px solid rgba(255,255,255,.09); background: linear-gradient(90deg, var(--zyx-settings-header-start), var(--zyx-settings-header-end)); }
    .zyrox-config-title { color: var(--zyx-settings-text); font-size: 14px; font-weight: 700; margin-bottom: 3px; }
    .zyrox-config-sub { color: var(--zyx-settings-subtext); font-size: 12px; }
    .zyrox-config-body { padding: 13px; color: var(--zyx-settings-text); }
    .zyrox-config-row { display:flex; justify-content:space-between; align-items:center; gap:8px; color:var(--zyx-settings-text); font-size:14px; }
    .zyrox-config-actions { display: flex; align-items: center; gap: 6px; }

    /* FIX: was hardcoded rgba(255, 61, 61, ...) — now reads CSS variables set by applyAppearance() */
    .zyrox-btn {
      border: 1px solid var(--zyx-outline-color);
      background: var(--zyx-btn-bg);
      color: var(--zyx-settings-text);
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 12px;
      cursor: pointer;
    }

    .zyrox-btn:hover { background: var(--zyx-btn-hover-bg); color: #fff; }

    .zyrox-btn-square {
      width: 33px;
      height: 33px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      line-height: 1;
      font-size: 16px;
      color: var(--zyx-icon-color);
    }

    .zyrox-config-backdrop.hidden { display: none !important; }

    .zyrox-settings {
      position: relative;
      z-index: 2147483649;
      width: min(760px, 92vw);
      height: min(620px, 88vh);
      border-radius: 12px;
      border: 1px solid var(--zyx-border);
      background: var(--zyx-settings-body-bg);
      box-shadow: var(--zyx-shadow);
      overflow: hidden;
      color: var(--zyx-settings-text);
      font-family: var(--zyx-font);
      display: flex;
      flex-direction: column;
    }

    .zyrox-config {
      font-family: var(--zyx-font);
    }

    .esp-value-text {
      font-family: var(--zyx-font);
      font-size: 0.85em;
    }

    .zyrox-settings.hidden { display: none !important; }
    .zyrox-settings-header { padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,.09); background: linear-gradient(90deg, var(--zyx-settings-header-start), var(--zyx-settings-header-end)); }
    .zyrox-settings-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; color: var(--zyx-settings-text); }
    .zyrox-settings-sub { font-size: 12px; color: var(--zyx-settings-subtext); }
    .zyrox-settings-layout { display: grid; grid-template-columns: 150px 1fr; min-height: 0; flex: 1; }
    .zyrox-settings-sidebar {
      border-right: 1px solid rgba(255,255,255,.08);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--zyx-settings-sidebar-bg);
    }
    .zyrox-settings-tab {
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px;
      padding: 7px 8px;
      font-size: 12px;
      color: var(--zyx-settings-text);
      background: rgba(0,0,0,.2);
      text-align: left;
      cursor: pointer;
    }
    .zyrox-settings-tab.active {
      border-color: var(--zyx-outline-color);
      background: color-mix(in srgb, var(--zyx-topbar-bg-start) 75%, transparent);
      color: #fff;
    }
    .zyrox-settings-pane { min-height: 0; display: flex; }
    .zyrox-settings-body { padding: 14px; display: flex; flex-direction: column; gap: 8px; overflow: auto; min-height: 0; width: 100%; }
    .zyrox-settings-body::-webkit-scrollbar { width: 10px; }
    .zyrox-settings-body::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--zyx-outline-color) 70%, transparent); border-radius: 999px; }
    .zyrox-settings-pane.hidden { display: none !important; }
    .zyrox-setting-card { border: 1px solid var(--zyx-settings-card-border); border-radius: 10px; padding: 8px 10px; background: var(--zyx-settings-card-bg); display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .zyrox-setting-card label { display:block; font-size: 12px; color: var(--zyx-settings-text); margin: 0; }
    .zyrox-setting-card input[type="text"],
    .zyrox-config-body input[type="text"] {
      background: var(--zyx-input-bg);
      color: var(--zyx-input-text);
      border: 1px solid var(--zyx-settings-card-border);
      border-radius: 8px;
      padding: 6px 8px;
      min-width: 150px;
    }
    .zyrox-setting-card input[type='color'] {
      width: 52px;
      height: 30px;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 8px;
      background: transparent;
      cursor: pointer;
      overflow: hidden;
      padding: 0;
    }
    .zyrox-setting-card input[type='range'] { width: 190px; accent-color: var(--zyx-slider-color); }
    .zyrox-setting-card input[type='checkbox'] { width: 16px; height: 16px; accent-color: var(--zyx-checkmark-color); }
    .zyrox-setting-card select {
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      border: 1px solid var(--zyx-settings-card-border);
      background: var(--zyx-select-bg);
      background-image:
        linear-gradient(45deg, transparent 50%, var(--zyx-select-text) 50%),
        linear-gradient(135deg, var(--zyx-select-text) 50%, transparent 50%);
      background-position:
        calc(100% - 14px) calc(50% - 2px),
        calc(100% - 8px) calc(50% - 2px);
      background-size: 6px 6px, 6px 6px;
      background-repeat: no-repeat;
      color: var(--zyx-select-text);
      border-radius: 8px;
      padding: 6px 26px 6px 8px;
      font-size: 12px;
      min-height: 30px;
    }
    .zyrox-setting-card select:focus {
      outline: 1px solid var(--zyx-outline-color);
      outline-offset: 1px;
    }
    .zyrox-setting-card select option {
      background: var(--zyx-select-bg);
      color: var(--zyx-select-text);
    }
    .zyrox-gradient-pair { display: inline-flex; align-items: center; gap: 8px; }
    .zyrox-preset-header { font-size: 11px; text-transform: uppercase; letter-spacing: .35px; color: var(--zyx-accent-soft); margin-bottom: 4px; }
    .zyrox-preset-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 2px; }
    .zyrox-preset-btn { border: 1px solid var(--zyx-outline-color); background: rgba(0,0,0,.26); color: var(--zyx-settings-text); border-radius: 8px; padding: 6px 10px; font-size: 11px; cursor: pointer; }
    .zyrox-preset-btn .preset-swatch { display:inline-block; width:10px; height:10px; border-radius:999px; margin-right:6px; border:1px solid rgba(255,255,255,.3); vertical-align:-1px; }
    .zyrox-preset-btn:hover { background: var(--zyx-btn-hover-bg); }
    .zyrox-subheading {
      grid-column: 1 / -1;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.25px;
      color: var(--zyx-accent-soft);
      margin-top: -2px;
      margin-bottom: -4px;
    }
    .zyrox-about-content {
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 12px;
      color: var(--zyx-settings-subtext);
      line-height: 1.45;
      user-select: text;
    }
    .zyrox-about-content b {
      color: var(--zyx-settings-text);
      font-weight: 700;
    }
    .zyrox-about-source-btn {
      align-self: flex-start;
      text-decoration: none;
      margin-top: 4px;
    }
    .zyrox-settings-actions { display:flex; justify-content:space-between; align-items:flex-end; gap:8px; padding: 8px 14px 14px; }
    .zyrox-settings-actions-group { display:flex; gap:8px; }
    .zyrox-settings-action-btn {
      min-height: 31px;
      line-height: 1.1;
      white-space: nowrap;
    }
    .zyrox-close-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      border: 1px solid var(--zyx-outline-color);
      background: rgba(0, 0, 0, 0.25);
      color: var(--zyx-icon-color);
      cursor: pointer;
      line-height: 1;
      font-size: 14px;
    }

    .zyrox-resize-handle {
      position: absolute;
      right: 2px;
      bottom: 2px;
      width: 14px;
      height: 14px;
      cursor: nwse-resize;
      border-right: 2px solid rgba(255, 110, 110, 0.85);
      border-bottom: 2px solid rgba(255, 110, 110, 0.85);
      border-radius: 0 0 8px 0;
      opacity: 0.9;
    }

    /* Theme layout styles */
    .zyrox-theme-layout {
      display: grid;
      grid-template-columns: 180px 1fr;
      min-height: 0;
      height: 100%;
    }
    .zyrox-theme-sidebar {
      border-right: 1px solid rgba(255,255,255,.08);
      padding: 14px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      background: var(--zyx-settings-sidebar-bg);
      overflow-y: auto;
    }
    .zyrox-theme-sidebar::-webkit-scrollbar {
      width: 6px;
    }
    .zyrox-theme-sidebar::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--zyx-outline-color) 50%, transparent);
      border-radius: 999px;
    }
    .zyrox-theme-categories {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 100%;
    }
    .zyrox-theme-category {
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 11px;
      color: var(--zyx-settings-text);
      background: rgba(0,0,0,.2);
      text-align: left;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .zyrox-theme-category:hover {
      background: var(--zyx-btn-hover-bg);
      border-color: rgba(255,255,255,.2);
    }
    .zyrox-theme-category.active {
      border-color: var(--zyx-outline-color);
      background: color-mix(in srgb, var(--zyx-topbar-bg-start) 75%, transparent);
      color: #fff;
    }
    .zyrox-theme-content {
      padding: 14px;
      overflow-y: auto;
      min-height: 0;
    }
    .zyrox-theme-content::-webkit-scrollbar {
      width: 10px;
    }
    .zyrox-theme-content::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--zyx-outline-color) 70%, transparent);
      border-radius: 999px;
    }
    .zyrox-theme-section {
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .zyrox-theme-section.active {
      display: flex;
    }
  `;

  const root = document.createElement("div");
  root.className = "zyrox-root";

  const shell = document.createElement("div");
  shell.className = "zyrox-shell";

  const topbar = document.createElement("div");
  topbar.className = "zyrox-topbar";
  topbar.innerHTML = `
    <div class="zyrox-brand">
      <img class="zyrox-logo" src="${CONFIG.logoUrl}" alt="Zyrox logo" />
      <div>
        <div class="title">${CONFIG.title}</div>
        <div class="subtitle">${CONFIG.subtitle}</div>
      </div>
    </div>
    <div class="zyrox-collapse-row"></div>
    <div class="zyrox-topbar-right">
      <input class="zyrox-search" type="text" placeholder="Search utilities..." autocomplete="off" />
      <button class="zyrox-settings-btn" type="button" title="Open client settings">⚙</button>
      <span class="zyrox-chip">v${CONFIG.version}</span>
    </div>
  `;

  const searchInput = topbar.querySelector(".zyrox-search");
  const settingsBtn = topbar.querySelector(".zyrox-settings-btn");
  const collapseRow = topbar.querySelector(".zyrox-collapse-row");

  const generalSection = document.createElement("section");
  generalSection.className = "zyrox-section";
  generalSection.innerHTML = `<div class="zyrox-section-label">General</div>`;

  const gamemodeSection = document.createElement("section");
  gamemodeSection.className = "zyrox-section";
  gamemodeSection.innerHTML = `<div class="zyrox-section-label">Gamemode Specific</div>`;

  const footer = document.createElement("div");
  footer.className = "zyrox-footer";
  setFooterText();

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "zyrox-resize-handle";

  const configMenu = document.createElement("div");
  configMenu.className = "zyrox-config hidden";
  configMenu.innerHTML = `
    <div class="zyrox-config-header">
      <div class="zyrox-config-title">Module Config</div>
      <div class="zyrox-config-sub">Configure this module.</div>
    </div>
    <button class="zyrox-close-btn config-close-btn" type="button" title="Close">✕</button>
    <div class="zyrox-config-body">
      <div class="zyrox-config-row">
        <span>Keybind</span>
        <div class="zyrox-config-actions">
          <button class="zyrox-btn zyrox-btn-square" type="button" title="Reset keybind">↺</button>
          <button class="zyrox-btn" type="button">Set keybind</button>
        </div>
      </div>
    </div>
  `;

  const configBackdrop = document.createElement("div");
  configBackdrop.className = "zyrox-config-backdrop hidden";
  configBackdrop.appendChild(configMenu);

  const settingsMenu = document.createElement("div");
  settingsMenu.className = "zyrox-settings hidden";
  settingsMenu.innerHTML = `
    <div class="zyrox-settings-header">
      <div class="zyrox-settings-title">Client Settings</div>
      <div class="zyrox-settings-sub">Customize colors and appearance</div>
    </div>
    <button class="zyrox-close-btn settings-close-top" type="button" title="Close">✕</button>
    <div class="zyrox-settings-layout">
      <div class="zyrox-settings-sidebar">
        <button class="zyrox-settings-tab active" type="button" data-tab="controls">Controls</button>
        <button class="zyrox-settings-tab" type="button" data-tab="theme">Theme</button>
        <button class="zyrox-settings-tab" type="button" data-tab="appearance">Appearance</button>
        <button class="zyrox-settings-tab" type="button" data-tab="about">About</button>
      </div>
      <div class="zyrox-settings-pane" data-pane="controls">
        <div class="zyrox-settings-body">
          <div class="zyrox-subheading">Menu</div>
          <div class="zyrox-setting-card">
            <label>Menu Toggle Key</label>
            <button class="zyrox-keybind-btn settings-menu-key" type="button">Menu Key: ${CONFIG.toggleKey}</button>
            <button class="zyrox-btn zyrox-btn-square settings-menu-key-reset" type="button" title="Reset menu key">↺</button>
          </div>
          <div class="zyrox-subheading">Search</div>
          <div class="zyrox-setting-card">
            <label>Auto Focus Search</label>
            <input type="checkbox" class="set-search-autofocus" checked />
          </div>
          <div class="zyrox-setting-card">
            <label>Hide Non-Working Modules</label>
            <input type="checkbox" class="set-hide-broken-modules" checked />
          </div>
        </div>
      </div>
      <div class="zyrox-settings-pane hidden" data-pane="theme">
        <div class="zyrox-settings-body">
          <div class="zyrox-subheading">Presets</div>
          <div class="zyrox-preset-row" style="margin-bottom: 14px;">
            <button type="button" class="zyrox-preset-btn" data-preset="default"><span class="preset-swatch" style="background:#ff3d3d"></span>Default</button>
            <button type="button" class="zyrox-preset-btn" data-preset="green"><span class="preset-swatch" style="background:#2dff75"></span>Green</button>
            <button type="button" class="zyrox-preset-btn" data-preset="ice"><span class="preset-swatch" style="background:#6cd8ff"></span>Ice</button>
            <button type="button" class="zyrox-preset-btn" data-preset="grayscale"><span class="preset-swatch" style="background:#bfbfbf"></span>Greyscale</button>
          </div>
          <div class="zyrox-subheading">Display Mode</div>
          <div class="zyrox-settings-actions-group" style="margin-bottom: 14px; margin-top: 8px;">
            <button class="zyrox-btn set-display-mode active" data-display-mode="merged" type="button">Merged</button>
            <button class="zyrox-btn set-display-mode" data-display-mode="loose" type="button">Loose</button>
          </div>
        </div>
      </div>
      <div class="zyrox-settings-pane hidden" data-pane="appearance">
        <div class="zyrox-settings-body">
          <div class="zyrox-subheading">Layout & Sizing</div>
          <div class="zyrox-setting-card">
            <label>UI Scale</label>
            <input type="range" class="set-scale" min="80" max="130" value="100" />
          </div>
          <div class="zyrox-setting-card">
            <label>Corner Radius</label>
            <input type="range" class="set-radius" min="6" max="20" value="14" />
          </div>
          <div class="zyrox-setting-card">
            <label>Panel Blur</label>
            <input type="range" class="set-blur" min="0" max="16" value="10" />
          </div>
          <div class="zyrox-subheading">Motion</div>
          <div class="zyrox-setting-card">
            <label>Module Hover Shift</label>
            <input type="range" class="set-hover-shift" min="0" max="6" value="2" />
          </div>
          <div class="zyrox-subheading">Main Window</div>
              <div class="zyrox-setting-card">
                <label>Accent Color</label>
                <input type="color" class="set-accent" value="#ff3d3d" />
              </div>
              <div class="zyrox-setting-card">
                <label>Background Gradient</label>
                <span class="zyrox-gradient-pair">
                  <input type="color" class="set-shell-bg-start" value="#ff3d3d" />
                  <input type="color" class="set-shell-bg-end" value="#000000" />
                </span>
              </div>
              <div class="zyrox-setting-card">
                <label>Top Bar Color</label>
                <input type="color" class="set-topbar-color" value="#ff4a4a" />
              </div>
              <div class="zyrox-setting-card">
                <label>Text Color</label>
                <input type="color" class="set-text" value="#d6d6df" />
              </div>
              <div class="zyrox-setting-card">
                <label>Panel Border</label>
                <input type="color" class="set-border" value="#ff6f6f" />
              </div>
              <div class="zyrox-setting-card">
                <label>Background Opacity</label>
                <input type="range" class="set-opacity" min="20" max="100" value="45" />
              </div>
          <div class="zyrox-subheading">Buttons & Inputs</div>
              <div class="zyrox-setting-card">
                <label>Outline Color</label>
                <input type="color" class="set-outline-color" value="#ff5b5b" />
              </div>
              <div class="zyrox-setting-card">
                <label>Slider Color</label>
                <input type="color" class="set-slider-color" value="#ff6b6b" />
              </div>
              <div class="zyrox-setting-card">
                <label>Checkmark Color</label>
                <input type="color" class="set-checkmark-color" value="#ff6b6b" />
              </div>
              <div class="zyrox-setting-card">
                <label>Dropdown Background</label>
                <input type="color" class="set-select-bg" value="#17171f" />
              </div>
              <div class="zyrox-setting-card">
                <label>Dropdown Text</label>
                <input type="color" class="set-select-text" value="#ffe5e5" />
              </div>
              <div class="zyrox-setting-card">
                <label>Text Input Background</label>
                <input type="color" class="set-input-bg" value="#17171f" />
              </div>
              <div class="zyrox-setting-card">
                <label>Text Input Text</label>
                <input type="color" class="set-input-text" value="#ffe5e5" />
              </div>
          <div class="zyrox-subheading">Typography</div>
              <div class="zyrox-setting-card">
                <label>Font Family</label>
                <select class="set-font">
                  <option value="Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" selected>Inter (Default)</option>
                  <option value="JetBrains Mono, 'Courier New', monospace">JetBrains Mono</option>
                  <option value="'Segoe UI', Tahoma, Geneva, Verdana, sans-serif">Segoe UI</option>
                  <option value="Roboto, 'Helvetica Neue', Arial, sans-serif">Roboto</option>
                  <option value="'Open Sans', 'Helvetica Neue', Arial, sans-serif">Open Sans</option>
                  <option value="'Fira Code', 'Courier New', monospace">Fira Code</option>
                  <option value="Poppins, 'Helvetica Neue', Arial, sans-serif">Poppins</option>
                </select>
              </div>
              <div class="zyrox-setting-card">
                <label>Muted Text</label>
                <input type="color" class="set-muted-text" value="#9b9bab" />
              </div>
              <div class="zyrox-setting-card">
                <label>Label Accent</label>
                <input type="color" class="set-accent-soft" value="#ffbdbd" />
              </div>
              <div class="zyrox-setting-card">
                <label>Search Text</label>
                <input type="color" class="set-search-text" value="#ffe6e6" />
              </div>
          <div class="zyrox-subheading">Icons & Badges</div>
              <div class="zyrox-setting-card">
                <label>Icon Color</label>
                <input type="color" class="set-icon-color" value="#ffdada" />
              </div>
              <div class="zyrox-setting-card">
                <label>Panel Count Text</label>
                <input type="color" class="set-panel-count-text" value="#ffd9d9" />
              </div>
              <div class="zyrox-setting-card">
                <label>Panel Count Border</label>
                <input type="color" class="set-panel-count-border" value="#ff6464" />
              </div>
              <div class="zyrox-setting-card">
                <label>Panel Count Background</label>
                <input type="color" class="set-panel-count-bg" value="#1a1a1e" />
              </div>
          <div class="zyrox-subheading">Panels & Modules</div>
              <div class="zyrox-setting-card">
                <label>Module Bar Gradient</label>
                <span class="zyrox-gradient-pair">
                  <input type="color" class="set-header-start" value="#ff4a4a" />
                  <input type="color" class="set-header-end" value="#3c1212" />
                </span>
              </div>
              <div class="zyrox-setting-card">
                <label>Module Bar Text</label>
                <input type="color" class="set-header-text" value="#ffffff" />
              </div>
          <div class="zyrox-subheading">Settings Menu</div>
              <div class="zyrox-setting-card">
                <label>Settings Header Gradient</label>
                <span class="zyrox-gradient-pair">
                  <input type="color" class="set-settings-header-start" value="#ff3d3d" />
                  <input type="color" class="set-settings-header-end" value="#2d0c0c" />
                </span>
              </div>
              <div class="zyrox-setting-card">
                <label>Settings Sidebar Tint</label>
                <input type="color" class="set-settings-sidebar" value="#181820" />
              </div>
              <div class="zyrox-setting-card">
                <label>Settings Body Tint</label>
                <input type="color" class="set-settings-body" value="#121216" />
              </div>
              <div class="zyrox-setting-card">
                <label>Settings Text Color</label>
                <input type="color" class="set-settings-text" value="#ffe5e5" />
              </div>
              <div class="zyrox-setting-card">
                <label>Settings Subtext Color</label>
                <input type="color" class="set-settings-subtext" value="#c2c2ce" />
              </div>
              <div class="zyrox-setting-card">
                <label>Settings Card Border</label>
                <input type="color" class="set-settings-card-border" value="#ffffff" />
              </div>
              <div class="zyrox-setting-card">
                <label>Settings Card Background</label>
                <input type="color" class="set-settings-card-bg" value="#ffffff" />
              </div>
              <div class="zyrox-setting-card">
                <label>ESP Value Text Color</label>
                <input type="color" class="set-esp-value-text-color" value="#ffffff" />
              </div>
        </div>
      </div>
      <div class="zyrox-settings-pane hidden" data-pane="about">
        <div class="zyrox-settings-body">
          <div class="zyrox-subheading">Client Info</div>
          <div class="zyrox-setting-card">
            <div class="zyrox-about-content">
              <div><b>Zyrox Client</b> is a custom opensource userscript hacked client for Gimkit with module toggles, keybinds, and theming controls.</div>
              <div>We are not responsible for any bans, account issues, data loss, or damages that may result from using this client. Use it at your own risk.</div>
              <div>Version: ${CONFIG.version}</div>
              <a
                class="zyrox-btn zyrox-about-source-btn"
                href="https://github.com/Bob-alt-828100/zyrox-gimkit-client"
                target="_blank"
                rel="noopener noreferrer"
              >View Source Code</a>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="zyrox-settings-actions">
      <div class="zyrox-settings-actions-group" style="flex-direction:column;gap:5px;align-items:flex-start;">
        <button class="zyrox-btn zyrox-settings-action-btn settings-reset" type="button">Reset Appearance</button>
        <button class="zyrox-btn zyrox-settings-action-btn settings-reset-all" type="button" style="opacity:0.8;">Reset All</button>
      </div>
      <div class="zyrox-settings-actions-group">
        <button class="zyrox-btn settings-save" type="button">Save</button>
        <button class="zyrox-btn settings-close" type="button">Close</button>
      </div>
    </div>
  `;
  configBackdrop.appendChild(settingsMenu);

  function absorbMenuInputEvents(node) {
    if (!node) return;
    const block = (event) => {
      event.stopPropagation();
    };
    ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"].forEach((type) => {
      node.addEventListener(type, block, false);
    });
  }
  absorbMenuInputEvents(root);
  absorbMenuInputEvents(configBackdrop);
  absorbMenuInputEvents(configMenu);
  absorbMenuInputEvents(settingsMenu);

  const configTitleEl = configMenu.querySelector(".zyrox-config-title");
  const configSubEl = configMenu.querySelector(".zyrox-config-sub");
  const configCloseBtn = configMenu.querySelector(".config-close-btn");
  const settingsTabs = [...settingsMenu.querySelectorAll(".zyrox-settings-tab")];
  const settingsPanes = [...settingsMenu.querySelectorAll(".zyrox-settings-pane")];
  const configBody = configMenu.querySelector(".zyrox-config-body");
  // Backward-compat alias for legacy code paths that still reference this identifier.
  const setBindButtonEl = configMenu.querySelector(".set-bind-btn");
  const settingsMenuKeyBtn = settingsMenu.querySelector(".settings-menu-key");
  const settingsMenuKeyResetBtn = settingsMenu.querySelector(".settings-menu-key-reset");
  const settingsTopCloseBtn = settingsMenu.querySelector(".settings-close-top");
  const settingsSaveBtn = settingsMenu.querySelector(".settings-save");
  const presetButtons = [...settingsMenu.querySelectorAll(".zyrox-preset-btn")];
  const searchAutofocusInput = settingsMenu.querySelector(".set-search-autofocus");
  const hideBrokenModulesInput = settingsMenu.querySelector(".set-hide-broken-modules");
  const accentInput = settingsMenu.querySelector(".set-accent");
  const shellBgStartInput = settingsMenu.querySelector(".set-shell-bg-start");
  const shellBgEndInput = settingsMenu.querySelector(".set-shell-bg-end");
  const topbarColorInput = settingsMenu.querySelector(".set-topbar-color");
  const iconColorInput = settingsMenu.querySelector(".set-icon-color");
  const outlineColorInput = settingsMenu.querySelector(".set-outline-color");
  const panelCountTextInput = settingsMenu.querySelector(".set-panel-count-text");
  const panelCountBorderInput = settingsMenu.querySelector(".set-panel-count-border");
  const panelCountBgInput = settingsMenu.querySelector(".set-panel-count-bg");
  const borderInput = settingsMenu.querySelector(".set-border");
  const textInput = settingsMenu.querySelector(".set-text");
  const opacityInput = settingsMenu.querySelector(".set-opacity");
  const sliderColorInput = settingsMenu.querySelector(".set-slider-color");
  const checkmarkColorInput = settingsMenu.querySelector(".set-checkmark-color");
  const selectBgInput = settingsMenu.querySelector(".set-select-bg");
  const selectTextInput = settingsMenu.querySelector(".set-select-text");
  const inputBgInput = settingsMenu.querySelector(".set-input-bg");
  const inputTextInput = settingsMenu.querySelector(".set-input-text");
  const mutedTextInput = settingsMenu.querySelector(".set-muted-text");
  const accentSoftInput = settingsMenu.querySelector(".set-accent-soft");
  const searchTextInput = settingsMenu.querySelector(".set-search-text");
  const fontInput = settingsMenu.querySelector(".set-font");
  const headerStartInput = settingsMenu.querySelector(".set-header-start");
  const headerEndInput = settingsMenu.querySelector(".set-header-end");
  const headerTextInput = settingsMenu.querySelector(".set-header-text");
  const settingsHeaderStartInput = settingsMenu.querySelector(".set-settings-header-start");
  const settingsHeaderEndInput = settingsMenu.querySelector(".set-settings-header-end");
  const settingsSidebarInput = settingsMenu.querySelector(".set-settings-sidebar");
  const settingsBodyInput = settingsMenu.querySelector(".set-settings-body");
  const settingsTextInput = settingsMenu.querySelector(".set-settings-text");
  const settingsSubtextInput = settingsMenu.querySelector(".set-settings-subtext");
  const settingsCardBorderInput = settingsMenu.querySelector(".set-settings-card-border");
  const settingsCardBgInput = settingsMenu.querySelector(".set-settings-card-bg");
  const espValueTextColorInput = settingsMenu.querySelector(".set-esp-value-text-color");
  const scaleInput = settingsMenu.querySelector(".set-scale");
  const radiusInput = settingsMenu.querySelector(".set-radius");
  const blurInput = settingsMenu.querySelector(".set-blur");
  const hoverShiftInput = settingsMenu.querySelector(".set-hover-shift");
  const displayModeButtons = [...settingsMenu.querySelectorAll(".set-display-mode")];
  const settingsResetBtn = settingsMenu.querySelector(".settings-reset");
  const settingsResetAllBtn = settingsMenu.querySelector(".settings-reset-all");
  const settingsCloseBtn = settingsMenu.querySelector(".settings-close");
  const panelByName = new Map();
  const panelCollapseButtons = new Map();
  let openConfigModule = null;
  let currentSetBindBtn = null;
  let currentResetBindBtn = null;
  let currentBindTextEl = null;

  function setBindButtonText(text) {
    const bindButton = currentSetBindBtn || setBindButtonEl || configMenu.querySelector(".set-bind-btn");
    if (bindButton) bindButton.textContent = text;
  }

  function setFooterText() {
    footer.innerHTML = DEFAULT_FOOTER_HTML();
  }

  function setCurrentBindText(bind) {
    if (!currentBindTextEl) return;
    currentBindTextEl.textContent = bind ? `Keybind: ${bind}` : "Keybind: none";
  }

  function isModuleHiddenByWorkState(moduleName) {
    return state.hideBrokenModules && !WORKING_MODULES.has(moduleName);
  }

  function getModuleLayoutConfig(moduleName) {
    const allGroups = [...MENU_LAYOUT.general.groups, ...MENU_LAYOUT.gamemodeSpecific.groups];
    const found = allGroups
      .flatMap((group) => group.modules || [])
      .find((mod) => typeof mod === "object" && mod && mod.name === moduleName);
    return found || null;
  }

  function getModuleDescription(moduleName) {
    const layout = getModuleLayoutConfig(moduleName);
    if (layout?.description) return layout.description;
    return MODULE_DESCRIPTIONS[moduleName] || "Configure this module.";
  }

  function ensureModuleConfigStore() {
    if (state.moduleConfig instanceof Map) return state.moduleConfig;

    const recovered = new Map();
    if (state.moduleConfig && typeof state.moduleConfig === "object") {
      for (const [moduleName, cfg] of Object.entries(state.moduleConfig)) {
        if (cfg && typeof cfg === "object") {
          recovered.set(moduleName, { keybind: cfg.keybind || null });
        }
      }
    }
    state.moduleConfig = recovered;
    return state.moduleConfig;
  }

  function moduleCfg(name) {
    const store = ensureModuleConfigStore();
    if (!store.has(name)) {
      const layout = getModuleLayoutConfig(name);
      const settings = {};
      if (layout && Array.isArray(layout.settings)) {
        for (const setting of layout.settings) {
          settings[setting.id] = setting.default ?? setting.min ?? 0;
        }
      }
      store.set(name, { keybind: null, ...settings });
    }
    const cfg = store.get(name);
    if (name === "ESP") {
      window.__zyroxEspConfig = { ...getEspRenderConfig(), ...cfg };
    } else if (name === "Triggerbot (Autoshoot)") {
      window.__zyroxTriggerAssistConfig = { ...getTriggerAssistConfig(), ...cfg };
    } else if (name === "Aimbot") {
      window.__zyroxAutoAimConfig = { ...getAutoAimConfig(), ...cfg };
    }
    return cfg;
  }

  function setBindLabel(item, moduleName) {
    const label = item.querySelector(".zyrox-bind-label");
    const bind = moduleCfg(moduleName).keybind;
    label.textContent = bind || "";
    label.style.display = bind ? "" : "none";
  }

  function toggleModule(moduleName) {
    if (isModuleHiddenByWorkState(moduleName)) return;
    const item = state.moduleItems.get(moduleName);
    const moduleInstance = state.modules.get(moduleName);
    if (!item || !moduleInstance) return;

    if (moduleInstance.enabled) {
      moduleInstance.disable();
      item.classList.remove("active");
      state.enabledModules.delete(moduleName);
      if (moduleName === "Auto Answer") stopAutoAnswer();
    } else {
      moduleInstance.enable();
      item.classList.add("active");
      state.enabledModules.add(moduleName);
      if (moduleName === "Auto Answer") startAutoAnswer();
    }
    saveSettings();
  }

  // ---------------------------------------------------------------------------
  // AUTO-ANSWER MODULE CONTROLS
  // The actual logic runs in page context (injected above).
  // These functions just start/stop the interval via window.__zyroxAutoAnswer.
  // ---------------------------------------------------------------------------
  function stopAutoAnswer() {
    window.__zyroxAutoAnswer?.stop();
  }

  function startAutoAnswer() {
    const cfg = moduleCfg("Auto Answer");
    const speed = Math.max(200, Number(cfg.speed) || 1000);
    window.__zyroxAutoAnswer?.start(speed);
  }

  function refreshAutoAnswerLoopIfEnabled() {
    if (state.enabledModules.has("Auto Answer")) startAutoAnswer();
  }

  function getAnswerPopupConfig() {
    const cfg = moduleCfg("Answer Popup");
    return {
      title: String(cfg.title ?? "Draw It Answer"),
      prefix: String(cfg.prefix ?? "Answer:"),
      durationMs: Math.max(400, Number(cfg.durationMs) || 2600),
      background: String(cfg.background ?? "#121525"),
      accent: String(cfg.accent ?? "#00e5ff"),
      textColor: String(cfg.textColor ?? "#ffffff"),
    };
  }

  function ensureAnswerPopupContainer() {
    if (answerPopupState.container?.isConnected) return answerPopupState.container;
    const popup = document.createElement("div");
    popup.className = "zyrox-answer-popup";
    popup.style.cssText = [
      "position:fixed",
      "left:50%",
      "top:92px",
      "transform:translate(-50%, -18px)",
      "min-width:260px",
      "max-width:min(86vw,640px)",
      "padding:12px 14px",
      "border-radius:12px",
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif",
      "z-index:2147483647",
      "opacity:0",
      "pointer-events:none",
      "transition:opacity .18s ease, transform .18s ease",
      "box-shadow:0 14px 34px rgba(0,0,0,.45)",
      "border:1px solid rgba(255,255,255,.14)",
      "display:none",
      "white-space:normal",
      "overflow-wrap:anywhere",
    ].join(";");
    document.documentElement.appendChild(popup);
    answerPopupState.container = popup;
    return popup;
  }

  function showAnswerPopup(answerText) {
    if (!answerPopupState.enabled) return;
    const answer = String(answerText || "").trim();
    if (!answer) return;
    const now = Date.now();
    if (answer === answerPopupState.lastAnswer && now - answerPopupState.lastShownAt < 700) return;
    answerPopupState.lastAnswer = answer;
    answerPopupState.lastShownAt = now;

    const popup = ensureAnswerPopupContainer();
    const cfg = getAnswerPopupConfig();
    popup.style.background = cfg.background;
    popup.style.color = cfg.textColor;
    popup.style.borderLeft = `4px solid ${cfg.accent}`;
    popup.innerHTML = `
      <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.75;margin-bottom:4px;">${cfg.title}</div>
      <div style="font-size:16px;font-weight:700;line-height:1.25;">${cfg.prefix} <span style="color:${cfg.accent};">${answer}</span></div>
    `;

    popup.style.display = "block";
    popup.style.opacity = "1";
    popup.style.transform = "translate(-50%, 0)";
    if (answerPopupState.timeoutId) clearTimeout(answerPopupState.timeoutId);
    answerPopupState.timeoutId = setTimeout(() => {
      popup.style.opacity = "0";
      popup.style.transform = "translate(-50%, -18px)";
      setTimeout(() => {
        if (popup.style.opacity === "0") popup.style.display = "none";
      }, 180);
    }, cfg.durationMs);
  }

  function extractDrawItAnswerCandidates(stateUpdateData) {
    const rows = Array.isArray(stateUpdateData) ? stateUpdateData : [stateUpdateData];
    const answers = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || !Array.isArray(row.value)) continue;
      for (const item of row.value) {
        const directKey = item?.key;
        const nestedKey = item?.value?.key;
        const fieldKey = directKey ?? nestedKey;
        const directValue = item?.value;
        const nestedValue = item?.value?.value;
        const fieldValue = typeof nestedValue === "undefined" ? directValue : nestedValue;
        if (fieldKey !== "term" || typeof fieldValue !== "string") continue;
        const answer = fieldValue.trim();
        if (answer) answers.push(answer);
      }
    }
    return answers;
  }

  function startAnswerPopup() {
    answerPopupState.enabled = true;
  }

  function stopAnswerPopup() {
    answerPopupState.enabled = false;
    if (answerPopupState.timeoutId) {
      clearTimeout(answerPopupState.timeoutId);
      answerPopupState.timeoutId = null;
    }
    if (answerPopupState.container) {
      answerPopupState.container.style.opacity = "0";
      answerPopupState.container.style.display = "none";
    }
  }

  function closeConfig() {
    configBackdrop.classList.add("hidden");
    configMenu.classList.add("hidden");
    settingsMenu.classList.add("hidden");
    openConfigModule = null;
    currentBindTextEl = null;
    state.listeningForBind = null;
    setBindButtonText("Set keybind");
  }

  function openConfig(moduleName) {
    openConfigModule = moduleName;
    const cfg = moduleCfg(moduleName);
    const moduleLayout = getModuleLayoutConfig(moduleName);

    configBody.innerHTML = `
      <div class="zyrox-config-row">
        <span class="zyrox-keybind-current">Keybind: ${cfg.keybind || "none"}</span>
        <div class="zyrox-config-actions">
          <button class="zyrox-btn zyrox-btn-square reset-bind-btn" type="button" title="Reset keybind">↺</button>
          <button class="zyrox-btn set-bind-btn" type="button">Set keybind</button>
        </div>
      </div>
    `;

    currentResetBindBtn = configMenu.querySelector(".reset-bind-btn");
    currentSetBindBtn = configMenu.querySelector(".set-bind-btn");
    currentBindTextEl = configMenu.querySelector(".zyrox-keybind-current");

    if (currentSetBindBtn) {
      currentSetBindBtn.addEventListener("click", () => {
        if (!openConfigModule) return;
        state.listeningForBind = openConfigModule;
        setBindButtonText("Press any key...");
      });
    }

    if (currentResetBindBtn) {
      currentResetBindBtn.addEventListener("click", () => {
        if (!openConfigModule) return;
        const activeCfg = moduleCfg(openConfigModule);
        activeCfg.keybind = null;
        const item = state.moduleItems.get(openConfigModule);
        if (item) setBindLabel(item, openConfigModule);
        setCurrentBindText(null);
        state.listeningForBind = null;
        setBindButtonText("Set keybind");
        saveSettings();
      });
    }

    if (moduleName === "ESP") {
      const defaults = getEspRenderConfig();
      Object.assign(cfg, { ...defaults, ...cfg });
      window.__zyroxEspConfig = { ...cfg };

      const tabButtons = document.createElement("div");
      tabButtons.style.display = "flex";
      tabButtons.style.gap = "8px";
      tabButtons.style.marginBottom = "8px";
      const enemiesTabBtn = document.createElement("button");
      enemiesTabBtn.className = "zyrox-btn";
      enemiesTabBtn.type = "button";
      enemiesTabBtn.textContent = "Enemies";
      const teammatesTabBtn = document.createElement("button");
      teammatesTabBtn.className = "zyrox-btn";
      teammatesTabBtn.type = "button";
      teammatesTabBtn.textContent = "Teammates";
      tabButtons.append(enemiesTabBtn, teammatesTabBtn);
      configBody.appendChild(tabButtons);

      const enemiesPane = document.createElement("div");
      enemiesPane.style.display = "flex";
      enemiesPane.style.flexDirection = "column";
      enemiesPane.style.gap = "8px";
      const teammatesPane = document.createElement("div");
      teammatesPane.style.display = "none";
      teammatesPane.style.flexDirection = "column";
      teammatesPane.style.gap = "8px";
      configBody.append(enemiesPane, teammatesPane);

      const setEspTab = (tab) => {
        const isEnemies = tab !== "teammates";
        enemiesPane.style.display = isEnemies ? "flex" : "none";
        teammatesPane.style.display = isEnemies ? "none" : "flex";
        enemiesTabBtn.style.opacity = isEnemies ? "1" : "0.65";
        teammatesTabBtn.style.opacity = isEnemies ? "0.65" : "1";
      };
      enemiesTabBtn.addEventListener("click", () => setEspTab("enemies"));
      teammatesTabBtn.addEventListener("click", () => setEspTab("teammates"));
      setEspTab("enemies");

      const makeRow = (container, title, html) => {
        const row = document.createElement("div");
        row.className = "zyrox-setting-card";
        row.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:8px;width:100%;">
            <label style="font-weight:600;">${title}</label>
            ${html}
          </div>
        `;
        container.appendChild(row);
        return row;
      };

      const enemyFilterRow = makeRow(enemiesPane, "Enemy Visibility", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="esp-show-enemies" ${cfg.showEnemies !== false ? "checked" : ""} />
            Show enemies
          </label>
        </div>
      `);

      const hitboxRow = makeRow(enemiesPane, "Hitbox", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-hitbox-enabled" ${cfg.hitbox ? "checked" : ""} /> Enabled</label>
          <label>Size <input type="range" class="esp-hitbox-size" min="24" max="270" step="2" value="${cfg.hitboxSize}" /></label>
          <span class="esp-hitbox-size-value esp-value-text">${cfg.hitboxSize}px</span>
          <label>Width <input type="range" class="esp-hitbox-width" min="1" max="10" step="1" value="${cfg.hitboxWidth}" /></label>
          <span class="esp-hitbox-width-value esp-value-text">${cfg.hitboxWidth}px</span>
          <input type="color" class="esp-hitbox-color" value="${cfg.hitboxColor}" />
        </div>
      `);

      const namesRow = makeRow(enemiesPane, "Names", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-name-show-name" ${resolveNameDistanceVisibility(cfg, false).showName ? "checked" : ""} /> Name</label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-name-show-distance" ${resolveNameDistanceVisibility(cfg, false).showDistance ? "checked" : ""} /> Distance</label>
          <label>Size <input type="range" class="esp-name-size" min="10" max="32" step="1" value="${cfg.nameSize}" /></label>
          <span class="esp-name-size-value esp-value-text">${cfg.nameSize}px</span>
          <input type="color" class="esp-name-color" value="${cfg.nameColor}" />
          <label>Distance Style
            <select class="esp-name-distance-style">
              <option value="dot" ${cfg.nameDistanceStyle === "dot" ? "selected" : ""}>Name • 120m</option>
              <option value="dash" ${cfg.nameDistanceStyle === "dash" ? "selected" : ""}>Name - 120m</option>
              <option value="pipe" ${cfg.nameDistanceStyle === "pipe" ? "selected" : ""}>Name | 120m</option>
              <option value="paren" ${cfg.nameDistanceStyle === "paren" ? "selected" : ""}>Name (120m)</option>
              <option value="distanceFirst" ${cfg.nameDistanceStyle === "distanceFirst" ? "selected" : ""}>120m • Name</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-name-outline-enabled" ${cfg.nameOutline !== false ? "checked" : ""} /> Outline</label>
          <label>Outline Width <input type="range" class="esp-name-outline-width" min="1" max="6" step="1" value="${cfg.nameOutlineWidth}" /></label>
          <span class="esp-name-outline-width-value esp-value-text">${cfg.nameOutlineWidth}px</span>
          <input type="color" class="esp-name-outline-color" value="${cfg.nameOutlineColor || "#000000"}" />
        </div>
      `);

      const offscreenRow = makeRow(enemiesPane, "Off-screen", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label>Mode
            <select class="esp-offscreen-style">
              <option value="none" ${cfg.offscreenStyle === "none" ? "selected" : ""}>None</option>
              <option value="tracers" ${cfg.offscreenStyle === "tracers" ? "selected" : ""}>Tracers</option>
              <option value="arrows" ${cfg.offscreenStyle === "arrows" ? "selected" : ""}>Arrows</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="esp-always-tracer" ${cfg.alwaysTracer ? "checked" : ""} />
            Always Show Tracer
          </label>
          <label>Theme
            <select class="esp-offscreen-theme">
              <option value="classic" ${cfg.offscreenTheme === "classic" ? "selected" : ""}>Classic</option>
              <option value="dashed" ${cfg.offscreenTheme === "dashed" ? "selected" : ""}>Dashed</option>
              <option value="neon" ${cfg.offscreenTheme === "neon" ? "selected" : ""}>Neon</option>
            </select>
          </label>
          <span class="esp-tracer-controls" style="display:flex;align-items:center;gap:10px;">
            <label>Tracer Width <input type="range" class="esp-tracer-width" min="1" max="8" step="1" value="${cfg.tracerWidth}" /></label>
            <span class="esp-tracer-width-value esp-value-text">${cfg.tracerWidth}px</span>
            <input type="color" class="esp-tracer-color" value="${cfg.tracerColor}" />
          </span>
          <span class="esp-arrow-controls" style="display:flex;align-items:center;gap:10px;">
            <label>Arrow Size <input type="range" class="esp-arrow-size" min="8" max="30" step="1" value="${cfg.arrowSize}" /></label>
            <span class="esp-arrow-size-value esp-value-text">${cfg.arrowSize}px</span>
            <input type="color" class="esp-arrow-color" value="${cfg.arrowColor}" />
            <label>Arrow Style
              <select class="esp-arrow-style">
                <option value="regular" ${cfg.arrowStyle === "regular" ? "selected" : ""}>Regular Arrow</option>
                <option value="dot" ${cfg.arrowStyle === "dot" ? "selected" : ""}>Dot</option>
                <option value="modern" ${cfg.arrowStyle === "modern" ? "selected" : ""}>Modern Arrow</option>
              </select>
            </label>
          </span>
        </div>
      `);

      const teammateFilterRow = makeRow(teammatesPane, "Teammate Visibility", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="esp-show-teammates" ${cfg.showTeammates !== false ? "checked" : ""} />
            Show teammates
          </label>
        </div>
      `);

      const teammateHitboxRow = makeRow(teammatesPane, "Hitbox", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-teammate-hitbox-enabled" ${cfg.teammateHitbox ? "checked" : ""} /> Enabled</label>
          <label>Size <input type="range" class="esp-teammate-hitbox-size" min="24" max="270" step="2" value="${cfg.teammateHitboxSize}" /></label>
          <span class="esp-teammate-hitbox-size-value esp-value-text">${cfg.teammateHitboxSize}px</span>
          <label>Width <input type="range" class="esp-teammate-hitbox-width" min="1" max="10" step="1" value="${cfg.teammateHitboxWidth}" /></label>
          <span class="esp-teammate-hitbox-width-value esp-value-text">${cfg.teammateHitboxWidth}px</span>
          <input type="color" class="esp-teammate-hitbox-color" value="${cfg.teammateHitboxColor || "#36d17c"}" />
        </div>
      `);

      const teammateNamesRow = makeRow(teammatesPane, "Names", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-teammate-name-show-name" ${resolveNameDistanceVisibility(cfg, true).showName ? "checked" : ""} /> Name</label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-teammate-name-show-distance" ${resolveNameDistanceVisibility(cfg, true).showDistance ? "checked" : ""} /> Distance</label>
          <label>Size <input type="range" class="esp-teammate-name-size" min="10" max="32" step="1" value="${cfg.teammateNameSize}" /></label>
          <span class="esp-teammate-name-size-value esp-value-text">${cfg.teammateNameSize}px</span>
          <input type="color" class="esp-teammate-name-color" value="${cfg.teammateNameColor || "#baf7d2"}" />
          <label>Distance Style
            <select class="esp-teammate-name-distance-style">
              <option value="dot" ${cfg.teammateNameDistanceStyle === "dot" ? "selected" : ""}>Name • 120m</option>
              <option value="dash" ${cfg.teammateNameDistanceStyle === "dash" ? "selected" : ""}>Name - 120m</option>
              <option value="pipe" ${cfg.teammateNameDistanceStyle === "pipe" ? "selected" : ""}>Name | 120m</option>
              <option value="paren" ${cfg.teammateNameDistanceStyle === "paren" ? "selected" : ""}>Name (120m)</option>
              <option value="distanceFirst" ${cfg.teammateNameDistanceStyle === "distanceFirst" ? "selected" : ""}>120m • Name</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-teammate-name-outline-enabled" ${cfg.teammateNameOutline !== false ? "checked" : ""} /> Outline</label>
          <label>Outline Width <input type="range" class="esp-teammate-name-outline-width" min="1" max="6" step="1" value="${cfg.teammateNameOutlineWidth}" /></label>
          <span class="esp-teammate-name-outline-width-value esp-value-text">${cfg.teammateNameOutlineWidth}px</span>
          <input type="color" class="esp-teammate-name-outline-color" value="${cfg.teammateNameOutlineColor || "#ffffff"}" />
        </div>
      `);

      const teammateOffscreenRow = makeRow(teammatesPane, "Off-screen", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label>Mode
            <select class="esp-teammate-offscreen-style">
              <option value="none" ${cfg.teammateOffscreenStyle === "none" ? "selected" : ""}>None</option>
              <option value="tracers" ${cfg.teammateOffscreenStyle === "tracers" ? "selected" : ""}>Tracers</option>
              <option value="arrows" ${cfg.teammateOffscreenStyle === "arrows" ? "selected" : ""}>Arrows</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="esp-teammate-always-tracer" ${cfg.teammateAlwaysTracer ? "checked" : ""} />
            Always Show Tracer
          </label>
          <label>Theme
            <select class="esp-teammate-offscreen-theme">
              <option value="classic" ${cfg.teammateOffscreenTheme === "classic" ? "selected" : ""}>Classic</option>
              <option value="dashed" ${cfg.teammateOffscreenTheme === "dashed" ? "selected" : ""}>Dashed</option>
              <option value="neon" ${cfg.teammateOffscreenTheme === "neon" ? "selected" : ""}>Neon</option>
            </select>
          </label>
          <span class="esp-teammate-tracer-controls" style="display:flex;align-items:center;gap:10px;">
            <label>Tracer Width <input type="range" class="esp-teammate-tracer-width" min="1" max="8" step="1" value="${cfg.teammateTracerWidth}" /></label>
            <span class="esp-teammate-tracer-width-value esp-value-text">${cfg.teammateTracerWidth}px</span>
            <input type="color" class="esp-teammate-tracer-color" value="${cfg.teammateTracerColor || "#36d17c"}" />
          </span>
          <span class="esp-teammate-arrow-controls" style="display:flex;align-items:center;gap:10px;">
            <label>Arrow Size <input type="range" class="esp-teammate-arrow-size" min="8" max="30" step="1" value="${cfg.teammateArrowSize}" /></label>
            <span class="esp-teammate-arrow-size-value esp-value-text">${cfg.teammateArrowSize}px</span>
            <input type="color" class="esp-teammate-arrow-color" value="${cfg.teammateArrowColor || "#36d17c"}" />
            <label>Arrow Style
              <select class="esp-teammate-arrow-style">
                <option value="regular" ${cfg.teammateArrowStyle === "regular" ? "selected" : ""}>Regular Arrow</option>
                <option value="dot" ${cfg.teammateArrowStyle === "dot" ? "selected" : ""}>Dot</option>
                <option value="modern" ${cfg.teammateArrowStyle === "modern" ? "selected" : ""}>Modern Arrow</option>
              </select>
            </label>
          </span>
        </div>
      `);

      const syncEsp = () => {
        window.__zyroxEspConfig = { ...cfg };
        saveSettings();
      };
      syncEsp();
      const applyValueTextColor = () => {
        for (const el of configBody.querySelectorAll(".esp-value-text")) {
          el.style.color = cfg.valueTextColor || "#ffffff";
        }
      };
      applyValueTextColor();

      const bindCheckbox = (root, selector, key) => {
        const input = root.querySelector(selector);
        if (!input) return;
        input.addEventListener("change", (event) => {
          cfg[key] = Boolean(event.target.checked);
          syncEsp();
        });
      };
      const bindColor = (root, selector, key) => {
        const input = root.querySelector(selector);
        if (!input) return;
        input.addEventListener("input", (event) => {
          cfg[key] = String(event.target.value || "#ffffff");
          syncEsp();
        });
      };
      const bindSlider = (root, selector, key, labelSelector) => {
        const input = root.querySelector(selector);
        const label = root.querySelector(labelSelector);
        if (!input) return;
        input.addEventListener("input", (event) => {
          const value = Number(event.target.value);
          cfg[key] = value;
          if (label) label.textContent = `${value}px`;
          syncEsp();
        });
      };

      bindCheckbox(enemyFilterRow, ".esp-show-enemies", "showEnemies");
      bindCheckbox(hitboxRow, ".esp-hitbox-enabled", "hitbox");
      bindSlider(hitboxRow, ".esp-hitbox-size", "hitboxSize", ".esp-hitbox-size-value");
      bindSlider(hitboxRow, ".esp-hitbox-width", "hitboxWidth", ".esp-hitbox-width-value");
      bindColor(hitboxRow, ".esp-hitbox-color", "hitboxColor");

      bindCheckbox(namesRow, ".esp-name-show-name", "nameTextEnabled");
      bindCheckbox(namesRow, ".esp-name-show-distance", "distanceTextEnabled");
      bindSlider(namesRow, ".esp-name-size", "nameSize", ".esp-name-size-value");
      bindColor(namesRow, ".esp-name-color", "nameColor");
      bindCheckbox(namesRow, ".esp-name-outline-enabled", "nameOutline");
      bindSlider(namesRow, ".esp-name-outline-width", "nameOutlineWidth", ".esp-name-outline-width-value");
      bindColor(namesRow, ".esp-name-outline-color", "nameOutlineColor");
      const nameDistanceStyleInput = namesRow.querySelector(".esp-name-distance-style");
      if (nameDistanceStyleInput) {
        nameDistanceStyleInput.addEventListener("change", (event) => {
          cfg.nameDistanceStyle = String(event.target.value || "dot");
          syncEsp();
        });
      }

      const styleInput = offscreenRow.querySelector(".esp-offscreen-style");
      const tracerControls = offscreenRow.querySelector(".esp-tracer-controls");
      const arrowControls = offscreenRow.querySelector(".esp-arrow-controls");
      const alwaysTracerInput = offscreenRow.querySelector(".esp-always-tracer");
      const refreshIndicatorModeVisibility = () => {
        const mode = cfg.offscreenStyle === "arrows" || cfg.offscreenStyle === "none" ? cfg.offscreenStyle : "tracers";
        if (tracerControls) tracerControls.style.display = mode === "tracers" ? "flex" : "none";
        if (arrowControls) arrowControls.style.display = mode === "arrows" ? "flex" : "none";
      };
      if (styleInput) {
        styleInput.addEventListener("change", (event) => {
          cfg.offscreenStyle = String(event.target.value || "tracers");
          refreshIndicatorModeVisibility();
          syncEsp();
        });
      }
      const themeInput = offscreenRow.querySelector(".esp-offscreen-theme");
      if (themeInput) {
        themeInput.addEventListener("change", (event) => {
          cfg.offscreenTheme = String(event.target.value || "classic");
          syncEsp();
        });
      }
      if (alwaysTracerInput) {
        alwaysTracerInput.addEventListener("change", (event) => {
          cfg.alwaysTracer = Boolean(event.target.checked);
          syncEsp();
        });
      }
      bindSlider(offscreenRow, ".esp-tracer-width", "tracerWidth", ".esp-tracer-width-value");
      bindColor(offscreenRow, ".esp-tracer-color", "tracerColor");
      bindSlider(offscreenRow, ".esp-arrow-size", "arrowSize", ".esp-arrow-size-value");
      bindColor(offscreenRow, ".esp-arrow-color", "arrowColor");
      const arrowStyleInput = offscreenRow.querySelector(".esp-arrow-style");
      if (arrowStyleInput) {
        arrowStyleInput.addEventListener("change", (event) => {
          cfg.arrowStyle = String(event.target.value || "regular");
          syncEsp();
        });
      }
      bindCheckbox(teammateFilterRow, ".esp-show-teammates", "showTeammates");
      bindCheckbox(teammateHitboxRow, ".esp-teammate-hitbox-enabled", "teammateHitbox");
      bindSlider(teammateHitboxRow, ".esp-teammate-hitbox-size", "teammateHitboxSize", ".esp-teammate-hitbox-size-value");
      bindSlider(teammateHitboxRow, ".esp-teammate-hitbox-width", "teammateHitboxWidth", ".esp-teammate-hitbox-width-value");
      bindColor(teammateHitboxRow, ".esp-teammate-hitbox-color", "teammateHitboxColor");
      bindCheckbox(teammateNamesRow, ".esp-teammate-name-show-name", "teammateNameTextEnabled");
      bindCheckbox(teammateNamesRow, ".esp-teammate-name-show-distance", "teammateDistanceTextEnabled");
      bindSlider(teammateNamesRow, ".esp-teammate-name-size", "teammateNameSize", ".esp-teammate-name-size-value");
      bindColor(teammateNamesRow, ".esp-teammate-name-color", "teammateNameColor");
      bindCheckbox(teammateNamesRow, ".esp-teammate-name-outline-enabled", "teammateNameOutline");
      bindSlider(teammateNamesRow, ".esp-teammate-name-outline-width", "teammateNameOutlineWidth", ".esp-teammate-name-outline-width-value");
      bindColor(teammateNamesRow, ".esp-teammate-name-outline-color", "teammateNameOutlineColor");
      const teammateNameDistanceStyleInput = teammateNamesRow.querySelector(".esp-teammate-name-distance-style");
      if (teammateNameDistanceStyleInput) {
        teammateNameDistanceStyleInput.addEventListener("change", (event) => {
          cfg.teammateNameDistanceStyle = String(event.target.value || "dot");
          syncEsp();
        });
      }
      const teammateStyleInput = teammateOffscreenRow.querySelector(".esp-teammate-offscreen-style");
      const teammateTracerControls = teammateOffscreenRow.querySelector(".esp-teammate-tracer-controls");
      const teammateArrowControls = teammateOffscreenRow.querySelector(".esp-teammate-arrow-controls");
      const teammateAlwaysTracerInput = teammateOffscreenRow.querySelector(".esp-teammate-always-tracer");
      const refreshTeammateIndicatorModeVisibility = () => {
        const mode = cfg.teammateOffscreenStyle === "arrows" || cfg.teammateOffscreenStyle === "none"
          ? cfg.teammateOffscreenStyle
          : "tracers";
        if (teammateTracerControls) teammateTracerControls.style.display = mode === "tracers" ? "flex" : "none";
        if (teammateArrowControls) teammateArrowControls.style.display = mode === "arrows" ? "flex" : "none";
      };
      if (teammateStyleInput) {
        teammateStyleInput.addEventListener("change", (event) => {
          cfg.teammateOffscreenStyle = String(event.target.value || "tracers");
          refreshTeammateIndicatorModeVisibility();
          syncEsp();
        });
      }
      const teammateThemeInput = teammateOffscreenRow.querySelector(".esp-teammate-offscreen-theme");
      if (teammateThemeInput) {
        teammateThemeInput.addEventListener("change", (event) => {
          cfg.teammateOffscreenTheme = String(event.target.value || "classic");
          syncEsp();
        });
      }
      if (teammateAlwaysTracerInput) {
        teammateAlwaysTracerInput.addEventListener("change", (event) => {
          cfg.teammateAlwaysTracer = Boolean(event.target.checked);
          syncEsp();
        });
      }
      bindSlider(teammateOffscreenRow, ".esp-teammate-tracer-width", "teammateTracerWidth", ".esp-teammate-tracer-width-value");
      bindColor(teammateOffscreenRow, ".esp-teammate-tracer-color", "teammateTracerColor");
      bindSlider(teammateOffscreenRow, ".esp-teammate-arrow-size", "teammateArrowSize", ".esp-teammate-arrow-size-value");
      bindColor(teammateOffscreenRow, ".esp-teammate-arrow-color", "teammateArrowColor");
      const teammateArrowStyleInput = teammateOffscreenRow.querySelector(".esp-teammate-arrow-style");
      if (teammateArrowStyleInput) {
        teammateArrowStyleInput.addEventListener("change", (event) => {
          cfg.teammateArrowStyle = String(event.target.value || "regular");
          syncEsp();
        });
      }
      refreshIndicatorModeVisibility();
      refreshTeammateIndicatorModeVisibility();
    } else if (moduleName === "Crosshair") {
      const defaults = getCrosshairConfig();
      Object.assign(cfg, { ...defaults, ...cfg });
      window.__zyroxCrosshairConfig = { ...cfg };

      const syncCrosshair = () => { window.__zyroxCrosshairConfig = { ...cfg }; };
      syncCrosshair();

      const makeRow = (title, html) => {
        const row = document.createElement("div");
        row.className = "zyrox-setting-card";
        row.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:8px;width:100%;">
            <label style="font-weight:600;">${title}</label>
            ${html}
          </div>
        `;
        configBody.appendChild(row);
        return row;
      };

      const enabledRow = makeRow("Crosshair", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="xh-enabled" ${cfg.enabled !== false ? "checked" : ""} />
            Show Crosshair
          </label>
          <input type="color" class="xh-color" value="${cfg.color || "#ff3b3b"}" title="Crosshair color" />
        </div>
      `);

      const styleRow = makeRow("Style", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <select class="xh-style">
            <option value="cross"       ${cfg.style === "cross"       ? "selected" : ""}>Cross (gap)</option>
            <option value="solid"       ${cfg.style === "solid"       ? "selected" : ""}>Solid Cross</option>
            <option value="crossdot"    ${cfg.style === "crossdot"    ? "selected" : ""}>Cross + Dot</option>
            <option value="dot"         ${cfg.style === "dot"         ? "selected" : ""}>Dot</option>
            <option value="circle"      ${cfg.style === "circle"      ? "selected" : ""}>Circle</option>
            <option value="circlecross" ${cfg.style === "circlecross" ? "selected" : ""}>Circle + Cross</option>
            <option value="plus"        ${cfg.style === "plus"        ? "selected" : ""}>Plus (thick)</option>
            <option value="x"           ${cfg.style === "x"           ? "selected" : ""}>X (diagonal)</option>
          </select>
        </div>
      `);

      const sizeRow = makeRow("Crosshair Size", `
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="range" class="xh-crosshair-size" min="4" max="40" step="1" value="${cfg.crosshairSize ?? 25}" style="flex:1;" />
          <span class="xh-crosshair-size-label" style="min-width:36px;text-align:right;font-size:0.85em;opacity:0.75;">${cfg.crosshairSize ?? 25}px</span>
        </div>
      `);

      const lineSizeRow = makeRow("Cursor Width", `
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="range" class="xh-line-size" min="0.5" max="6" step="0.5" value="${cfg.lineSize ?? 4}" style="flex:1;" />
          <span class="xh-line-size-label" style="min-width:36px;text-align:right;font-size:0.85em;opacity:0.75;">${cfg.lineSize ?? 4}px</span>
        </div>
      `);

      const lineRow = makeRow("Line to Cursor", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="xh-show-line" ${cfg.showLine ? "checked" : ""} />
            Show Line
          </label>
          <input type="color" class="xh-line-color" value="${cfg.lineColor || "#ff3b3b"}" title="Line color" />
        </div>
      `);

      const tracerSizeRow = makeRow("Tracer Thickness", `
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="range" class="xh-tracer-size" min="0.5" max="5" step="0.5" value="${cfg.tracerLineSize ?? 1.5}" style="flex:1;" />
          <span class="xh-tracer-size-label" style="min-width:36px;text-align:right;font-size:0.85em;opacity:0.75;">${cfg.tracerLineSize ?? 1.5}px</span>
        </div>
      `);

      const hoverRow = makeRow("Player Hover", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="xh-hover-highlight" ${cfg.hoverHighlight ? "checked" : ""} />
            Change color on player
          </label>
          <input type="color" class="xh-hover-color" value="${cfg.hoverColor || "#ffff00"}" title="Hover color" />
        </div>
      `);

      enabledRow.querySelector(".xh-enabled").addEventListener("change", (e) => {
        cfg.enabled = e.target.checked;
        syncCrosshair();
      });
      enabledRow.querySelector(".xh-color").addEventListener("input", (e) => {
        cfg.color = e.target.value;
        syncCrosshair();
      });
      styleRow.querySelector(".xh-style").addEventListener("change", (e) => {
        cfg.style = e.target.value;
        syncCrosshair();
      });
      sizeRow.querySelector(".xh-crosshair-size").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        cfg.crosshairSize = v;
        sizeRow.querySelector(".xh-crosshair-size-label").textContent = `${v}px`;
        syncCrosshair();
      });
      lineSizeRow.querySelector(".xh-line-size").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        cfg.lineSize = v;
        lineSizeRow.querySelector(".xh-line-size-label").textContent = `${v}px`;
        syncCrosshair();
      });
      lineRow.querySelector(".xh-show-line").addEventListener("change", (e) => {
        cfg.showLine = e.target.checked;
        syncCrosshair();
      });
      lineRow.querySelector(".xh-line-color").addEventListener("input", (e) => {
        cfg.lineColor = e.target.value;
        syncCrosshair();
      });
      tracerSizeRow.querySelector(".xh-tracer-size").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        cfg.tracerLineSize = v;
        tracerSizeRow.querySelector(".xh-tracer-size-label").textContent = `${v}px`;
        syncCrosshair();
      });
      hoverRow.querySelector(".xh-hover-highlight").addEventListener("change", (e) => {
        cfg.hoverHighlight = e.target.checked;
        syncCrosshair();
      });
      hoverRow.querySelector(".xh-hover-color").addEventListener("input", (e) => {
        cfg.hoverColor = e.target.value;
        syncCrosshair();
      });

    } else if (moduleName === "Triggerbot (Autoshoot)") {
      const defaults = getTriggerAssistConfig();
      Object.assign(cfg, { ...defaults, ...cfg });
      window.__zyroxTriggerAssistConfig = { ...cfg };

      const syncTriggerAssist = () => {
        window.__zyroxTriggerAssistConfig = { ...cfg };
        saveSettings();
      };
      syncTriggerAssist();

      for (const setting of moduleLayout?.settings || []) {
        if (setting.type === "checkbox") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = Boolean(setting.default);
          const checked = cfg[setting.id] ? "checked" : "";
          const card = document.createElement("div");
          card.className = "zyrox-setting-card";
          card.innerHTML = `
            <label>${setting.label}</label>
            <input type="checkbox" class="set-module-setting-checkbox" data-setting-id="${setting.id}" ${checked} />
          `;
          configBody.appendChild(card);
          const input = card.querySelector(".set-module-setting-checkbox");
          input?.addEventListener("change", (event) => {
            cfg[setting.id] = Boolean(event.target.checked);
            syncTriggerAssist();
          });
        } else if (setting.type === "slider") {
          const value = Number(cfg[setting.id] ?? setting.default ?? setting.min ?? 0);
          const unit = setting.unit ?? "ms";
          const card = document.createElement("div");
          card.className = "zyrox-setting-card";
          card.innerHTML = `
            <label style="display:flex;justify-content:space-between;align-items:center;">
              <span>${setting.label}</span>
              <span class="zyrox-slider-value" style="font-size:0.85em;opacity:0.75;min-width:52px;text-align:right;">${value}${unit}</span>
            </label>
            <input type="range" class="set-module-setting" data-setting-id="${setting.id}" min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${value}" />
          `;
          configBody.appendChild(card);
          const slider = card.querySelector(".set-module-setting");
          const valueLabel = card.querySelector(".zyrox-slider-value");
          slider?.addEventListener("input", (event) => {
            const next = Number(event.target.value);
            cfg[setting.id] = next;
            if (valueLabel) valueLabel.textContent = `${next}${unit}`;
            syncTriggerAssist();
          });
        }
      }
    } else if (moduleName === "Aimbot") {
      const defaults = getAutoAimConfig();
      Object.assign(cfg, { ...defaults, ...cfg });
      window.__zyroxAutoAimConfig = { ...cfg };

      const syncAutoAim = () => {
        window.__zyroxAutoAimConfig = { ...cfg };
        saveSettings();
      };
      syncAutoAim();

      for (const setting of moduleLayout?.settings || []) {
        if (setting.type === "checkbox") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = Boolean(setting.default);
          const checked = cfg[setting.id] ? "checked" : "";
          const card = document.createElement("div");
          card.className = "zyrox-setting-card";
          card.innerHTML = `
            <label>${setting.label}</label>
            <input type="checkbox" class="set-module-setting-checkbox" data-setting-id="${setting.id}" ${checked} />
          `;
          configBody.appendChild(card);
          const input = card.querySelector(".set-module-setting-checkbox");
          input?.addEventListener("change", (event) => {
            cfg[setting.id] = Boolean(event.target.checked);
            syncAutoAim();
          });
        } else if (setting.type === "slider") {
          const value = Number(cfg[setting.id] ?? setting.default ?? setting.min ?? 0);
          const unit = setting.unit ?? "";
          const card = document.createElement("div");
          card.className = "zyrox-setting-card";
          card.innerHTML = `
            <label style="display:flex;justify-content:space-between;align-items:center;">
              <span>${setting.label}</span>
              <span class="zyrox-slider-value" style="font-size:0.85em;opacity:0.75;min-width:52px;text-align:right;">${value}${unit}</span>
            </label>
            <input type="range" class="set-module-setting" data-setting-id="${setting.id}" min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${value}" />
          `;
          configBody.appendChild(card);
          const slider = card.querySelector(".set-module-setting");
          const valueLabel = card.querySelector(".zyrox-slider-value");
          slider?.addEventListener("input", (event) => {
            const next = Number(event.target.value);
            cfg[setting.id] = next;
            if (valueLabel) valueLabel.textContent = `${next}${unit}`;
            syncAutoAim();
          });
        }
      }
    } else if (moduleLayout && Array.isArray(moduleLayout.settings)) {
      for (const setting of moduleLayout.settings) {
        const settingCard = document.createElement("div");
        settingCard.className = "zyrox-setting-card";

        if (setting.type === "slider") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = setting.default ?? setting.min ?? 0;
          const initialVal = cfg[setting.id];
          const valueUnit = setting.unit ?? "ms";
          settingCard.innerHTML = `
            <label style="display:flex;justify-content:space-between;align-items:center;">
              <span>${setting.label}</span>
              <span class="zyrox-slider-value" style="font-size:0.85em;opacity:0.75;min-width:52px;text-align:right;">${initialVal}${valueUnit}</span>
            </label>
            <input type="range" class="set-module-setting" data-setting-id="${setting.id}" min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${initialVal}" />
          `;
          const settingInput = settingCard.querySelector(".set-module-setting");
          const valueLabel = settingCard.querySelector(".zyrox-slider-value");
          if (settingInput) {
            settingInput.addEventListener("input", (event) => {
              const newVal = Number(event.target.value);
              cfg[setting.id] = newVal;
              if (valueLabel) valueLabel.textContent = `${newVal}${valueUnit}`;
              if (moduleName === "Auto Answer" && setting.id === "speed") {
                // Live-update the interval speed only while Auto Answer is enabled
                if (state.enabledModules.has("Auto Answer")) {
                  window.__zyroxAutoAnswer?.start(newVal);
                }
              }
              saveSettings();
            });
          }
        }

        if (setting.type === "checkbox") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = Boolean(setting.default);
          const checked = cfg[setting.id] ? "checked" : "";
          settingCard.innerHTML = `
            <label>${setting.label}</label>
            <input type="checkbox" class="set-module-setting-checkbox" data-setting-id="${setting.id}" ${checked} />
          `;
          const settingInput = settingCard.querySelector(".set-module-setting-checkbox");
          if (settingInput) {
            settingInput.addEventListener("change", (event) => {
              cfg[setting.id] = Boolean(event.target.checked);
              saveSettings();
            });
          }
        }

        if (setting.type === "select") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = setting.default ?? setting.options?.[0]?.value ?? "";
          const options = Array.isArray(setting.options) ? setting.options : [];
          const optionsHtml = options
            .map((option) => {
              const selected = String(option.value) === String(cfg[setting.id]) ? "selected" : "";
              return `<option value="${option.value}" ${selected}>${option.label}</option>`;
            })
            .join("");
          settingCard.innerHTML = `
            <label>${setting.label}</label>
            <select class="set-module-setting-select" data-setting-id="${setting.id}">${optionsHtml}</select>
          `;
          const settingInput = settingCard.querySelector(".set-module-setting-select");
          if (settingInput) {
            settingInput.addEventListener("change", (event) => {
              cfg[setting.id] = String(event.target.value);
              if (moduleName === "Answer Popup" && setting.id === "preset") {
                applyAnswerPopupPreset(cfg, cfg[setting.id]);
                openConfig(moduleName);
              }
              if (moduleName === "Answer Popup") refreshVisibleAnswerPopup();
              saveSettings();
            });
          }
        }

        if (setting.type === "color") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = setting.default ?? "#ffffff";
          settingCard.innerHTML = `
            <label>${setting.label}</label>
            <input type="color" class="set-module-setting-color" data-setting-id="${setting.id}" value="${cfg[setting.id]}" />
          `;
          const settingInput = settingCard.querySelector(".set-module-setting-color");
          if (settingInput) {
            settingInput.addEventListener("input", (event) => {
              cfg[setting.id] = String(event.target.value || "#ffffff");
              if (moduleName === "Answer Popup") refreshVisibleAnswerPopup();
              saveSettings();
            });
          }
        }

        if (setting.type === "text") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = String(setting.default ?? "");
          const safeValue = String(cfg[setting.id]).replace(/"/g, "&quot;");
          settingCard.innerHTML = `
            <label>${setting.label}</label>
            <input type="text" class="set-module-setting-text" data-setting-id="${setting.id}" value="${safeValue}" />
          `;
          const settingInput = settingCard.querySelector(".set-module-setting-text");
          if (settingInput) {
            settingInput.addEventListener("input", (event) => {
              cfg[setting.id] = String(event.target.value ?? "");
              saveSettings();
            });
          }
        }

        if (settingCard.innerHTML.trim()) configBody.appendChild(settingCard);
      }
    }

    configTitleEl.textContent = moduleName;
    configSubEl.textContent = getModuleDescription(moduleName);
    setBindButtonText("Set keybind");
    setCurrentBindText(cfg.keybind || null);

    configBackdrop.classList.remove("hidden");
    configMenu.classList.remove("hidden");
    settingsMenu.classList.add("hidden");
  }

  function openSettings() {
    configBackdrop.classList.remove("hidden");
    settingsMenu.classList.remove("hidden");
    configMenu.classList.add("hidden");
  }

  function collectSettings() {
    return {
      toggleKey: CONFIG.toggleKey,
      globalPreset: state.globalPreset,
      searchAutofocus: searchAutofocusInput.checked,
      hideBrokenModules: hideBrokenModulesInput.checked,
      accent: accentInput.value,
      shellBgStart: shellBgStartInput.value,
      shellBgEnd: shellBgEndInput.value,
      topbarColor: topbarColorInput.value,
      iconColor: iconColorInput.value,
      outlineColor: outlineColorInput.value,
      panelCountText: panelCountTextInput.value,
      panelCountBorder: panelCountBorderInput.value,
      panelCountBg: panelCountBgInput.value,
      border: borderInput.value,
      text: textInput.value,
      opacity: opacityInput.value,
      sliderColor: sliderColorInput.value,
      checkmarkColor: checkmarkColorInput.value,
      selectBg: selectBgInput.value,
      selectText: selectTextInput.value,
      inputBg: inputBgInput.value,
      inputText: inputTextInput.value,
      mutedText: mutedTextInput.value,
      accentSoft: accentSoftInput.value,
      searchText: searchTextInput.value,
      font: fontInput.value,
      headerStart: headerStartInput.value,
      headerEnd: headerEndInput.value,
      headerText: headerTextInput.value,
      settingsHeaderStart: settingsHeaderStartInput.value,
      settingsHeaderEnd: settingsHeaderEndInput.value,
      settingsSidebar: settingsSidebarInput.value,
      settingsBody: settingsBodyInput.value,
      settingsText: settingsTextInput.value,
      settingsSubtext: settingsSubtextInput.value,
      settingsCardBorder: settingsCardBorderInput.value,
      settingsCardBg: settingsCardBgInput.value,
      espValueTextColor: espValueTextColorInput.value,
      scale: scaleInput.value,
      radius: radiusInput.value,
      blur: blurInput.value,
      hoverShift: hoverShiftInput.value,
      displayMode: state.displayMode,
      looseInitialized: state.looseInitialized,
      loosePositions: state.loosePositions,
      loosePanelPositions: state.loosePanelPositions,
      collapsedPanels: state.collapsedPanels,
      enabledModules: Array.from(state.enabledModules),
      moduleConfig: Array.from(ensureModuleConfigStore().entries()),
    };
  }

  function setPanelCollapsed(panelName, collapsed) {
    const panel = panelByName.get(panelName);
    if (!panel) return;
    const list = panel.querySelector(".zyrox-module-list");
    if (!list) return;
    state.collapsedPanels[panelName] = collapsed;
    list.style.display = collapsed ? "none" : "";
    const button = panelCollapseButtons.get(panelName);
    if (button) {
      button.textContent = collapsed ? "▸" : "▾";
      button.title = collapsed ? "Expand category" : "Collapse category";
      button.setAttribute("aria-label", button.title);
      button.classList.toggle("collapsed", collapsed);
    }
  }

  function syncCollapseButtons() {
    for (const [panelName, button] of panelCollapseButtons.entries()) {
      const collapsed = !!state.collapsedPanels[panelName];
      button.textContent = collapsed ? "▸" : "▾";
      button.title = collapsed ? "Expand category" : "Collapse category";
      button.setAttribute("aria-label", button.title);
      button.classList.toggle("collapsed", collapsed);
    }
  }

  function clampToViewport(x, y, el) {
    const rect = el.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    return {
      x: Math.max(0, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    };
  }

  function getShellScale() {
    const transform = getComputedStyle(shell).transform;
    if (!transform || transform === "none") return 1;
    const matrix = transform.match(/^matrix\((.+)\)$/);
    if (!matrix) return 1;
    const values = matrix[1].split(",").map((v) => Number(v.trim()));
    if (values.length < 4 || values.some((v) => !Number.isFinite(v))) return 1;
    const [a, b] = values;
    return Math.max(0.01, Math.hypot(a, b));
  }

  function clampLoosePosition(x, y, el, scale, shellRect) {
    const rect = el.getBoundingClientRect();
    const minX = -shellRect.left / scale;
    const minY = -shellRect.top / scale;
    const maxX = (window.innerWidth - shellRect.left - rect.width) / scale;
    const maxY = (window.innerHeight - shellRect.top - rect.height) / scale;
    return {
      x: Math.max(minX, Math.min(x, maxX)),
      y: Math.max(minY, Math.min(y, maxY)),
    };
  }

  function captureLoosePanelPositionsFromMerged() {
    const shellRect = shell.getBoundingClientRect();
    for (const [name, panel] of panelByName.entries()) {
      const rect = panel.getBoundingClientRect();
      state.loosePanelPositions[name] = {
        x: Math.round(rect.left - shellRect.left),
        y: Math.round(rect.top - shellRect.top),
      };
    }
  }

  function setDisplayMode(mode) {
    const nextMode = mode === "loose" ? "loose" : "merged";

    if (nextMode === "loose" && !state.looseInitialized) {
      // Capture while still in merged flow layout so the first loose layout mirrors merged positions.
      shell.classList.remove("loose-mode");
      captureLoosePanelPositionsFromMerged();
      state.looseInitialized = true;
    }

    state.displayMode = nextMode;
    shell.classList.toggle("loose-mode", state.displayMode === "loose");

    for (const btn of displayModeButtons) {
      btn.classList.toggle("active", btn.dataset.displayMode === state.displayMode);
    }

    if (state.displayMode === "loose") {
      state.mergedRootPosition = {
        left: parseInt(root.style.left || "20", 10),
        top: parseInt(root.style.top || "28", 10),
      };
      root.style.left = "0px";
      root.style.top = "0px";

      const shellRect = shell.getBoundingClientRect();
      const scale = getShellScale();
      const clampedTopbar = clampLoosePosition(state.loosePositions.topbar.x, state.loosePositions.topbar.y, topbar, scale, shellRect);
      state.loosePositions.topbar = clampedTopbar;
      topbar.style.left = `${clampedTopbar.x}px`;
      topbar.style.top = `${clampedTopbar.y}px`;

      for (const [name, panel] of panelByName.entries()) {
        const existingRect = panel.getBoundingClientRect();
        const pos = state.loosePanelPositions[name] || {
          x: Math.round((existingRect.left - shellRect.left) / Math.max(scale, 0.001)),
          y: Math.round((existingRect.top - shellRect.top) / Math.max(scale, 0.001)),
        };
        const clamped = clampLoosePosition(pos.x, pos.y, panel, scale, shellRect);
        state.loosePanelPositions[name] = clamped;
        panel.style.left = `${clamped.x}px`;
        panel.style.top = `${clamped.y}px`;
      }
    } else {
      root.style.left = `${state.mergedRootPosition.left}px`;
      root.style.top = `${state.mergedRootPosition.top}px`;
      topbar.style.left = "";
      topbar.style.top = "";
      for (const panel of panelByName.values()) {
        panel.style.left = "";
        panel.style.top = "";
      }
      shell.style.width = `${state.shellWidth}px`;
      shell.style.height = `${state.shellHeight}px`;
    }
  }

  function applyPreset(presetName) {
    state.globalPreset = normalizePopupPresetName(presetName || "default");
    const popupCfg = moduleCfg("Answer Popup");
    popupCfg.preset = state.globalPreset;
    applyAnswerPopupPreset(popupCfg, state.globalPreset);
    const preset = (() => {
      if (state.globalPreset === "green") {
        return {
          accent: "#2dff75", shellStart: "#2dff75", shellEnd: "#03130a", topbar: "#35d96d", border: "#5dff9a",
          outline: "#37d878", text: "#d7ffe6", muted: "#88b79b", soft: "#a8ffd0", search: "#e6fff0", icon: "#d7ffe9",
          panelText: "#d9ffe8", panelBorder: "#5fff99", panelBg: "#04110a", slider: "#2dff75", checkmark: "#2dff75",
          selectBg: "#111e16", selectText: "#d7ffe6",
          headerStart: "#2dff75", headerEnd: "#0f2f1b", headerText: "#f0fff4",
          settingsText: "#d7ffe6", settingsSubtext: "#a7cfb7", settingsSidebar: "#102016", settingsBody: "#0d1510",
          settingsCardBorder: "#79d6a0", settingsCardBg: "#12301f",
          settingsHeaderStart: "#2dff75", settingsHeaderEnd: "#0f2f1b", espValueTextColor: "#ffffff",
          font: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        };
      }
      if (state.globalPreset === "ice") {
        return {
          accent: "#6cd8ff", shellStart: "#6cd8ff", shellEnd: "#07131a", topbar: "#58bff1", border: "#8ae4ff",
          outline: "#6fbce8", text: "#d7edff", muted: "#8ea7bd", soft: "#b8e5ff", search: "#e7f5ff", icon: "#dff3ff",
          panelText: "#e1f4ff", panelBorder: "#8fd7ff", panelBg: "#071019", slider: "#7bdfff", checkmark: "#7bdfff",
          selectBg: "#0c1c26", selectText: "#d7edff",
          headerStart: "#6cd8ff", headerEnd: "#133042", headerText: "#f4fbff",
          settingsText: "#d7edff", settingsSubtext: "#9db4c6", settingsSidebar: "#10202c", settingsBody: "#0e141a",
          settingsCardBorder: "#90cae8", settingsCardBg: "#173247",
          settingsHeaderStart: "#6cd8ff", settingsHeaderEnd: "#133042", espValueTextColor: "#ffffff",
          font: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        };
      }
      if (state.globalPreset === "grayscale") {
        return {
          accent: "#d3d3d3", shellStart: "#7a7a7a", shellEnd: "#0a0a0a", topbar: "#8d8d8d", border: "#b1b1b1",
          outline: "#9a9a9a", text: "#dddddd", muted: "#9a9a9a", soft: "#c9c9c9", search: "#f1f1f1", icon: "#f5f5f5",
          panelText: "#efefef", panelBorder: "#a0a0a0", panelBg: "#0f0f0f", slider: "#c4c4c4", checkmark: "#d0d0d0",
          selectBg: "#1b1b1b", selectText: "#efefef",
          headerStart: "#8f8f8f", headerEnd: "#1d1d1d", headerText: "#ffffff",
          settingsText: "#efefef", settingsSubtext: "#b2b2b2", settingsSidebar: "#202020", settingsBody: "#181818",
          settingsCardBorder: "#b7b7b7", settingsCardBg: "#313131",
          settingsHeaderStart: "#8f8f8f", settingsHeaderEnd: "#1d1d1d", espValueTextColor: "#ffffff",
          font: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        };
      }
      // Default (red)
      return {
        accent: "#ff3d3d", shellStart: "#ff3d3d", shellEnd: "#000000", topbar: "#ff4a4a", border: "#ff6f6f",
        outline: "#ff5b5b", text: "#d6d6df", muted: "#9b9bab", soft: "#ffbdbd", search: "#ffe6e6", icon: "#ffdada",
        panelText: "#ffd9d9", panelBorder: "#ff6464", panelBg: "#1a1a1e", slider: "#ff6b6b", checkmark: "#ff6b6b",
        selectBg: "#17171f", selectText: "#ffe5e5",
        headerStart: "#ff4a4a", headerEnd: "#3c1212", headerText: "#ffffff",
        settingsText: "#ffe5e5", settingsSubtext: "#c2c2ce", settingsSidebar: "#181820", settingsBody: "#121216",
        settingsCardBorder: "#ffffff", settingsCardBg: "#ffffff",
        settingsHeaderStart: "#ff3d3d", settingsHeaderEnd: "#2d0c0c", espValueTextColor: "#ffffff",
        font: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
      };
    })();

    accentInput.value = preset.accent;
    shellBgStartInput.value = preset.shellStart;
    shellBgEndInput.value = preset.shellEnd;
    topbarColorInput.value = preset.topbar;
    borderInput.value = preset.border;
    outlineColorInput.value = preset.outline;
    textInput.value = preset.text;
    mutedTextInput.value = preset.muted;
    accentSoftInput.value = preset.soft;
    searchTextInput.value = preset.search;
    fontInput.value = preset.font || "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
    iconColorInput.value = preset.icon;
    panelCountTextInput.value = preset.panelText;
    panelCountBorderInput.value = preset.panelBorder;
    panelCountBgInput.value = preset.panelBg;
    sliderColorInput.value = preset.slider;
    checkmarkColorInput.value = preset.checkmark;
    selectBgInput.value = preset.selectBg;
    selectTextInput.value = preset.selectText;
    inputBgInput.value = preset.selectBg;
    inputTextInput.value = preset.selectText;
    headerStartInput.value = preset.headerStart;
    headerEndInput.value = preset.headerEnd;
    headerTextInput.value = preset.headerText;
    settingsHeaderStartInput.value = preset.settingsHeaderStart;
    settingsHeaderEndInput.value = preset.settingsHeaderEnd;
    settingsSidebarInput.value = preset.settingsSidebar;
    settingsBodyInput.value = preset.settingsBody;
    settingsTextInput.value = preset.settingsText;
    settingsSubtextInput.value = preset.settingsSubtext;
    settingsCardBorderInput.value = preset.settingsCardBorder;
    settingsCardBgInput.value = preset.settingsCardBg;
    espValueTextColorInput.value = preset.espValueTextColor;
    applyAppearance();
    refreshVisibleAnswerPopup();
    saveSettings();
  }

  function applyAppearance() {
    const normalizeHex = (value, fallback) => {
      const normalized = String(value || "").trim();
      return /^#([0-9a-fA-F]{6})$/.test(normalized) ? normalized.toLowerCase() : fallback;
    };
    const clampNumber = (value, min, max, fallback) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, parsed));
    };
    const toRgba = (hex, alpha) => {
      const h = hex.replace("#", "");
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    const darken = (hex, factor) => {
      const h = hex.replace("#", "");
      const r = Math.max(0, Math.floor(parseInt(h.slice(0, 2), 16) * factor));
      const g = Math.max(0, Math.floor(parseInt(h.slice(2, 4), 16) * factor));
      const b = Math.max(0, Math.floor(parseInt(h.slice(4, 6), 16) * factor));
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    };

    const shellBgStart = normalizeHex(shellBgStartInput.value, "#ff3d3d");
    const shellBgEnd = normalizeHex(shellBgEndInput.value, "#000000");
    const topbarColor = normalizeHex(topbarColorInput.value, "#ff4a4a");
    const iconColor = normalizeHex(iconColorInput.value, "#ffdada");
    const outlineColor = normalizeHex(outlineColorInput.value, "#ff5b5b");
    const panelCountText = normalizeHex(panelCountTextInput.value, "#ffd9d9");
    const panelCountBorder = normalizeHex(panelCountBorderInput.value, "#ff6464");
    const panelCountBg = normalizeHex(panelCountBgInput.value, "#1a1a1e");
    const border = normalizeHex(borderInput.value, "#ff6f6f");
    const text = normalizeHex(textInput.value, "#d6d6df");
    const opacity = clampNumber(opacityInput.value, 10, 100, 45) / 100;
    const sliderColor = normalizeHex(sliderColorInput.value, "#ff6b6b");
    const checkmarkColor = normalizeHex(checkmarkColorInput.value, "#ff6b6b");
    const selectBg = normalizeHex(selectBgInput.value, "#17171f");
    const selectText = normalizeHex(selectTextInput.value, "#ffe5e5");
    const inputBg = normalizeHex(inputBgInput.value, "#17171f");
    const inputText = normalizeHex(inputTextInput.value, "#ffe5e5");
    const mutedText = normalizeHex(mutedTextInput.value, "#9b9bab");
    const accentSoft = normalizeHex(accentSoftInput.value, "#ffbdbd");
    const searchText = normalizeHex(searchTextInput.value, "#ffe6e6");
    const font = fontInput.value;
    const headerStart = normalizeHex(headerStartInput.value, "#ff4a4a");
    const headerEnd = normalizeHex(headerEndInput.value, "#3c1212");
    const headerText = normalizeHex(headerTextInput.value, "#ffffff");
    const settingsHeaderStart = normalizeHex(settingsHeaderStartInput.value, "#ff3d3d");
    const settingsHeaderEnd = normalizeHex(settingsHeaderEndInput.value, "#2d0c0c");
    const settingsSidebar = normalizeHex(settingsSidebarInput.value, "#181820");
    const settingsBody = normalizeHex(settingsBodyInput.value, "#121216");
    const settingsText = normalizeHex(settingsTextInput.value, "#ffe5e5");
    const settingsSubtext = normalizeHex(settingsSubtextInput.value, "#c2c2ce");
    const settingsCardBorder = normalizeHex(settingsCardBorderInput.value, "#ffffff");
    const settingsCardBg = normalizeHex(settingsCardBgInput.value, "#ffffff");
    const espValueTextColor = normalizeHex(espValueTextColorInput.value, "#ffffff");
    const scale = clampNumber(scaleInput.value, 80, 130, 100) / 100;
    const radius = clampNumber(radiusInput.value, 8, 22, 14);
    const blur = clampNumber(blurInput.value, 0, 24, 10);
    const hoverShift = clampNumber(hoverShiftInput.value, 0, 8, 2);
    const themeTargets = [root.style, configBackdrop.style];
    const setThemeVar = (name, value) => {
      for (const target of themeTargets) target.setProperty(name, value);
    };
    setThemeVar("--zyx-border", `${border}99`);
    setThemeVar("--zyx-text", text);
    setThemeVar("--zyx-font", font);
    setThemeVar("--zyx-muted", mutedText);
    setThemeVar("--zyx-accent-soft", accentSoft);
    setThemeVar("--zyx-search-text", searchText);
    setThemeVar("--zyx-topbar-bg-start", toRgba(topbarColor, 0.22));
    setThemeVar("--zyx-topbar-bg-end", toRgba(darken(topbarColor, 0.22), 0.9));
    setThemeVar("--zyx-module-hover-bg", toRgba(topbarColor, 0.16));
    setThemeVar("--zyx-module-hover-border", toRgba(topbarColor, 0.4));
    setThemeVar("--zyx-module-active-start", toRgba(headerStart, 0.35));
    setThemeVar("--zyx-module-active-end", toRgba(headerEnd, 0.82));
    setThemeVar("--zyx-module-active-border", toRgba(headerStart, 0.55));
    setThemeVar("--zyx-icon-color", iconColor);
    setThemeVar("--zyx-outline-color", `${outlineColor}cc`);
    setThemeVar("--zyx-panel-count-text", panelCountText);
    setThemeVar("--zyx-panel-count-border", toRgba(panelCountBorder, 0.45));
    setThemeVar("--zyx-panel-count-bg", toRgba(panelCountBg, 0.6));
    setThemeVar("--zyx-header-bg-start", toRgba(headerStart, 0.24));
    setThemeVar("--zyx-header-bg-end", toRgba(headerEnd, 0.92));
    setThemeVar("--zyx-header-text", headerText);
    setThemeVar("--zyx-settings-header-start", toRgba(settingsHeaderStart, 0.3));
    setThemeVar("--zyx-settings-header-end", toRgba(settingsHeaderEnd, 0.95));
    setThemeVar("--zyx-settings-sidebar-bg", toRgba(settingsSidebar, 0.22));
    setThemeVar("--zyx-settings-body-bg", `linear-gradient(180deg, ${toRgba(settingsBody, 0.97)}, rgba(8, 8, 10, 0.97))`);
    setThemeVar("--zyx-settings-text", settingsText);
    setThemeVar("--zyx-settings-subtext", settingsSubtext);
    setThemeVar("--zyx-settings-card-border", toRgba(settingsCardBorder, 0.18));
    setThemeVar("--zyx-settings-card-bg", toRgba(settingsCardBg, 0.05));
    setThemeVar("--zyx-slider-color", sliderColor);
    setThemeVar("--zyx-checkmark-color", checkmarkColor);
    setThemeVar("--zyx-select-bg", toRgba(selectBg, 0.9));
    setThemeVar("--zyx-select-text", selectText);
    setThemeVar("--zyx-input-bg", toRgba(inputBg, 0.9));
    setThemeVar("--zyx-input-text", inputText);
    window.__zyroxEspValueTextColor = espValueTextColor;
    window.__zyroxEspConfig = { ...getEspRenderConfig(), valueTextColor: espValueTextColor, font: font };
    setThemeVar("--zyx-radius-xl", `${radius}px`);
    setThemeVar("--zyx-radius-lg", `${Math.max(4, radius - 2)}px`);
    setThemeVar("--zyx-radius-md", `${Math.max(3, radius - 4)}px`);
    setThemeVar("--zyx-hover-shift", `${hoverShift}px`);
    shell.style.transform = `scale(${scale.toFixed(2)})`;
    shell.style.transformOrigin = "top left";
    shell.style.background = `linear-gradient(150deg, ${toRgba(shellBgStart, 0.22)}, ${toRgba(shellBgEnd, opacity.toFixed(2))})`;
    setThemeVar("--zyx-shell-blur", `${blur}px`);
    shell.style.backdropFilter = `blur(var(--zyx-shell-blur)) saturate(115%)`;

    // FIX: derive button accent background from outlineColor so buttons always match the theme
    setThemeVar("--zyx-btn-bg", toRgba(outlineColor, 0.12));
    setThemeVar("--zyx-btn-hover-bg", toRgba(outlineColor, 0.2));

    if (state.displayMode === "loose") {
      const shellRect = shell.getBoundingClientRect();
      const looseScale = getShellScale();
      for (const [name, panel] of panelByName.entries()) {
        const existingRect = panel.getBoundingClientRect();
        const fallback = {
          x: Math.round((existingRect.left - shellRect.left) / Math.max(looseScale, 0.001)),
          y: Math.round((existingRect.top - shellRect.top) / Math.max(looseScale, 0.001)),
        };
        const current = state.loosePanelPositions[name] || fallback;
        const clamped = clampLoosePosition(current.x, current.y, panel, looseScale, shellRect);
        state.loosePanelPositions[name] = clamped;
        panel.style.left = `${clamped.x}px`;
        panel.style.top = `${clamped.y}px`;
      }
    }
  }

  function applySearchFilter() {
    const query = state.searchQuery.trim().toLowerCase();

    for (const entry of state.moduleEntries) {
      const hiddenByWorkState = isModuleHiddenByWorkState(entry.name);
      const visibleByQuery = !query || entry.name.toLowerCase().includes(query);
      const visible = !hiddenByWorkState && visibleByQuery;
      entry.item.style.display = visible ? "" : "none";
    }

    for (const [panel, meta] of state.modulePanels.entries()) {
      let visibleCount = 0;
      for (const moduleName of meta.modules) {
        const item = state.moduleItems.get(moduleName);
        if (item && item.style.display !== "none") visibleCount += 1;
      }

      panel.style.display = visibleCount > 0 ? "" : "none";
    }
  }

  function buildPanel(name, modules) {
    const panel = document.createElement("section");
    panel.className = "zyrox-panel";
    panel.dataset.panelName = name;

    const header = document.createElement("header");
    header.className = "zyrox-panel-header";

    const title = document.createElement("span");
    title.textContent = name;

    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.className = "zyrox-panel-collapse-btn";
    collapseButton.textContent = "▾";
    collapseButton.title = "Collapse category";
    collapseButton.setAttribute("aria-label", "Collapse category");
    collapseButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const nextCollapsed = !state.collapsedPanels[name];
      setPanelCollapsed(name, nextCollapsed);
    });

    header.appendChild(title);
    header.appendChild(collapseButton);

    const list = document.createElement("ul");
    list.className = "zyrox-module-list";

    const moduleNames = [];
    for (const moduleDef of modules) {
      const moduleName = typeof moduleDef === "string" ? moduleDef : moduleDef?.name;
      if (!moduleName) continue;
      if (state.moduleItems.has(moduleName)) continue;
      moduleNames.push(moduleName);
      const item = document.createElement("li");
      item.className = "zyrox-module";
      item.innerHTML = `<span>${moduleName}</span><span class="zyrox-bind-label"></span>`;

      state.moduleItems.set(moduleName, item);
      state.moduleEntries.push({ name: moduleName, item, panel });

      const behavior = MODULE_BEHAVIORS[moduleName];
      const moduleInstance = new Module(moduleName, {
        onEnable: () => {
          console.log(`${moduleName} enabled`);
          if (behavior?.onEnable) behavior.onEnable();
        },
        onDisable: () => {
          console.log(`${moduleName} disabled`);
          if (behavior?.onDisable) behavior.onDisable();
        },
      });
      state.modules.set(moduleName, moduleInstance);

      moduleCfg(moduleName);
      setBindLabel(item, moduleName);

      item.addEventListener("click", () => {
        toggleModule(moduleName);
      });

      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openConfig(moduleName);
      });

      list.appendChild(item);
    }

    panel.appendChild(header);
    panel.appendChild(list);
    panelByName.set(name, panel);
    panelCollapseButtons.set(name, collapseButton);
    state.modulePanels.set(panel, { modules: moduleNames });
    return panel;
  }

  settingsMenuKeyBtn.addEventListener("click", () => {
    state.listeningForMenuBind = true;
    settingsMenuKeyBtn.textContent = "Press key...";
    searchInput.blur();
  });

  settingsMenuKeyResetBtn.addEventListener("click", () => {
    CONFIG.toggleKey = CONFIG.defaultToggleKey;
    settingsMenuKeyBtn.textContent = `Menu Key: ${CONFIG.toggleKey}`;
    setFooterText();
    state.listeningForMenuBind = false;
    saveSettings();
  });

  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset || "default"));
  });

  settingsBtn.addEventListener("click", () => {
    openSettings();
  });

  settingsTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      for (const t of settingsTabs) t.classList.toggle("active", t === tab);
      for (const pane of settingsPanes) pane.classList.toggle("hidden", pane.dataset.pane !== target);
    });
  });

  searchInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === CONFIG.toggleKey) {
      event.preventDefault();
      setVisible(false);
    }
  });

  const applySearchFilterDebounced = debounce(applySearchFilter, 80);
  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    applySearchFilterDebounced();
  });

  accentInput.addEventListener("input", applyAppearance);
  shellBgStartInput.addEventListener("input", applyAppearance);
  shellBgEndInput.addEventListener("input", applyAppearance);
  topbarColorInput.addEventListener("input", applyAppearance);
  iconColorInput.addEventListener("input", applyAppearance);
  outlineColorInput.addEventListener("input", applyAppearance);
  panelCountTextInput.addEventListener("input", applyAppearance);
  panelCountBorderInput.addEventListener("input", applyAppearance);
  panelCountBgInput.addEventListener("input", applyAppearance);
  borderInput.addEventListener("input", applyAppearance);
  textInput.addEventListener("input", applyAppearance);
  opacityInput.addEventListener("input", applyAppearance);
  sliderColorInput.addEventListener("input", applyAppearance);
  checkmarkColorInput.addEventListener("input", applyAppearance);
  mutedTextInput.addEventListener("input", applyAppearance);
  accentSoftInput.addEventListener("input", applyAppearance);
  searchTextInput.addEventListener("input", applyAppearance);
  fontInput.addEventListener("input", applyAppearance);
  fontInput.addEventListener("change", applyAppearance);
  headerStartInput.addEventListener("input", applyAppearance);
  headerEndInput.addEventListener("input", applyAppearance);
  headerTextInput.addEventListener("input", applyAppearance);
  settingsHeaderStartInput.addEventListener("input", applyAppearance);
  settingsHeaderEndInput.addEventListener("input", applyAppearance);
  settingsSidebarInput.addEventListener("input", applyAppearance);
  settingsBodyInput.addEventListener("input", applyAppearance);
  settingsTextInput.addEventListener("input", applyAppearance);
  settingsSubtextInput.addEventListener("input", applyAppearance);
  settingsCardBorderInput.addEventListener("input", applyAppearance);
  settingsCardBgInput.addEventListener("input", applyAppearance);
  selectBgInput.addEventListener("input", applyAppearance);
  selectTextInput.addEventListener("input", applyAppearance);
  inputBgInput.addEventListener("input", applyAppearance);
  inputTextInput.addEventListener("input", applyAppearance);
  espValueTextColorInput.addEventListener("input", applyAppearance);
  scaleInput.addEventListener("input", applyAppearance);
  radiusInput.addEventListener("input", applyAppearance);
  blurInput.addEventListener("input", applyAppearance);
  hoverShiftInput.addEventListener("input", applyAppearance);
  displayModeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setDisplayMode(btn.dataset.displayMode || "merged"));
  });
  searchAutofocusInput.addEventListener("change", () => {
    state.searchAutofocus = searchAutofocusInput.checked;
  });
  hideBrokenModulesInput.addEventListener("change", () => {
    state.hideBrokenModules = hideBrokenModulesInput.checked;
    if (state.hideBrokenModules) {
      for (const moduleName of [...state.enabledModules]) {
        if (isModuleHiddenByWorkState(moduleName)) toggleModule(moduleName);
      }
      if (openConfigModule && isModuleHiddenByWorkState(openConfigModule)) closeConfig();
    }
    applySearchFilter();
  });

  settingsResetBtn.addEventListener("click", () => {
    accentInput.value = "#ff3d3d";
    shellBgStartInput.value = "#ff3d3d";
    shellBgEndInput.value = "#000000";
    topbarColorInput.value = "#ff4a4a";
    iconColorInput.value = "#ffdada";
    outlineColorInput.value = "#ff5b5b";
    panelCountTextInput.value = "#ffd9d9";
    panelCountBorderInput.value = "#ff6464";
    panelCountBgInput.value = "#1a1a1e";
    borderInput.value = "#ff6f6f";
    textInput.value = "#d6d6df";
    opacityInput.value = "45";
    sliderColorInput.value = "#ff6b6b";
    checkmarkColorInput.value = "#ff6b6b";
    selectBgInput.value = "#17171f";
    selectTextInput.value = "#ffe5e5";
    inputBgInput.value = "#17171f";
    inputTextInput.value = "#ffe5e5";
    mutedTextInput.value = "#9b9bab";
    accentSoftInput.value = "#ffbdbd";
    searchTextInput.value = "#ffe6e6";
    fontInput.value = "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
    headerStartInput.value = "#ff4a4a";
    headerEndInput.value = "#3c1212";
    headerTextInput.value = "#ffffff";
    settingsHeaderStartInput.value = "#ff3d3d";
    settingsHeaderEndInput.value = "#2d0c0c";
    settingsSidebarInput.value = "#181820";
    settingsBodyInput.value = "#121216";
    settingsTextInput.value = "#ffe5e5";
    settingsSubtextInput.value = "#c2c2ce";
    settingsCardBorderInput.value = "#ffffff";
    settingsCardBgInput.value = "#ffffff";
    espValueTextColorInput.value = "#ffffff";
    searchAutofocusInput.checked = true;
    state.searchAutofocus = true;
    hideBrokenModulesInput.checked = true;
    state.hideBrokenModules = true;
    state.globalPreset = "default";
    scaleInput.value = "100";
    radiusInput.value = "14";
    blurInput.value = "10";
    hoverShiftInput.value = "2";
    state.looseInitialized = false;
    state.loosePositions = { topbar: { x: 12, y: 12 } };
    state.loosePanelPositions = {};
    state.collapsedPanels = {};
    for (const panelName of panelByName.keys()) {
      setPanelCollapsed(panelName, false);
    }
    syncCollapseButtons();
    setDisplayMode("loose");
    const themeTargets = [root.style, configBackdrop.style];
    const removeThemeVar = (name) => {
      for (const target of themeTargets) target.removeProperty(name);
    };
    removeThemeVar("--zyx-border");
    removeThemeVar("--zyx-text");
    removeThemeVar("--zyx-font");
    removeThemeVar("--zyx-muted");
    removeThemeVar("--zyx-accent-soft");
    removeThemeVar("--zyx-search-text");
    removeThemeVar("--zyx-topbar-bg-start");
    removeThemeVar("--zyx-topbar-bg-end");
    removeThemeVar("--zyx-module-hover-bg");
    removeThemeVar("--zyx-module-hover-border");
    removeThemeVar("--zyx-module-active-start");
    removeThemeVar("--zyx-module-active-end");
    removeThemeVar("--zyx-module-active-border");
    removeThemeVar("--zyx-icon-color");
    removeThemeVar("--zyx-outline-color");
    removeThemeVar("--zyx-panel-count-text");
    removeThemeVar("--zyx-panel-count-border");
    removeThemeVar("--zyx-panel-count-bg");
    removeThemeVar("--zyx-header-bg-start");
    removeThemeVar("--zyx-header-bg-end");
    removeThemeVar("--zyx-header-text");
    removeThemeVar("--zyx-settings-header-start");
    removeThemeVar("--zyx-settings-header-end");
    removeThemeVar("--zyx-settings-sidebar-bg");
    removeThemeVar("--zyx-settings-body-bg");
    removeThemeVar("--zyx-settings-text");
    removeThemeVar("--zyx-settings-subtext");
    removeThemeVar("--zyx-settings-card-border");
    removeThemeVar("--zyx-settings-card-bg");
    removeThemeVar("--zyx-slider-color");
    removeThemeVar("--zyx-checkmark-color");
    removeThemeVar("--zyx-select-bg");
    removeThemeVar("--zyx-select-text");
    removeThemeVar("--zyx-radius-xl");
    removeThemeVar("--zyx-radius-lg");
    removeThemeVar("--zyx-radius-md");
    removeThemeVar("--zyx-hover-shift");
    removeThemeVar("--zyx-shell-blur");
    removeThemeVar("--zyx-btn-bg");
    removeThemeVar("--zyx-btn-hover-bg");
    shell.style.background = "";
    shell.style.transform = "";
    shell.style.backdropFilter = "";
    saveSettings();
  });

  settingsResetAllBtn.addEventListener("click", () => {
    // Nuke localStorage
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}

    // Reset module enabled state
    for (const moduleName of [...state.enabledModules]) {
      toggleModule(moduleName); // toggles off
    }
    state.enabledModules.clear();
    for (const [, item] of state.moduleItems) item.classList.remove("active");

    // Reset all module configs (keybinds + settings)
    state.moduleConfig = new Map();

    // Reset keybind labels
    for (const [moduleName, item] of state.moduleItems) {
      setBindLabel(item, moduleName);
    }

    // Reset menu keybind
    CONFIG.toggleKey = CONFIG.defaultToggleKey;
    settingsMenuKeyBtn.textContent = `Menu Key: ${CONFIG.toggleKey}`;
    setFooterText();

    // Reset search autofocus
    state.searchAutofocus = true;
    searchAutofocusInput.checked = true;
    state.hideBrokenModules = true;
    hideBrokenModulesInput.checked = true;

    // Trigger the full appearance reset too
    settingsResetBtn.click();
  });

  function saveSettings(showFeedback = false) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collectSettings()));
      if (showFeedback) {
        settingsSaveBtn.textContent = "Saved";
        setTimeout(() => {
          settingsSaveBtn.textContent = "Save";
        }, 850);
      }
    } catch (_) {
      if (showFeedback) {
        settingsSaveBtn.textContent = "Save failed";
        setTimeout(() => {
          settingsSaveBtn.textContent = "Save";
        }, 1200);
      }
    }
  }

  settingsSaveBtn.addEventListener("click", () => {
    saveSettings(true);
  });

  settingsCloseBtn.addEventListener("click", () => {
    closeConfig();
  });
  configCloseBtn.addEventListener("click", () => closeConfig());
  settingsTopCloseBtn.addEventListener("click", () => closeConfig());

  const generalPanels = document.createElement("div");
  generalPanels.className = "zyrox-panels";
  for (const generalGroup of MENU_LAYOUT.general.groups) {
    generalPanels.appendChild(buildPanel(generalGroup.name, generalGroup.modules));
  }
  generalSection.appendChild(generalPanels);

  const gamemodePanels = document.createElement("div");
  gamemodePanels.className = "zyrox-panels";
  for (const gm of MENU_LAYOUT.gamemodeSpecific.groups) {
    gamemodePanels.appendChild(buildPanel(gm.name, gm.modules));
  }
  gamemodeSection.appendChild(gamemodePanels);

  for (const [panelName] of panelByName.entries()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zyrox-collapse-btn";
    btn.textContent = panelName;
    btn.addEventListener("click", () => {
      const nextCollapsed = !state.collapsedPanels[panelName];
      setPanelCollapsed(panelName, nextCollapsed);
      btn.classList.toggle("inactive", nextCollapsed);
    });
    collapseRow.appendChild(btn);
  }

  shell.appendChild(topbar);
  shell.appendChild(generalSection);
  shell.appendChild(gamemodeSection);
  shell.appendChild(footer);
  shell.appendChild(resizeHandle);

  root.appendChild(shell);

  document.head.appendChild(style);
  document.body.appendChild(root);
  document.body.appendChild(configBackdrop);

  let pendingEnabledModules = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === "object") {
        if (saved.toggleKey) CONFIG.toggleKey = saved.toggleKey;
        if (typeof saved.globalPreset === "string") state.globalPreset = normalizePopupPresetName(saved.globalPreset);
        if (typeof saved.searchAutofocus === "boolean") {
          state.searchAutofocus = saved.searchAutofocus;
          searchAutofocusInput.checked = saved.searchAutofocus;
        }
        if (typeof saved.hideBrokenModules === "boolean") {
          state.hideBrokenModules = saved.hideBrokenModules;
          hideBrokenModulesInput.checked = saved.hideBrokenModules;
        }
        const assign = (input, key) => {
          if (saved[key] !== undefined && input) input.value = String(saved[key]);
        };
        assign(accentInput, "accent");
        assign(shellBgStartInput, "shellBgStart");
        assign(shellBgEndInput, "shellBgEnd");
        assign(topbarColorInput, "topbarColor");
        assign(iconColorInput, "iconColor");
        assign(outlineColorInput, "outlineColor");
        assign(panelCountTextInput, "panelCountText");
        assign(panelCountBorderInput, "panelCountBorder");
        assign(panelCountBgInput, "panelCountBg");
        assign(borderInput, "border");
        assign(textInput, "text");
        assign(opacityInput, "opacity");
        assign(sliderColorInput, "sliderColor");
        assign(checkmarkColorInput, "checkmarkColor");
        assign(selectBgInput, "selectBg");
        assign(selectTextInput, "selectText");
        assign(inputBgInput, "inputBg");
        assign(inputTextInput, "inputText");
        assign(mutedTextInput, "mutedText");
        assign(accentSoftInput, "accentSoft");
        assign(searchTextInput, "searchText");
        assign(fontInput, "font");
        assign(headerStartInput, "headerStart");
        assign(headerEndInput, "headerEnd");
        assign(headerTextInput, "headerText");
        assign(settingsHeaderStartInput, "settingsHeaderStart");
        assign(settingsHeaderEndInput, "settingsHeaderEnd");
        assign(settingsSidebarInput, "settingsSidebar");
        assign(settingsBodyInput, "settingsBody");
        assign(settingsTextInput, "settingsText");
        assign(settingsSubtextInput, "settingsSubtext");
        assign(settingsCardBorderInput, "settingsCardBorder");
        assign(settingsCardBgInput, "settingsCardBg");
        assign(espValueTextColorInput, "espValueTextColor");
        assign(scaleInput, "scale");
        assign(radiusInput, "radius");
        assign(blurInput, "blur");
        assign(hoverShiftInput, "hoverShift");
        if (saved.displayMode) state.displayMode = saved.displayMode === "loose" ? "loose" : "merged";
        if (typeof saved.looseInitialized === "boolean") state.looseInitialized = saved.looseInitialized;
        if (saved.loosePositions && typeof saved.loosePositions === "object") {
          state.loosePositions = {
            topbar: saved.loosePositions.topbar || state.loosePositions.topbar,
          };
        }
        if (saved.loosePanelPositions && typeof saved.loosePanelPositions === "object") {
          state.loosePanelPositions = saved.loosePanelPositions;
        }
        if (saved.collapsedPanels && typeof saved.collapsedPanels === "object") {
          state.collapsedPanels = saved.collapsedPanels;
        }
        const savedModuleConfig = Array.isArray(saved.moduleConfig)
          ? saved.moduleConfig
          : (Array.isArray(saved.moduleSettings) ? saved.moduleSettings : null);
        if (savedModuleConfig) {
          const migratedModuleConfig = savedModuleConfig.map(([name, cfg]) => {
            if (name === LEGACY_ANIMATION_SKIP_MODULE_NAME) return [ANIMATION_SKIP_MODULE_NAME, cfg];
            return [name, cfg];
          });
          state.moduleConfig = new Map(migratedModuleConfig);
        }
        if (Array.isArray(saved.enabledModules)) {
          pendingEnabledModules = saved.enabledModules
            .filter((name) => typeof name === "string")
            .map((name) => (name === LEGACY_ANIMATION_SKIP_MODULE_NAME ? ANIMATION_SKIP_MODULE_NAME : name));
        }
        settingsMenuKeyBtn.textContent = `Menu Key: ${CONFIG.toggleKey}`;
        setFooterText();
      }
    }
  } catch (_) {}

  for (const panelName of panelByName.keys()) {
    setPanelCollapsed(panelName, !!state.collapsedPanels[panelName]);
  }
  syncCollapseButtons();
  applyAppearance();
  setDisplayMode(state.displayMode);
  applySearchFilter();
  for (const moduleName of pendingEnabledModules) {
    const moduleInstance = state.modules.get(moduleName);
    if (!moduleInstance || moduleInstance.enabled) continue;
    if (isModuleHiddenByWorkState(moduleName)) continue;
    toggleModule(moduleName);
  }

  const isTypingTarget = (target) => {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  };

  function setVisible(nextVisible) {
    state.visible = nextVisible;
    root.classList.toggle("zyrox-hidden", !nextVisible);
    if (!nextVisible) closeConfig();
    if (nextVisible && state.searchAutofocus) {
      requestAnimationFrame(() => {
        searchInput.focus();
        if (searchInput.value === CONFIG.toggleKey) {
          searchInput.value = "";
          state.searchQuery = "";
          applySearchFilter();
        }
      });
    }
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!configBackdrop.classList.contains("hidden")) {
        event.preventDefault();
        closeConfig();
        return;
      }
    }

    if (state.listeningForMenuBind) {
      event.preventDefault();
      CONFIG.toggleKey = event.key;
      settingsMenuKeyBtn.textContent = `Menu Key: ${CONFIG.toggleKey}`;
      setFooterText();
      state.listeningForMenuBind = false;
      saveSettings();
      return;
    }

    if (state.listeningForBind && openConfigModule === state.listeningForBind) {
      event.preventDefault();
      const cfg = moduleCfg(openConfigModule);
      cfg.keybind = event.key;
      const item = state.moduleItems.get(openConfigModule);
      if (item) setBindLabel(item, openConfigModule);
      setCurrentBindText(cfg.keybind);
      setBindButtonText("Set keybind");
      state.listeningForBind = null;
      saveSettings();
      return;
    }

    if (event.key === CONFIG.toggleKey) {
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setVisible(!state.visible);
      return;
    }

    if (isTypingTarget(event.target)) return;

    for (const [moduleName, cfg] of ensureModuleConfigStore()) {
      if (cfg.keybind && cfg.keybind === event.key) {
        toggleModule(moduleName);
      }
    }
  });

  // Intentionally no backdrop click-to-close; menus close only via explicit close buttons.

  let dragState = null;
  let resizeState = null;

  const panelDragState = { panelName: null, offsetX: 0, offsetY: 0, shellLeft: 0, shellTop: 0, scale: 1 };

  topbar.addEventListener("mousedown", (event) => {
    const interactiveTarget = event.target instanceof Element
      ? event.target.closest("input, button")
      : null;
    if (interactiveTarget) return;

    const rootBox = root.getBoundingClientRect();
    if (state.displayMode === "loose") {
      const box = topbar.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const scale = getShellScale();
      dragState = {
        mode: "topbar",
        offsetX: event.clientX - box.left,
        offsetY: event.clientY - box.top,
        shellLeft: shellRect.left,
        shellTop: shellRect.top,
        scale,
      };
    } else {
      dragState = {
        mode: "root",
        offsetX: event.clientX - rootBox.left,
        offsetY: event.clientY - rootBox.top,
      };
    }
    event.preventDefault();
  });

  panelByName.forEach((panel, panelName) => {
    const header = panel.querySelector(".zyrox-panel-header");
    header.addEventListener("mousedown", (event) => {
      if (state.displayMode !== "loose") return;
      const box = panel.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const scale = getShellScale();
      panelDragState.panelName = panelName;
      panelDragState.offsetX = event.clientX - box.left;
      panelDragState.offsetY = event.clientY - box.top;
      panelDragState.shellLeft = shellRect.left;
      panelDragState.shellTop = shellRect.top;
      panelDragState.scale = scale;
      event.preventDefault();
      event.stopPropagation();
    });
  });

  document.addEventListener("mousemove", (event) => {
    if (dragState?.mode === "root") {
      const clamped = clampToViewport(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY, root);
      root.style.left = `${clamped.x}px`;
      root.style.top = `${clamped.y}px`;
    }

    if (dragState?.mode === "topbar") {
      const scale = dragState.scale || 1;
      const unclampedX = (event.clientX - dragState.offsetX - dragState.shellLeft) / scale;
      const unclampedY = (event.clientY - dragState.offsetY - dragState.shellTop) / scale;
      const clamped = clampLoosePosition(unclampedX, unclampedY, topbar, scale, {
        left: dragState.shellLeft,
        top: dragState.shellTop,
      });
      state.loosePositions.topbar = clamped;
      topbar.style.left = `${clamped.x}px`;
      topbar.style.top = `${clamped.y}px`;
    }

    if (panelDragState.panelName) {
      const panel = panelByName.get(panelDragState.panelName);
      if (panel) {
        const scale = panelDragState.scale || 1;
        const unclampedX = (event.clientX - panelDragState.offsetX - panelDragState.shellLeft) / scale;
        const unclampedY = (event.clientY - panelDragState.offsetY - panelDragState.shellTop) / scale;
        const clamped = clampLoosePosition(unclampedX, unclampedY, panel, scale, {
          left: panelDragState.shellLeft,
          top: panelDragState.shellTop,
        });
        state.loosePanelPositions[panelDragState.panelName] = clamped;
        panel.style.left = `${clamped.x}px`;
        panel.style.top = `${clamped.y}px`;
      }
    }
  });

  document.addEventListener("mouseup", () => {
    dragState = null;
    resizeState = null;
    panelDragState.panelName = null;
    panelDragState.shellLeft = 0;
    panelDragState.shellTop = 0;
    panelDragState.scale = 1;
  });

  resizeHandle.addEventListener("mousedown", (event) => {
    if (state.displayMode === "loose") return;
    resizeState = {
      startX: event.clientX,
      startY: event.clientY,
      startWidth: state.shellWidth,
      startHeight: state.shellHeight,
    };
    event.preventDefault();
    event.stopPropagation();
  });

  document.addEventListener("mousemove", (event) => {
    if (!resizeState || state.displayMode === "loose") return;

    const width = Math.max(760, resizeState.startWidth + (event.clientX - resizeState.startX));
    const height = Math.max(420, resizeState.startHeight + (event.clientY - resizeState.startY));
    state.shellWidth = width;
    state.shellHeight = height;
    shell.style.width = `${width}px`;
    shell.style.height = `${height}px`;
  });

  // Theme category switching functionality
  const themeCategories = [...settingsMenu.querySelectorAll(".zyrox-theme-category")];
  const themeSections = [...settingsMenu.querySelectorAll(".zyrox-theme-section")];

  themeCategories.forEach((category) => {
    category.addEventListener("click", () => {
      const targetCategory = category.dataset.category;
      
      // Update active category
      themeCategories.forEach((cat) => cat.classList.toggle("active", cat === category));
      
      // Show corresponding section
      themeSections.forEach((section) => {
        section.classList.toggle("active", section.dataset.section === targetCategory);
      });
    });
  });

  } // end initUi

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUi, { once: true });
  } else {
    initUi();
  }
})();
