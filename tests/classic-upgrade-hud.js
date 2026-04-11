// ==UserScript==
// @name         Zyrox classic upgrade HUD logger
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Logs Classic upgrade level changes from Blueboat packets.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxClassicUpgradeHud]";

  const state = {
    sockets: new Set(),
    upgradeLevels: Object.create(null),
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
        case 196: {
          const n = view.getUint8(offset);
          offset += 1;
          const out = buffer.slice(offset, offset + n);
          offset += n;
          return out;
        }
        case 197: {
          const n = view.getUint16(offset);
          offset += 2;
          const out = buffer.slice(offset, offset + n);
          offset += n;
          return out;
        }
        case 198: {
          const n = view.getUint32(offset);
          offset += 4;
          const out = buffer.slice(offset, offset + n);
          offset += n;
          return out;
        }
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

  async function normalizeData(raw) {
    if (raw instanceof ArrayBuffer) return raw;
    if (ArrayBuffer.isView(raw)) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    if (typeof Blob !== "undefined" && raw instanceof Blob) return raw.arrayBuffer();
    return raw;
  }

  function logUpgradeChanges(nextLevels) {
    if (!nextLevels || typeof nextLevels !== "object") return;

    const keys = Object.keys(nextLevels);
    for (const upgradeName of keys) {
      const level = nextLevels[upgradeName];
      const prev = state.upgradeLevels[upgradeName];
      if (prev === level) continue;

      state.upgradeLevels[upgradeName] = level;
      console.log(LOG_PREFIX, `${upgradeName}: level ${level}`, { previousLevel: prev ?? null, level });
    }
  }

  function onDecodedPacket(decoded) {
    if (!decoded || decoded.transport !== "blueboat-binary") return;
    if (typeof decoded.eventName !== "string" || !decoded.eventName.startsWith("message-")) return;

    const packet = decoded.payload;
    if (!packet || packet.key !== "STATE_UPDATE") return;
    if (packet.data?.type !== "UPGRADE_LEVELS") return;

    logUpgradeChanges(packet.data?.value);
  }

  async function inspectPacket(raw) {
    const normalized = await normalizeData(raw);
    if (typeof normalized === "string") return;

    const decoded = decodeBlueboatBinary(normalized);
    onDecodedPacket(decoded);
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
          inspectPacket(event.data).catch((err) => {
            console.warn(LOG_PREFIX, "Failed to inspect incoming packet:", err);
          });
        });
      }
    };

    console.log(LOG_PREFIX, "Ready. Logging UPGRADE_LEVELS changes.");
  }

  install();
})();
