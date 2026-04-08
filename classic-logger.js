// ==UserScript==
// @name         Zyrox classic packet logger
// @namespace    https://github.com/zyrox
// @version      0.3.0
// @description  Intercepts and logs Classic-mode packets (Colyseus/Blueboat 2D transport).
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxClassicLogger]";
  const COLYSEUS_ROOM_DATA = 13;
  const ENGINE_PACKET_TYPES = { "0": "OPEN", "1": "CLOSE", "2": "PING", "3": "PONG", "4": "MESSAGE", "5": "UPGRADE", "6": "NOOP" };
  const SOCKET_PACKET_TYPES = { "0": "CONNECT", "1": "DISCONNECT", "2": "EVENT", "3": "ACK", "4": "ERROR", "5": "BINARY_EVENT", "6": "BINARY_ACK" };

  const state = {
    playerId: null,
    sockets: new Set(),
    logEverything: true,
  };

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function preview(value, max = 320) {
    const text = typeof value === "string" ? value : safeJson(value);
    return text.length <= max ? text : `${text.slice(0, max)}… (truncated, ${text.length} chars)`;
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
        case 196: {
          const n = view.getUint8(offset); offset += 1;
          const out = buffer.slice(offset, offset + n); offset += n;
          return out;
        }
        case 197: {
          const n = view.getUint16(offset); offset += 2;
          const out = buffer.slice(offset, offset + n); offset += n;
          return out;
        }
        case 198: {
          const n = view.getUint32(offset); offset += 4;
          const out = buffer.slice(offset, offset + n); offset += n;
          return out;
        }
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

  function parseDeviceChanges(message) {
    const result = [];
    for (const change of message?.changes || []) {
      const row = {};
      const keys = Array.isArray(change?.[1]) ? change[1].map((idx) => message.values[idx]) : [];
      for (let i = 0; i < keys.length; i++) row[keys[i]] = change[2]?.[i];
      result.push({ deviceId: change?.[0], data: row });
    }
    return result;
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
      try {
        payload = JSON.parse(jsonCandidate);
      } catch {
        payload = payloadRaw;
      }
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

  function logDecoded(direction, decoded) {
    if (!decoded) return;

    if (decoded.transport === "colyseus") {
      if (decoded.channel === "AUTH_ID") state.playerId = decoded.body;
      if (decoded.channel === "DEVICES_STATES_CHANGES") {
        console.log(LOG_PREFIX, `[${direction}] COLYSEUS DEVICES_STATES_CHANGES`, parseDeviceChanges(decoded.body));
        return;
      }
      console.log(LOG_PREFIX, `[${direction}] COLYSEUS ${String(decoded.channel)}`, decoded.body);
      return;
    }

    if (decoded.transport === "blueboat-binary") {
      const eventLabel = decoded.eventName ? ` ${decoded.eventName}` : "";
      console.log(LOG_PREFIX, `[${direction}] BLUEBOAT_BINARY${eventLabel}`, decoded.payload);
      return;
    }

    const label = decoded.socketType ? `${decoded.engineType}/${decoded.socketType}` : decoded.engineType;
    console.log(LOG_PREFIX, `[${direction}] ${label}`, decoded.payload ?? decoded.raw);
  }

  async function normalizeData(raw) {
    if (raw instanceof ArrayBuffer) return raw;
    if (ArrayBuffer.isView(raw)) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    if (typeof Blob !== "undefined" && raw instanceof Blob) return raw.arrayBuffer();
    return raw;
  }

  async function inspectPacket(direction, raw) {
    const normalized = await normalizeData(raw);

    if (typeof normalized === "string") {
      const decodedText = decodeEngineSocketString(normalized);
      if (decodedText) logDecoded(direction, decodedText);
      else if (state.logEverything) console.log(LOG_PREFIX, `[${direction}] TEXT_RAW`, preview(normalized));
      return;
    }

    const colyseus = decodeColyseusPacket(normalized);
    if (colyseus) {
      logDecoded(direction, colyseus);
      return;
    }

    const blueboatBinary = decodeBlueboatBinary(normalized);
    if (blueboatBinary) {
      logDecoded(direction, blueboatBinary);
      return;
    }

    if (state.logEverything) {
      const size = normalized instanceof ArrayBuffer ? normalized.byteLength : 0;
      console.log(LOG_PREFIX, `[${direction}] BINARY_RAW length=${size}`);
    }
  }

  function install() {
    const NativeWebSocket = window.WebSocket;

    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);

        const target = String(url || "");
        if (!target.includes("gimkitconnect.com")) return;

        state.sockets.add(this);
        console.log(LOG_PREFIX, "Attached to Gimkit socket:", target);

        this.addEventListener("message", (event) => {
          inspectPacket("IN", event.data).catch((err) => console.warn(LOG_PREFIX, "Failed to inspect incoming packet:", err));
        });
      }

      send(data) {
        inspectPacket("OUT", data).catch((err) => console.warn(LOG_PREFIX, "Failed to inspect outgoing packet:", err));
        return super.send(data);
      }
    };

    console.log(LOG_PREFIX, "Classic logger ready (verbose mode). Logging Colyseus + Blueboat binary + Engine/Socket.IO frames.");

    window.__zyroxClassicLogger = {
      getState() {
        return {
          playerId: state.playerId,
          activeSockets: state.sockets.size,
          logEverything: state.logEverything,
        };
      },
      setVerboseLogging(enabled) {
        state.logEverything = Boolean(enabled);
        console.log(LOG_PREFIX, "Verbose logging:", state.logEverything ? "ON" : "OFF");
      },
      rawDecode(packet) {
        const decoded = decodeColyseusPacket(packet) || decodeBlueboatBinary(packet) || decodeEngineSocketString(packet);
        return safeJson(decoded);
      },
    };
  }

  install();
})();
