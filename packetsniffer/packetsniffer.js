// ==UserScript==
// @name         Zyrox packet sniffer
// @namespace    https://github.com/zyrox
// @version      0.6.0
// @description  Logs every websocket packet with a split-pane sidebar UI.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  // ─── Constants ────────────────────────────────────────────────────────────────
  const PREFIX = "[PacketSniffer]";
  const MAX_PACKETS = 500;
  const DEFAULT_WIDTH = 800;
  const MIN_WIDTH = 320;
  const COLYSEUS_ROOM_DATA = 13;

  const ENGINE_PACKET_TYPES = {
    "0": "OPEN", "1": "CLOSE", "2": "PING", "3": "PONG",
    "4": "MESSAGE", "5": "UPGRADE", "6": "NOOP",
  };
  const SOCKET_PACKET_TYPES = {
    "0": "CONNECT", "1": "DISCONNECT", "2": "EVENT",
    "3": "ACK", "4": "ERROR", "5": "BINARY_EVENT", "6": "BINARY_ACK",
  };

  // ─── Packet parsing ───────────────────────────────────────────────────────────
  function tryJson(input) {
    if (typeof input !== "string") return null;
    try { return JSON.parse(input); } catch { return null; }
  }

  function parseTextPacket(text) {
    if (!text || typeof text !== "string") return { raw: text };
    const engineType = text[0];
    const engineName = ENGINE_PACKET_TYPES[engineType] || "UNKNOWN";
    const payload = text.slice(1);
    if (engineType !== "4") return { engineType, engineName, payload, raw: text };
    const socketType = payload[0];
    const socketName = SOCKET_PACKET_TYPES[socketType] || "UNKNOWN";
    const body = payload.slice(1);
    return { engineType, engineName, socketType, socketName, body, json: tryJson(body), raw: text };
  }

  function toHex(bytes) {
    const parts = [];
    for (let i = 0; i < bytes.length; i++) {
      if (i > 0 && i % 16 === 0) parts.push("\n");
      else if (i > 0 && i % 8 === 0) parts.push("  ");
      else if (i > 0) parts.push(" ");
      parts.push(bytes[i].toString(16).padStart(2, "0"));
    }
    return parts.join("");
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

    return { transport: "blueboat-binary", eventName, payload: eventPayload, raw: decoded };
  }

  function decodeStructuredBinary(buffer) {
    return decodeColyseusPacket(buffer) || decodeBlueboatBinary(buffer);
  }

  function parseBinaryPacket(value) {
    let bytes = null;

    if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else if (value instanceof Blob) {
      // Async: return a placeholder and patch the packet when the blob is read
      const meta = { kind: "Blob", bytes: value.size, text: null, json: null, hex: null, _loading: true };
      value.arrayBuffer().then(buf => {
        const u8 = new Uint8Array(buf);
        meta.hex = toHex(u8);
        if (decodeStructuredBinaryEnabled) {
          const decoded = decodeStructuredBinary(buf);
          if (decoded) {
            meta.protocol = decoded.transport;
            meta.json = decoded;
            meta.text = JSON.stringify(decoded);
          }
        }
        meta._loading = false;
        try {
          if (!meta.text) meta.text = new TextDecoder("utf-8", { fatal: true }).decode(u8);
          if (!meta.json) meta.json = tryJson(meta.text);
        } catch { /**/ }
        // If this packet is currently open in the viewer, refresh it
        const p = packets.find(x => x.parsed === meta);
        if (p && p.id === selectedId) openViewer(p);
      }).catch(() => { meta._loading = false; });
      return meta;
    }

    if (!bytes) return { kind: typeof value, bytes: 0, hex: null, text: null, json: null };

    const hex = toHex(bytes);
    let text = null, json = null;
    let protocol = null;

    if (decodeStructuredBinaryEnabled) {
      const rawBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const decoded = decodeStructuredBinary(rawBuffer);
      if (decoded) {
        protocol = decoded.transport;
        json = decoded;
        text = JSON.stringify(decoded);
      }
    }

    try {
      if (!text) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!json) json = tryJson(text);
    } catch { /**/ }

    return { kind: "Binary", bytes: bytes.length, text, json, hex, protocol };
  }

  // ─── State ────────────────────────────────────────────────────────────────────
  let packets = [];
  let packetId = 0;
  let sidebarOpen = true;
  let filterText = "";
  let filterDir = "ALL";
  let autoScroll = true;
  let decodeStructuredBinaryEnabled = true;
  let selectedId = null;
  let currentWidth = DEFAULT_WIDTH;

  let sidebar, listEl, countEl, filterInput, viewerPanel;

  // ─── Page margin ─────────────────────────────────────────────────────────────
  function applyPageMargin() {
    document.body.style.marginRight = sidebarOpen ? currentWidth + "px" : "0";
    document.body.style.transition = "margin-right 0.25s cubic-bezier(0.4,0,0.2,1)";
    document.body.style.boxSizing = "border-box";
  }

  // ─── Styles ───────────────────────────────────────────────────────────────────
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');

      #zyrox-sidebar {
        position: fixed;
        top: 0; right: 0;
        width: ${DEFAULT_WIDTH}px;
        height: 100vh;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        font-family: 'JetBrains Mono', monospace;
        font-size: 16px;
        background: rgba(8, 10, 18, 0.98);
        border-left: 1px solid rgba(0, 255, 136, 0.15);
        box-shadow: -12px 0 50px rgba(0,0,0,0.7), inset 1px 0 0 rgba(0,255,136,0.05);
        transform: translateX(0);
        transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        backdrop-filter: blur(12px);
        user-select: none;
      }
      #zyrox-sidebar.hidden { transform: translateX(100%); }

      /* ── Resize handle ── */
      #zyrox-resize-handle {
        position: absolute;
        left: 0; top: 0;
        width: 5px; height: 100%;
        cursor: ew-resize;
        z-index: 10;
        background: transparent;
        transition: background 0.15s;
      }
      #zyrox-resize-handle:hover,
      #zyrox-resize-handle.dragging { background: rgba(0,255,136,0.18); }

      /* ── Header ── */
      #zyrox-header {
        position: relative;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px 12px 20px;
        background: rgba(0,255,136,0.04);
        border-bottom: 1px solid rgba(0,255,136,0.12);
        flex-shrink: 0;
        overflow: hidden;
      }
      #zyrox-header::after {
        content: '';
        position: absolute; inset: 0;
        background: repeating-linear-gradient(
          0deg, transparent, transparent 2px,
          rgba(0,255,136,0.012) 2px, rgba(0,255,136,0.012) 4px
        );
        pointer-events: none;
      }
      #zyrox-logo {
        width: 18px; height: 18px;
        background: #00ff88;
        clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
        flex-shrink: 0;
      }
      #zyrox-title {
        color: #00ff88;
        font-weight: 700;
        font-size: 18px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        flex: 1;
      }
      #zyrox-count { color: rgba(0,255,136,0.45); font-size: 13px; letter-spacing: 0.05em; }
      #zyrox-toggle-btn {
        background: none;
        border: 1px solid rgba(0,255,136,0.2);
        color: rgba(0,255,136,0.55);
        cursor: pointer;
        padding: 4px 10px;
        font-family: inherit;
        font-size: 13px;
        border-radius: 3px;
        transition: all 0.15s;
        letter-spacing: 0.05em;
        flex-shrink: 0;
      }
      #zyrox-toggle-btn:hover { background: rgba(0,255,136,0.08); color: #00ff88; border-color: rgba(0,255,136,0.45); }

      /* ── Controls ── */
      #zyrox-controls {
        display: flex;
        gap: 6px;
        padding: 8px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        flex-shrink: 0;
        align-items: center;
      }
      #zyrox-filter-input {
        flex: 1; min-width: 0;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 4px;
        color: #e0e0e0;
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        padding: 6px 10px;
        outline: none;
        transition: border-color 0.15s;
      }
      #zyrox-filter-input::placeholder { color: rgba(255,255,255,0.2); }
      #zyrox-filter-input:focus { border-color: rgba(0,255,136,0.4); }

      .zyrox-dir-btn {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.07);
        color: rgba(255,255,255,0.35);
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        padding: 5px 9px;
        border-radius: 4px;
        cursor: pointer;
        letter-spacing: 0.06em;
        transition: all 0.15s;
        white-space: nowrap; flex-shrink: 0;
      }
      .zyrox-dir-btn:hover { color: rgba(255,255,255,0.65); border-color: rgba(255,255,255,0.18); }
      .zyrox-dir-btn.active-all  { background: rgba(150,150,255,0.1);  border-color: rgba(150,150,255,0.35); color: #aaaaff; }
      .zyrox-dir-btn.active-in   { background: rgba(0,200,255,0.08);   border-color: rgba(0,200,255,0.35);   color: #00c8ff; }
      .zyrox-dir-btn.active-out  { background: rgba(255,180,0,0.08);   border-color: rgba(255,180,0,0.35);   color: #ffb400; }

      #zyrox-clear-btn {
        background: rgba(255,60,60,0.05);
        border: 1px solid rgba(255,60,60,0.14);
        color: rgba(255,100,100,0.55);
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        padding: 5px 9px;
        border-radius: 4px;
        cursor: pointer;
        letter-spacing: 0.04em;
        transition: all 0.15s;
        white-space: nowrap; flex-shrink: 0;
      }
      #zyrox-clear-btn:hover { background: rgba(255,60,60,0.12); color: #ff6464; border-color: rgba(255,60,60,0.3); }

      #zyrox-decode-btn {
        background: rgba(0,255,136,0.06);
        border: 1px solid rgba(0,255,136,0.22);
        color: rgba(0,255,136,0.7);
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        padding: 5px 9px;
        border-radius: 4px;
        cursor: pointer;
        letter-spacing: 0.04em;
        transition: all 0.15s;
        white-space: nowrap; flex-shrink: 0;
      }
      #zyrox-decode-btn.off {
        background: rgba(255,255,255,0.03);
        border-color: rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.4);
      }
      #zyrox-decode-btn:hover { border-color: rgba(0,255,136,0.45); color: #00ff88; }

      /* ── Split body ── */
      #zyrox-body {
        flex: 1;
        display: flex;
        flex-direction: row;
        overflow: hidden;
        min-height: 0;
      }

      /* ── List panel ── */
      #zyrox-list-panel {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 180px;
        overflow: hidden;
      }
      #zyrox-list {
        flex: 1;
        overflow-y: auto;
        padding: 2px 0;
      }
      #zyrox-list::-webkit-scrollbar { width: 5px; }
      #zyrox-list::-webkit-scrollbar-track { background: transparent; }
      #zyrox-list::-webkit-scrollbar-thumb { background: rgba(0,255,136,0.18); border-radius: 3px; }

      .zyrox-packet {
        display: grid;
        grid-template-columns: 38px 72px 1fr auto;
        gap: 0 8px;
        align-items: center;
        padding: 7px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.025);
        cursor: pointer;
        transition: background 0.08s;
        min-width: 0;
      }
      .zyrox-packet:hover  { background: rgba(255,255,255,0.03); }
      .zyrox-packet.active {
        background: rgba(0,255,136,0.06);
        border-left: 2px solid rgba(0,255,136,0.55);
        padding-left: 10px;
      }

      .zyrox-dir-badge { font-size: 13px; font-weight: 700; letter-spacing: 0.07em; text-align: center; }
      .zyrox-dir-badge.IN  { color: #00c8ff; }
      .zyrox-dir-badge.OUT { color: #ffb400; }

      .zyrox-type-tag {
        font-size: 13px; letter-spacing: 0.04em;
        color: rgba(255,255,255,0.28);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .zyrox-body-preview {
        font-size: 13px; color: rgba(255,255,255,0.5);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
      }
      .zyrox-time { font-size: 12px; color: rgba(255,255,255,0.18); white-space: nowrap; }

      /* ── Divider ── */
      #zyrox-divider {
        width: 1px; flex-shrink: 0;
        background: rgba(255,255,255,0.07);
        display: none;
      }
      #zyrox-divider.visible { display: block; }

      /* ── Viewer panel ── */
      #zyrox-viewer {
        width: 55%; flex-shrink: 0;
        display: none;
        flex-direction: column;
        background: rgba(4, 6, 14, 0.65);
        overflow: hidden;
        min-width: 200px;
      }
      #zyrox-viewer.visible { display: flex; }

      #zyrox-viewer-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 9px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        flex-shrink: 0;
        background: rgba(0,0,0,0.22);
      }
      #zyrox-viewer-dir {
        font-size: 13px; font-weight: 700;
        letter-spacing: 0.08em;
        padding: 3px 8px;
        border-radius: 3px;
        flex-shrink: 0;
      }
      #zyrox-viewer-dir.IN  { color: #00c8ff; background: rgba(0,200,255,0.1);  border: 1px solid rgba(0,200,255,0.22); }
      #zyrox-viewer-dir.OUT { color: #ffb400; background: rgba(255,180,0,0.1);  border: 1px solid rgba(255,180,0,0.22); }
      #zyrox-viewer-meta { flex: 1; min-width: 0; }
      #zyrox-viewer-type {
        font-size: 14px; color: rgba(255,255,255,0.7);
        font-weight: 600; letter-spacing: 0.06em;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #zyrox-viewer-time { font-size: 12px; color: rgba(255,255,255,0.2); margin-top: 2px; }

      .zyrox-viewer-action {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.35);
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        padding: 4px 9px;
        border-radius: 3px;
        cursor: pointer;
        letter-spacing: 0.04em;
        transition: all 0.15s;
        white-space: nowrap; flex-shrink: 0;
      }
      .zyrox-viewer-action:hover { color: rgba(255,255,255,0.7); border-color: rgba(255,255,255,0.2); }
      .zyrox-viewer-action.copied { color: #00ff88; border-color: rgba(0,255,136,0.3); }

      #zyrox-viewer-close {
        background: none; border: none;
        color: rgba(255,255,255,0.22);
        font-size: 18px; cursor: pointer;
        padding: 0 2px; line-height: 1;
        transition: color 0.15s; font-family: inherit;
        flex-shrink: 0;
      }
      #zyrox-viewer-close:hover { color: rgba(255,100,100,0.75); }

      /* ── Viewer tabs ── */
      #zyrox-viewer-tabs {
        display: flex;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        flex-shrink: 0;
      }
      .zyrox-tab {
        padding: 6px 16px;
        font-size: 13px; letter-spacing: 0.07em;
        color: rgba(255,255,255,0.28);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        transition: all 0.15s;
        background: none;
        border-top: none; border-left: none; border-right: none;
        font-family: 'JetBrains Mono', monospace;
      }
      .zyrox-tab:hover { color: rgba(255,255,255,0.6); }
      .zyrox-tab.active { color: #00ff88; border-bottom-color: #00ff88; }

      /* ── Viewer content ── */
      #zyrox-viewer-body {
        flex: 1; overflow: hidden;
        position: relative; min-height: 0;
      }
      .zyrox-view-pane {
        position: absolute; inset: 0;
        overflow-y: auto;
        padding: 12px 14px;
        display: none;
        /* SELECTABLE */
        user-select: text;
        -webkit-user-select: text;
        cursor: text;
        tab-size: 2;
        -moz-tab-size: 2;
      }
      .zyrox-view-pane.active { display: block; }
      .zyrox-view-pane::-webkit-scrollbar { width: 5px; }
      .zyrox-view-pane::-webkit-scrollbar-thumb { background: rgba(0,255,136,0.15); border-radius: 3px; }

      /* JSON */
      .zyrox-json-root { font-size: 14px; line-height: 1.75; }
      .zyrox-json-key   { color: #7ec8e3; }
      .zyrox-json-str   { color: #a8e6a3; }
      .zyrox-json-num   { color: #f0c080; }
      .zyrox-json-bool  { color: #e07070; }
      .zyrox-json-null  { color: rgba(255,255,255,0.3); }
      .zyrox-json-brace { color: rgba(255,255,255,0.38); }
      .zyrox-json-indent { display: block; padding-left: 20px; }
      .zyrox-json-line { display: flex; gap: 4px; white-space: pre-wrap; word-break: break-all; }

      /* Hex dump */
      .zyrox-hex-dump {
        font-size: 13px; line-height: 1.7;
        color: rgba(255,255,255,0.45);
        white-space: pre; font-family: 'JetBrains Mono', monospace;
        word-break: break-all;
      }
      .zyrox-binary-meta {
        font-size: 13px; color: rgba(255,255,255,0.28);
        margin-bottom: 10px; letter-spacing: 0.03em;
      }
      .zyrox-binary-meta span { color: rgba(0,255,136,0.6); }

      /* Raw */
      #zyrox-raw-pane pre {
        font-size: 14px; line-height: 1.65;
        color: rgba(255,255,255,0.5);
        white-space: pre-wrap; word-break: break-all; margin: 0;
      }

      /* Loading indicator */
      .zyrox-loading {
        color: rgba(255,255,255,0.3);
        font-size: 13px;
        font-style: italic;
      }

      /* ── Footer ── */
      #zyrox-footer {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 16px;
        border-top: 1px solid rgba(255,255,255,0.04);
        flex-shrink: 0;
        background: rgba(0,0,0,0.2);
      }
      #zyrox-status { font-size: 12px; color: rgba(255,255,255,0.2); letter-spacing: 0.05em; }
      #zyrox-autoscroll-toggle {
        display: flex; align-items: center; gap: 6px;
        cursor: pointer; font-size: 12px; color: rgba(255,255,255,0.28);
        letter-spacing: 0.05em; transition: color 0.15s;
      }
      #zyrox-autoscroll-toggle:hover { color: rgba(255,255,255,0.55); }
      #zyrox-autoscroll-toggle.on { color: rgba(0,255,136,0.65); }
      #zyrox-autoscroll-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: rgba(255,255,255,0.18); transition: background 0.15s;
      }
      #zyrox-autoscroll-toggle.on #zyrox-autoscroll-dot { background: #00ff88; }

    `;
    document.head.appendChild(style);
  }

  // ─── Build DOM ────────────────────────────────────────────────────────────────
  function buildSidebar() {
    sidebar = document.createElement("div");
    sidebar.id = "zyrox-sidebar";
    if (!sidebarOpen) sidebar.classList.add("hidden");

    sidebar.innerHTML = `
      <div id="zyrox-resize-handle"></div>
      <div id="zyrox-header">
        <div id="zyrox-logo"></div>
        <span id="zyrox-title">PacketSniffer</span>
        <span id="zyrox-count">0 pkts</span>
        <button id="zyrox-toggle-btn">HIDE [K]</button>
      </div>
      <div id="zyrox-controls">
        <input id="zyrox-filter-input" type="text" placeholder="filter packets…" />
        <button class="zyrox-dir-btn active-all" data-dir="ALL">ALL</button>
        <button class="zyrox-dir-btn" data-dir="IN">IN</button>
        <button class="zyrox-dir-btn" data-dir="OUT">OUT</button>
        <button id="zyrox-decode-btn">DEC ON</button>
        <button id="zyrox-clear-btn">CLR</button>
      </div>
      <div id="zyrox-body">
        <div id="zyrox-list-panel">
          <div id="zyrox-list"></div>
        </div>
        <div id="zyrox-divider"></div>
        <div id="zyrox-viewer">
          <div id="zyrox-viewer-header">
            <span id="zyrox-viewer-dir">IN</span>
            <div id="zyrox-viewer-meta">
              <div id="zyrox-viewer-type">—</div>
              <div id="zyrox-viewer-time">—</div>
            </div>
            <button class="zyrox-viewer-action" id="zyrox-copy-btn">COPY</button>
            <button id="zyrox-viewer-close">✕</button>
          </div>
          <div id="zyrox-viewer-tabs">
            <button class="zyrox-tab active" data-tab="json">JSON</button>
            <button class="zyrox-tab" data-tab="raw">RAW</button>
            <button class="zyrox-tab" data-tab="hex">HEX</button>
          </div>
          <div id="zyrox-viewer-body">
            <div class="zyrox-view-pane active" id="zyrox-json-pane">
              <div class="zyrox-json-root" id="zyrox-json-tree"></div>
            </div>
            <div class="zyrox-view-pane" id="zyrox-raw-pane">
              <pre id="zyrox-raw-content"></pre>
            </div>
            <div class="zyrox-view-pane" id="zyrox-hex-pane">
              <div id="zyrox-hex-content"></div>
            </div>
          </div>
        </div>
      </div>
      <div id="zyrox-footer">
        <span id="zyrox-status">CONNECTED</span>
        <div id="zyrox-autoscroll-toggle" class="on">
          <div id="zyrox-autoscroll-dot"></div>
          AUTO-SCROLL
        </div>
      </div>
    `;

    document.body.appendChild(sidebar);

    listEl      = sidebar.querySelector("#zyrox-list");
    countEl     = sidebar.querySelector("#zyrox-count");
    filterInput = sidebar.querySelector("#zyrox-filter-input");
    viewerPanel = sidebar.querySelector("#zyrox-viewer");

    // ── Wire events ──
    sidebar.querySelector("#zyrox-toggle-btn").addEventListener("click", toggleSidebar);

    sidebar.querySelector("#zyrox-clear-btn").addEventListener("click", () => {
      packets = [];
      listEl.innerHTML = "";
      closeViewer();
      updateCount();
    });

    sidebar.querySelector("#zyrox-decode-btn").addEventListener("click", function() {
      decodeStructuredBinaryEnabled = !decodeStructuredBinaryEnabled;
      this.textContent = decodeStructuredBinaryEnabled ? "DEC ON" : "DEC OFF";
      this.classList.toggle("off", !decodeStructuredBinaryEnabled);
    });

    filterInput.addEventListener("input", () => {
      filterText = filterInput.value.trim().toLowerCase();
      rerenderList();
    });

    sidebar.querySelectorAll(".zyrox-dir-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        filterDir = btn.dataset.dir;
        sidebar.querySelectorAll(".zyrox-dir-btn").forEach(b => {
          b.className = "zyrox-dir-btn";
          if (b.dataset.dir === filterDir) b.classList.add(`active-${filterDir.toLowerCase()}`);
        });
        rerenderList();
      });
    });

    sidebar.querySelector("#zyrox-autoscroll-toggle").addEventListener("click", function() {
      autoScroll = !autoScroll;
      this.classList.toggle("on", autoScroll);
    });

    sidebar.querySelector("#zyrox-viewer-close").addEventListener("click", closeViewer);

    sidebar.querySelectorAll(".zyrox-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        sidebar.querySelectorAll(".zyrox-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        sidebar.querySelectorAll(".zyrox-view-pane").forEach(p => p.classList.remove("active"));
        sidebar.querySelector(`#zyrox-${tab.dataset.tab}-pane`).classList.add("active");
      });
    });

    sidebar.querySelector("#zyrox-copy-btn").addEventListener("click", function() {
      const p = packets.find(x => x.id === selectedId);
      if (!p) return;
      navigator.clipboard.writeText(getFullBody(p.parsed)).then(() => {
        this.textContent = "COPIED";
        this.classList.add("copied");
        setTimeout(() => { this.textContent = "COPY"; this.classList.remove("copied"); }, 1200);
      });
    });

    // ── Resize handle ──
    const handle = sidebar.querySelector("#zyrox-resize-handle");
    let resizing = false, resizeStartX = 0, resizeStartW = 0;

    handle.addEventListener("mousedown", (e) => {
      resizing = true;
      resizeStartX = e.clientX;
      resizeStartW = sidebar.offsetWidth;
      handle.classList.add("dragging");
      document.body.style.cursor = "ew-resize";
      // Temporarily disable the margin transition for live drag feel
      document.body.style.transition = "none";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const delta = resizeStartX - e.clientX;
      const newW = Math.min(Math.max(resizeStartW + delta, MIN_WIDTH), window.innerWidth * 0.95);
      currentWidth = newW;
      sidebar.style.width = newW + "px";
      if (sidebarOpen) document.body.style.marginRight = newW + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.body.style.transition = "margin-right 0.25s cubic-bezier(0.4,0,0.2,1)";
    });

    // Apply initial page margin
    applyPageMargin();
  }

  // ─── Sidebar toggle ───────────────────────────────────────────────────────────
  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle("hidden", !sidebarOpen);
    applyPageMargin();
  }

  // ─── Viewer open / close ──────────────────────────────────────────────────────
  function openViewer(p) {
    selectedId = p.id;
    viewerPanel.classList.add("visible");
    sidebar.querySelector("#zyrox-divider").classList.add("visible");

    const dirEl = sidebar.querySelector("#zyrox-viewer-dir");
    dirEl.textContent = p.direction;
    dirEl.className   = p.direction;
    dirEl.id          = "zyrox-viewer-dir";

    sidebar.querySelector("#zyrox-viewer-type").textContent = getTypeTag(p.parsed);
    sidebar.querySelector("#zyrox-viewer-time").textContent = formatTime(p.timestamp);

    // ── JSON / parsed tab ──
    const tree = sidebar.querySelector("#zyrox-json-tree");
    tree.innerHTML = "";

    if (p.parsed._loading) {
      const loading = document.createElement("div");
      loading.className = "zyrox-loading";
      loading.textContent = "Decoding binary data…";
      tree.appendChild(loading);
    } else if (p.parsed.json) {
      tree.appendChild(renderJsonNode(p.parsed.json));
    } else if (p.parsed.text) {
      const pre = document.createElement("pre");
      pre.style.cssText = "font-size:14px;color:rgba(255,255,255,0.5);white-space:pre-wrap;word-break:break-all;margin:0;";
      pre.textContent = p.parsed.text;
      tree.appendChild(pre);
    } else {
      const fallback = document.createElement("pre");
      fallback.style.cssText = "font-size:14px;color:rgba(255,255,255,0.42);white-space:pre-wrap;word-break:break-all;margin:0;";
      fallback.textContent = getBodyPreview(p.parsed, 8000);
      tree.appendChild(fallback);
    }

    // ── Raw tab ──
    sidebar.querySelector("#zyrox-raw-content").textContent = getFullBody(p.parsed);

    // ── Hex tab ──
    const hexEl = sidebar.querySelector("#zyrox-hex-content");
    hexEl.innerHTML = "";
    if (p.parsed.hex) {
      const meta = document.createElement("div");
      meta.className = "zyrox-binary-meta";
      meta.innerHTML = `<span>${p.parsed.bytes}</span> bytes · ${p.parsed.kind}`;
      hexEl.appendChild(meta);
      const dump = document.createElement("div");
      dump.className = "zyrox-hex-dump";
      dump.textContent = p.parsed.hex;
      hexEl.appendChild(dump);
    } else {
      const na = document.createElement("div");
      na.style.cssText = "font-size:13px;color:rgba(255,255,255,0.25);";
      na.textContent = "No binary data";
      hexEl.appendChild(na);
    }

    // Highlight active row
    listEl.querySelectorAll(".zyrox-packet").forEach(el =>
      el.classList.toggle("active", parseInt(el.dataset.id) === p.id)
    );
  }

  function closeViewer() {
    selectedId = null;
    viewerPanel.classList.remove("visible");
    sidebar.querySelector("#zyrox-divider").classList.remove("visible");
    listEl.querySelectorAll(".zyrox-packet.active").forEach(el => el.classList.remove("active"));
  }

  // ─── JSON tree renderer ───────────────────────────────────────────────────────
  function renderJsonNode(value) {
    const frag = document.createDocumentFragment();
    if (Array.isArray(value))                              frag.appendChild(renderCollection(value, "[", "]"));
    else if (value !== null && typeof value === "object")  frag.appendChild(renderCollection(value, "{", "}"));
    else                                                   frag.appendChild(renderPrimitive(value));
    return frag;
  }

  function renderCollection(obj, open, close) {
    const isArr   = Array.isArray(obj);
    const entries = isArr ? obj.map((v, i) => [i, v]) : Object.entries(obj);
    const wrapper = document.createElement("span");

    if (entries.length === 0) {
      const empty = document.createElement("span");
      empty.className = "zyrox-json-brace";
      empty.textContent = open + close;
      wrapper.appendChild(empty);
      return wrapper;
    }

    const openB = document.createElement("span");
    openB.className = "zyrox-json-brace";
    openB.textContent = open;
    wrapper.appendChild(openB);

    const block = document.createElement("span");
    block.className = "zyrox-json-indent";

    entries.forEach(([k, v], i) => {
      const line = document.createElement("span");
      line.className = "zyrox-json-line";
      if (!isArr) {
        const keyS = document.createElement("span");
        keyS.className = "zyrox-json-key";
        keyS.textContent = `"${k}": `;
        line.appendChild(keyS);
      }
      line.appendChild(renderJsonNode(v));
      if (i < entries.length - 1) {
        const comma = document.createElement("span");
        comma.className = "zyrox-json-brace";
        comma.textContent = ",";
        line.appendChild(comma);
      }
      block.appendChild(line);
    });

    wrapper.appendChild(block);
    const closeB = document.createElement("span");
    closeB.className = "zyrox-json-brace";
    closeB.textContent = close;
    wrapper.appendChild(closeB);
    return wrapper;
  }

  function renderPrimitive(v) {
    const span = document.createElement("span");
    if (v === null)              span.className = "zyrox-json-null";
    else if (typeof v === "string")  span.className = "zyrox-json-str";
    else if (typeof v === "number")  span.className = "zyrox-json-num";
    else if (typeof v === "boolean") span.className = "zyrox-json-bool";
    else                             span.className = "zyrox-json-brace";
    span.textContent = JSON.stringify(v);
    return span;
  }

  // ─── Render helpers ───────────────────────────────────────────────────────────
  function pad(n, len = 2) { return String(n).padStart(len, "0"); }
  function formatTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }
  function getTypeTag(parsed) {
    if (parsed.protocol === "colyseus") return "COLYSEUS";
    if (parsed.protocol === "blueboat-binary") return "BLUEBOAT_BINARY";
    if (parsed.transport === "colyseus") return `COLYSEUS/${String(parsed.channel)}`;
    if (parsed.transport === "blueboat-binary") return parsed.eventName ? `BLUEBOAT_BINARY/${parsed.eventName}` : "BLUEBOAT_BINARY";
    if (parsed.socketName) return parsed.socketName;
    if (parsed.engineName) return parsed.engineName;
    if (parsed.kind)       return `${parsed.kind} (${parsed.bytes ?? "?"} B)`;
    return "RAW";
  }
  function getBodyPreview(parsed, limit = 100) {
    // For binary packets, prefer decoded text over metadata
    if (parsed.json)  { try { return JSON.stringify(parsed.json).slice(0, limit); } catch { /**/ } }
    if (parsed.text)  { return parsed.text.slice(0, limit); }
    if (parsed.body != null)  { return typeof parsed.body === "string" ? parsed.body.slice(0, limit) : JSON.stringify(parsed.body).slice(0, limit); }
    if (parsed.payload != null) { return typeof parsed.payload === "string" ? parsed.payload.slice(0, limit) : JSON.stringify(parsed.payload).slice(0, limit); }
    if (parsed.raw != null) { return String(parsed.raw).slice(0, limit); }
    if (parsed.hex)   { return parsed.hex.slice(0, limit); }
    if (parsed.kind)  { return `[${parsed.kind} · ${parsed.bytes ?? parsed.size ?? "?"} bytes]`; }
    return "";
  }
  function getFullBody(parsed) {
    if (parsed.json)  { try { return JSON.stringify(parsed.json, null, 2); } catch { /**/ } }
    if (parsed.text)  { return parsed.text; }
    if (parsed.raw != null) { return String(parsed.raw); }
    if (parsed.hex)   { return parsed.hex; }
    return JSON.stringify(parsed);
  }
  function escapeHtml(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }
  function packetMatchesFilter(p) {
    if (filterDir !== "ALL" && p.direction !== filterDir) return false;
    if (!filterText) return true;
    return (getFullBody(p.parsed) + getTypeTag(p.parsed)).toLowerCase().includes(filterText);
  }

  // ─── List rendering ───────────────────────────────────────────────────────────
  function createPacketEl(p) {
    const el = document.createElement("div");
    el.className = "zyrox-packet";
    el.dataset.id = p.id;
    if (p.id === selectedId) el.classList.add("active");

    el.innerHTML = `
      <span class="zyrox-dir-badge ${p.direction}">${p.direction}</span>
      <span class="zyrox-type-tag">${escapeHtml(getTypeTag(p.parsed))}</span>
      <span class="zyrox-body-preview">${escapeHtml(getBodyPreview(p.parsed))}</span>
      <span class="zyrox-time">${formatTime(p.timestamp)}</span>
    `;

    el.addEventListener("click", () => {
      if (selectedId === p.id) { closeViewer(); return; }
      openViewer(p);
    });
    return el;
  }

  function rerenderList() {
    listEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    packets.filter(packetMatchesFilter).forEach(p => frag.appendChild(createPacketEl(p)));
    listEl.appendChild(frag);
    if (autoScroll) listEl.scrollTop = listEl.scrollHeight;
  }

  function appendPacketEl(p) {
    if (!packetMatchesFilter(p)) return;
    listEl.appendChild(createPacketEl(p));
    while (listEl.children.length > MAX_PACKETS) listEl.removeChild(listEl.firstChild);
    if (autoScroll) listEl.scrollTop = listEl.scrollHeight;
  }

  function updateCount() { countEl.textContent = `${packets.length} pkts`; }

  // ─── Packet logging ───────────────────────────────────────────────────────────
  function logPacket(direction, socket, payload) {
    const parsed = typeof payload === "string" ? parseTextPacket(payload) : parseBinaryPacket(payload);

    console.log(PREFIX, direction, {
      url: socket.url, readyState: socket.readyState,
      parsed, raw: payload, timestamp: new Date().toISOString(),
    });

    if (!listEl) return;

    const p = { id: packetId++, direction, parsed, timestamp: Date.now() };
    packets.push(p);
    if (packets.length > MAX_PACKETS * 2) packets = packets.slice(-MAX_PACKETS);
    updateCount();
    appendPacketEl(p);
  }

  // ─── WebSocket hooks ──────────────────────────────────────────────────────────
  const originalSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function patchedSend(data) {
    try { logPacket("OUT", this, data); } catch (e) { console.warn(PREFIX, "OUT log fail", e); }
    return originalSend.call(this, data);
  };

  const originalAEL = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function patchedAEL(type, listener, options) {
    if (type !== "message" || typeof listener !== "function")
      return originalAEL.call(this, type, listener, options);
    const self = this;
    const wrapped = function(event) {
      try { logPacket("IN", self, event.data); } catch (e) { console.warn(PREFIX, "IN log fail", e); }
      return listener.call(this, event);
    };
    return originalAEL.call(this, type, wrapped, options);
  };

  const omDesc = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
  if (omDesc?.set && omDesc?.get) {
    Object.defineProperty(WebSocket.prototype, "onmessage", {
      configurable: true, enumerable: omDesc.enumerable,
      get: omDesc.get,
      set(handler) {
        if (typeof handler !== "function") return omDesc.set.call(this, handler);
        const self = this;
        const wrapped = (event) => {
          try { logPacket("IN", self, event.data); } catch (e) { console.warn(PREFIX, "IN log fail", e); }
          return handler.call(this, event);
        };
        return omDesc.set.call(this, wrapped);
      },
    });
  }

  // ─── Keyboard shortcut ────────────────────────────────────────────────────────
  window.addEventListener("keydown", (e) => {
    if ((e.key === "k" || e.key === "K") &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA") {
      toggleSidebar();
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    buildSidebar();
    console.log(PREFIX, "v0.4.0 installed — press [K] to toggle");
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
    const obs = new MutationObserver(() => {
      if (document.body) { obs.disconnect(); init(); }
    });
    obs.observe(document.documentElement, { childList: true });
  }
})();
