// ==UserScript==
// @name         Zyrox 1D ability/powerup interceptor test
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Intercepts 1D gamemode packets and logs extracted ability/powerups.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxAbilityTest]";
  const ROOM_DATA = 13;

  function safeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
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

    return {
      transport: "blueboat-binary",
      eventName,
      payload: eventPayload,
      raw: decoded,
    };
  }

  function decodeColyseusPacket(packet) {
    if (!(packet instanceof ArrayBuffer)) return null;
    const bytes = new Uint8Array(packet);
    if (bytes[0] !== ROOM_DATA) return null;

    const first = msgpackDecode(packet, 1);
    if (!first) return null;

    let body = null;
    if (bytes.byteLength > first.offset) {
      const second = msgpackDecode(packet, first.offset);
      body = second?.value;
    }

    return { transport: "colyseus", channel: first.value, payload: body };
  }

  function isOneDimensionalPacket(packet) {
    const gameOptions = packet?.payload?.data?.gameOptions;
    const specialGameType = gameOptions?.specialGameType;
    return Array.isArray(specialGameType) && specialGameType.length > 0;
  }

  function extractPowerups(packet) {
    const direct = packet?.payload?.data?.powerups;
    if (Array.isArray(direct)) {
      return direct.filter((item) => item && typeof item === "object");
    }

    const abilities = packet?.payload?.data?.abilities;
    if (Array.isArray(abilities)) {
      return abilities.filter((item) => item && typeof item === "object");
    }

    return [];
  }

  function handlePacket(decodedPacket, source) {
    if (!decodedPacket) return;

    const key = decodedPacket?.payload?.key || decodedPacket?.payload?.type || "unknown";
    if (!isOneDimensionalPacket(decodedPacket)) return;

    const powerups = extractPowerups(decodedPacket);
    if (!powerups.length) return;

    console.group(`${LOG_PREFIX} 1D ability/powerup packet intercepted`);
    console.log("source:", source);
    console.log("transport:", decodedPacket.transport);
    console.log("packet key:", key);
    console.log("powerup count:", powerups.length);
    console.table(powerups.map((p) => ({
      name: p.displayName || p.name || "unknown",
      baseCost: p.baseCost,
      percentageCost: p.percentageCost,
      disabled: Array.isArray(p.disabled) ? p.disabled.join(",") : p.disabled,
    })));
    console.log("full powerups payload:", safeJson(powerups));
    console.groupEnd();
  }

  const originalSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function sendPatched(data) {
    if (!this.__zyroxAbilityHooked) {
      this.__zyroxAbilityHooked = true;
      this.addEventListener("message", (event) => {
        const payload = event.data;

        if (!(payload instanceof ArrayBuffer)) return;

        handlePacket(decodeBlueboatBinary(payload), "socket.io/blueboat");
        handlePacket(decodeColyseusPacket(payload), "colyseus");
      });
    }

    return originalSend.apply(this, arguments);
  };

  console.log(`${LOG_PREFIX} ready - waiting for 1D ability/powerup packets.`);
})();
