// ==UserScript==
// @name         Zyrox classic packet logger
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Intercepts and logs relevant Classic-mode packets (Colyseus / 2D only).
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxClassicLogger]";
  const COLYSEUS_ROOM_DATA = 13;
  const ENABLED = true;

  // Only keep packet keys useful for building/maintaining classic auto-answer logic.
  const RELEVANT_KEYS = new Set([
    "AUTH_ID",
    "DEVICES_STATES_CHANGES",
    "STATE_UPDATE",
    "GAME_QUESTIONS",
    "PLAYER_QUESTION_LIST",
    "PLAYER_QUESTION_LIST_INDEX",
    "QUESTION_ANSWERED",
    "MESSAGE_FOR_DEVICE",
  ]);

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
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
        else if ((byte & 0xe0) === 0xc0) {
          out += String.fromCharCode(((byte & 0x1f) << 6) | (view.getUint8(offset++) & 0x3f));
        } else if ((byte & 0xf0) === 0xe0) {
          out += String.fromCharCode(
            ((byte & 0x0f) << 12) |
              ((view.getUint8(offset++) & 0x3f) << 6) |
              (view.getUint8(offset++) & 0x3f),
          );
        } else {
          // Minimal 4-byte UTF-8 decode support.
          const codePoint =
            ((byte & 0x07) << 18) |
            ((view.getUint8(offset++) & 0x3f) << 12) |
            ((view.getUint8(offset++) & 0x3f) << 6) |
            (view.getUint8(offset++) & 0x3f);
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
        case 192:
          return null;
        case 194:
          return false;
        case 195:
          return true;
        case 202: {
          const v = view.getFloat32(offset);
          offset += 4;
          return v;
        }
        case 203: {
          const v = view.getFloat64(offset);
          offset += 8;
          return v;
        }
        case 204: {
          const v = view.getUint8(offset);
          offset += 1;
          return v;
        }
        case 205: {
          const v = view.getUint16(offset);
          offset += 2;
          return v;
        }
        case 206: {
          const v = view.getUint32(offset);
          offset += 4;
          return v;
        }
        case 208: {
          const v = view.getInt8(offset);
          offset += 1;
          return v;
        }
        case 209: {
          const v = view.getInt16(offset);
          offset += 2;
          return v;
        }
        case 210: {
          const v = view.getInt32(offset);
          offset += 4;
          return v;
        }
        case 217: {
          const n = view.getUint8(offset);
          offset += 1;
          return readString(n);
        }
        case 218: {
          const n = view.getUint16(offset);
          offset += 2;
          return readString(n);
        }
        case 219: {
          const n = view.getUint32(offset);
          offset += 4;
          return readString(n);
        }
        case 220: {
          const n = view.getUint16(offset);
          offset += 2;
          const arr = [];
          for (let i = 0; i < n; i++) arr.push(read());
          return arr;
        }
        case 221: {
          const n = view.getUint32(offset);
          offset += 4;
          const arr = [];
          for (let i = 0; i < n; i++) arr.push(read());
          return arr;
        }
        case 222: {
          const n = view.getUint16(offset);
          offset += 2;
          const map = {};
          for (let i = 0; i < n; i++) map[read()] = read();
          return map;
        }
        case 223: {
          const n = view.getUint32(offset);
          offset += 4;
          const map = {};
          for (let i = 0; i < n; i++) map[read()] = read();
          return map;
        }
        default:
          return null;
      }
    };

    const value = read();
    return { value, offset };
  }

  function parseDeviceChanges(message) {
    const result = [];
    for (const change of message?.changes || []) {
      const row = {};
      const keys = change[1].map((idx) => message.values[idx]);
      for (let i = 0; i < keys.length; i++) row[keys[i]] = change[2][i];
      result.push({ deviceId: change[0], data: row });
    }
    return result;
  }

  function isQuestionRelevantChange(data, playerId) {
    if (!data || typeof data !== "object") return false;
    const ownQuestionKey = playerId ? `PLAYER_${playerId}_currentQuestionId` : null;

    return Object.keys(data).some((key) => {
      if (key === "GLOBAL_questions") return true;
      if (ownQuestionKey && key === ownQuestionKey) return true;
      return key.includes("QUESTION") || key.includes("question");
    });
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

    return {
      type: first.value,
      message,
    };
  }

  function logIncoming(decoded, state) {
    if (!decoded) return;
    const { type, message } = decoded;

    if (type === "AUTH_ID") {
      state.playerId = message;
      console.log(LOG_PREFIX, "[IN] AUTH_ID", message);
      return;
    }

    if (type === "DEVICES_STATES_CHANGES") {
      const parsed = parseDeviceChanges(message);
      const filtered = parsed.filter(({ data }) => isQuestionRelevantChange(data, state.playerId));
      if (filtered.length) {
        console.log(LOG_PREFIX, "[IN] DEVICES_STATES_CHANGES(question-related)", filtered);
      }
      return;
    }

    if (RELEVANT_KEYS.has(type)) {
      console.log(LOG_PREFIX, `[IN] ${type}`, message);
    }
  }

  function logOutgoing(raw) {
    const decoded = decodeColyseusPacket(raw);
    if (!decoded) return;
    if (!RELEVANT_KEYS.has(decoded.type)) return;
    console.log(LOG_PREFIX, `[OUT] ${decoded.type}`, decoded.message);
  }

  function install() {
    const state = {
      playerId: null,
      sockets: new Set(),
    };

    const NativeWebSocket = window.WebSocket;

    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);

        const target = String(url || "");
        // The request asks for Colyseus-only support for now.
        if (!target.includes("gimkitconnect.com")) return;

        state.sockets.add(this);
        console.log(LOG_PREFIX, "Attached to Colyseus socket:", target);

        this.addEventListener("message", (event) => {
          try {
            const decoded = decodeColyseusPacket(event.data);
            logIncoming(decoded, state);
          } catch (err) {
            console.warn(LOG_PREFIX, "Failed to decode incoming packet:", err);
          }
        });
      }

      send(data) {
        try {
          logOutgoing(data);
        } catch (err) {
          console.warn(LOG_PREFIX, "Failed to decode outgoing packet:", err);
        }
        return super.send(data);
      }
    };

    console.log(
      LOG_PREFIX,
      "Classic logger ready (Colyseus only, 2D modes). Relevant packet keys:",
      [...RELEVANT_KEYS].join(", "),
    );

    window.__zyroxClassicLogger = {
      enabled: ENABLED,
      relevantKeys: [...RELEVANT_KEYS],
      dumpState() {
        return {
          playerId: state.playerId,
          activeSockets: state.sockets.size,
          relevantKeys: [...RELEVANT_KEYS],
        };
      },
      rawDecode(arrayBuffer) {
        const decoded = decodeColyseusPacket(arrayBuffer);
        return decoded ? safeJson(decoded) : null;
      },
    };
  }

  install();
})();
