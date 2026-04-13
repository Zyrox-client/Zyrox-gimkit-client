// ==UserScript==
// @name         Zyrox packet sniffer
// @namespace    https://github.com/zyrox
// @version      1.1.0
// @description  Logs websocket packets with a split-pane inspector UI.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const PREFIX = "[PacketSniffer]";
  const MAX_PACKETS = 500;
  const DEFAULT_WIDTH = 880;
  const MIN_WIDTH = 320;
  const COLYSEUS_ROOM_DATA = 13;
  const STATS_WINDOW_MS = 5000;

  const ENGINE_PACKET_TYPES = {
    "0": "OPEN", "1": "CLOSE", "2": "PING", "3": "PONG",
    "4": "MESSAGE", "5": "UPGRADE", "6": "NOOP",
  };
  const SOCKET_PACKET_TYPES = {
    "0": "CONNECT", "1": "DISCONNECT", "2": "EVENT",
    "3": "ACK", "4": "ERROR", "5": "BINARY_EVENT", "6": "BINARY_ACK",
  };

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

  function decodeStructuredBinary(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === COLYSEUS_ROOM_DATA) {
      const first = msgpackDecode(buffer, 1);
      if (!first) return null;
      let message = null;
      if (bytes.byteLength > first.offset) message = msgpackDecode(buffer, first.offset)?.value;
      return { transport: "colyseus", channel: first.value, body: message };
    }
    if (bytes.byteLength && bytes[0] === 4) {
      const decoded = msgpackDecode(buffer.slice(1), 0)?.value;
      if (!decoded || typeof decoded !== "object") return null;
      const data = decoded.data;
      const eventName = Array.isArray(data) ? data[0] : null;
      const eventPayload = Array.isArray(data) ? data[1] : data;
      return { transport: "blueboat-binary", eventName, payload: eventPayload, raw: decoded };
    }
    return null;
  }

  function parseBinaryPacket(value) {
    let bytes = null;
    if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else if (value instanceof Blob) {
      const meta = { kind: "Blob", bytes: value.size, text: null, json: null, hex: null, _loading: true };
      value.arrayBuffer().then((buf) => {
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
        const p = packets.find((x) => x.parsed === meta);
        if (p && p.id === selectedId) openViewer(p);
        rerenderList();
      }).catch(() => { meta._loading = false; });
      return meta;
    }

    if (!bytes) return { kind: typeof value, bytes: 0, hex: null, text: null, json: null };

    const hex = toHex(bytes);
    let text = null;
    let json = null;
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

  let packets = [];
  let packetId = 0;
  let sidebarOpen = true;
  let decodeStructuredBinaryEnabled = true;
  let selectedId = null;
  let currentWidth = DEFAULT_WIDTH;
  let viewerWidthPercent = 68.75;
  let initialized = false;
  let isPaused = false;
  let autoScroll = true;
  let pendingPackets = [];
  let statsCollapsed = false;
  let pinnedIds = new Set();
  let flaggedIds = new Set();
  let selectedForDiffId = null;
  let hooksGeneration = 0;

  const filterState = { query: "", direction: "ALL", type: "", flaggedOnly: false };

  let sidebar, listEl, countEl, filterInput, viewerPanel, bodyEl, dividerEl;
  let statsLineEl, statusEl, pauseBtnEl, autoscrollBtnEl, clearConfirmEl, resetConfirmEl, legendEl, contextMenuEl;
  let wsHooksInstalled = false;

  const statsTimestamps = [];
  const websocketRegistry = new Set();

  function applyPageMargin() {
    document.body.style.marginRight = sidebarOpen ? `${currentWidth}px` : "0";
    document.body.style.transition = "margin-right 0.25s cubic-bezier(0.4,0,0.2,1)";
    document.body.style.boxSizing = "border-box";
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
      #zyrox-sidebar { position: fixed; top: 0; right: 0; width: ${DEFAULT_WIDTH}px; height: 100vh; z-index: 999999; display: flex; flex-direction: column; font-family: 'JetBrains Mono', monospace; font-size: 15px; background: rgba(8,10,18,0.98); border-left: 1px solid rgba(0,255,136,0.15); box-shadow: -12px 0 50px rgba(0,0,0,0.7), inset 1px 0 0 rgba(0,255,136,0.05); transform: translateX(0); transition: transform 0.25s cubic-bezier(0.4,0,0.2,1); backdrop-filter: blur(12px); user-select: none; }
      #zyrox-sidebar.hidden { transform: translateX(100%); }
      #zyrox-resize-handle { position: absolute; left: 0; top: 0; width: 5px; height: 100%; cursor: ew-resize; z-index: 10; }
      #zyrox-resize-handle:hover, #zyrox-resize-handle.dragging { background: rgba(0,255,136,0.18); }
      #zyrox-header { position: relative; display:flex; align-items:center; gap:8px; padding: 12px 16px 12px 20px; background: rgba(0,255,136,0.04); border-bottom: 1px solid rgba(0,255,136,0.12); flex-shrink:0; }
      #zyrox-title { color:#00ff88; font-weight:700; font-size:18px; letter-spacing:0.1em; text-transform:uppercase; flex:1; }
      #zyrox-count { color: rgba(0,255,136,0.5); font-size: 12px; }
      .zyrox-toolbar-btn { background: rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.12); color:rgba(255,255,255,0.45); border-radius:4px; cursor:pointer; font-family:inherit; font-size:13px; padding: 4px 8px; }
      .zyrox-toolbar-btn:hover { color:#fff; border-color: rgba(255,255,255,0.3); }
      .zyrox-toolbar-btn.active { border-color: rgba(0,255,136,0.5); color:#00ff88; background: rgba(0,255,136,0.1); }
      #zyrox-controls { display:flex; gap:6px; padding:8px 14px; border-bottom:1px solid rgba(255,255,255,0.06); align-items:center; flex-shrink:0; }
      #zyrox-filter-input { flex:1; min-width: 0; background: rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:#ddd; font-family:inherit; font-size:13px; padding: 6px 8px; }
      #zyrox-stats { border-bottom:1px solid rgba(255,255,255,0.06); padding: 4px 14px; font-size:12px; color:rgba(255,255,255,0.5); }
      #zyrox-stats-line { display:flex; gap:16px; white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
      #zyrox-stats.expanded #zyrox-stats-line { white-space: normal; }
      #zyrox-inline-confirm { display:none; padding: 4px 14px; font-size:12px; color: rgba(255,160,160,0.85); border-bottom:1px solid rgba(255,100,100,0.18); }
      #zyrox-reset-confirm { display:none; padding: 4px 14px; font-size:12px; color: rgba(255,210,130,0.85); border-bottom:1px solid rgba(255,180,0,0.2); }
      .zyrox-confirm-action { color:#fff; cursor:pointer; margin-left:8px; }
      #zyrox-body { flex:1; display:flex; min-height:0; overflow:hidden; }
      #zyrox-list-panel { flex:1; display:flex; flex-direction:column; min-width:180px; overflow:hidden; }
      #zyrox-list-meta { display:flex; justify-content: space-between; align-items:center; padding: 6px 12px; font-size:12px; color: rgba(255,255,255,0.35); border-bottom:1px solid rgba(255,255,255,0.05); }
      #zyrox-list { flex:1; overflow-y:auto; }
      .zyrox-section-title { padding: 5px 10px; font-size:11px; letter-spacing:0.1em; color: rgba(255,255,255,0.35); border-top:1px solid rgba(255,255,255,0.1); border-bottom:1px solid rgba(255,255,255,0.05); background: rgba(255,255,255,0.02); }
      .zyrox-packet { display:grid; grid-template-columns: 26px 42px minmax(110px,1fr) auto auto auto; gap:0 8px; align-items:center; padding: 6px 10px; border-bottom:1px solid rgba(255,255,255,0.03); cursor:pointer; min-width:0; }
      .zyrox-packet:hover { background: rgba(255,255,255,0.04); }
      .zyrox-packet.active { border-left:2px solid rgba(0,255,136,0.6); padding-left:8px; }
      .zyrox-pin-btn,.zyrox-flag-btn { opacity:0; background:none; border:none; cursor:pointer; color: rgba(255,255,255,0.4); }
      .zyrox-packet:hover .zyrox-pin-btn,.zyrox-packet:hover .zyrox-flag-btn,.zyrox-pin-btn.active,.zyrox-flag-btn.active { opacity:1; }
      .zyrox-dir-badge.IN { color:#00c8ff; font-weight:700; }
      .zyrox-dir-badge.OUT { color:#ffb400; font-weight:700; }
      .zyrox-type-tag { color: rgba(255,255,255,0.75); white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
      .zyrox-len-tag, .zyrox-time, .zyrox-badge { font-size:11px; color: rgba(255,255,255,0.45); }
      .zyrox-badge { color:#ffcf75; border:1px solid rgba(255,207,117,0.3); border-radius:3px; padding:1px 3px; }
      #zyrox-divider { width:6px; display:none; cursor: col-resize; background: rgba(255,255,255,0.07); }
      #zyrox-divider.visible { display:block; }
      #zyrox-viewer { width:${viewerWidthPercent}%; display:none; flex-direction:column; min-width:220px; overflow:hidden; background: rgba(4,6,14,0.65); }
      #zyrox-viewer.visible { display:flex; }
      #zyrox-viewer-header { display:flex; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.08); }
      #zyrox-viewer-meta { flex:1; min-width:0; }
      #zyrox-viewer-type { color: rgba(255,255,255,0.8); font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #zyrox-viewer-time { color: rgba(255,255,255,0.35); font-size:11px; }
      .zyrox-viewer-action { background: rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.45); border-radius:3px; cursor:pointer; font-family:inherit; font-size:12px; padding:3px 8px; }
      .zyrox-viewer-action:hover { color:#fff; }
      #zyrox-viewer-tabs { display:flex; border-bottom:1px solid rgba(255,255,255,0.06); }
      .zyrox-tab { background:none; border:none; color: rgba(255,255,255,0.45); font-family:inherit; padding: 6px 10px; cursor:pointer; border-bottom:2px solid transparent; }
      .zyrox-tab.active { color:#00ff88; border-bottom-color:#00ff88; }
      #zyrox-viewer-body { flex:1; position:relative; min-height:0; }
      .zyrox-view-pane { position:absolute; inset:0; overflow:auto; display:none; padding:10px; user-select:text; }
      .zyrox-view-pane.active { display:block; }
      .zyrox-json-node { font-size:13px; line-height:1.5; color:rgba(255,255,255,0.85); }
      .zyrox-json-row { white-space:pre; }
      .zyrox-json-toggle { display:inline-block; width:14px; cursor:pointer; color: rgba(255,255,255,0.5); }
      .zyrox-json-key { color:#7ec8e3; }
      .zyrox-json-str { color:#a8e6a3; cursor:text; }
      .zyrox-json-num { color:#f0c080; }
      .zyrox-json-bool { color:#e07070; }
      .zyrox-json-null { color:rgba(255,255,255,0.35); }
      .zyrox-json-children { margin-left: 18px; }
      .zyrox-hidden { display:none; }
      #zyrox-resend-editor { width:100%; min-height:180px; background: rgba(0,0,0,0.35); color:#e4e4e4; border:1px solid rgba(255,255,255,0.15); border-radius:4px; font-family:inherit; font-size:12px; padding:8px; }
      #zyrox-resend-error { color:#ff8888; font-size:12px; margin-top:6px; }
      #zyrox-context-menu { position:fixed; display:none; background:rgba(8,10,18,0.98); border:1px solid rgba(255,255,255,0.14); z-index:1000001; padding:4px; border-radius:4px; }
      .zyrox-context-item { padding: 4px 8px; color: rgba(255,255,255,0.75); cursor:pointer; font-size:12px; }
      .zyrox-context-item:hover { background: rgba(255,255,255,0.08); }
      #zyrox-diff-pane pre { margin:0; font-size:12px; white-space:pre-wrap; color: rgba(255,255,255,0.86); }
      #zyrox-legend { display:none; padding: 4px 12px; font-size:11px; color: rgba(255,255,255,0.45); border-bottom:1px solid rgba(255,255,255,0.05); }
      #zyrox-footer { padding: 6px 12px; font-size:11px; color: rgba(255,255,255,0.35); border-top:1px solid rgba(255,255,255,0.06); }
    `;
    document.head.appendChild(style);
  }

  function buildSidebar() {
    sidebar = document.createElement("div");
    sidebar.id = "zyrox-sidebar";
    sidebar.innerHTML = `
      <div id="zyrox-resize-handle"></div>
      <div id="zyrox-header">
        <span id="zyrox-title">PacketSniffer</span>
        <span id="zyrox-count">Showing 0 / 0</span>
        <button id="zyrox-pause-btn" class="zyrox-toolbar-btn">⏸</button>
        <button id="zyrox-autoscroll-btn" class="zyrox-toolbar-btn active">🔓</button>
        <button id="zyrox-export-btn" class="zyrox-toolbar-btn">⬇</button>
        <button id="zyrox-legend-btn" class="zyrox-toolbar-btn">Legend</button>
        <button id="zyrox-stats-toggle" class="zyrox-toolbar-btn">Stats</button>
        <button id="zyrox-reset-btn" class="zyrox-toolbar-btn">Reset</button>
        <button id="zyrox-toggle-btn" class="zyrox-toolbar-btn">HIDE</button>
      </div>
      <div id="zyrox-controls">
        <input id="zyrox-filter-input" type="text" placeholder="filter… dir:in type:xyz flagged:true" />
        <button class="zyrox-toolbar-btn active" data-dir="ALL">ALL</button>
        <button class="zyrox-toolbar-btn" data-dir="IN">IN</button>
        <button class="zyrox-toolbar-btn" data-dir="OUT">OUT</button>
        <button id="zyrox-decode-btn" class="zyrox-toolbar-btn active">DEC</button>
        <button id="zyrox-flag-filter-btn" class="zyrox-toolbar-btn">⭐</button>
        <button id="zyrox-clear-btn" class="zyrox-toolbar-btn">🗑</button>
      </div>
      <div id="zyrox-stats"><div id="zyrox-stats-line"></div></div>
      <div id="zyrox-inline-confirm">Clear? <span class="zyrox-confirm-action" data-clear="yes">Yes</span> / <span class="zyrox-confirm-action" data-clear="no">No</span></div>
      <div id="zyrox-reset-confirm">Reset session? <span class="zyrox-confirm-action" data-reset="yes">Yes</span> / <span class="zyrox-confirm-action" data-reset="no">No</span></div>
      <div id="zyrox-legend">IN = blue tint, OUT = amber tint, unique type hue stripe on each row.</div>
      <div id="zyrox-body">
        <div id="zyrox-list-panel">
          <div id="zyrox-list-meta"><span id="zyrox-filter-summary">Showing 0 / 0 packets</span><span id="zyrox-pause-note"></span></div>
          <div id="zyrox-list"></div>
        </div>
        <div id="zyrox-divider"></div>
        <div id="zyrox-viewer">
          <div id="zyrox-viewer-header">
            <span id="zyrox-viewer-dir">IN</span>
            <div id="zyrox-viewer-meta"><div id="zyrox-viewer-type">—</div><div id="zyrox-viewer-time">—</div></div>
            <button id="zyrox-copy-btn" class="zyrox-viewer-action">Copy JSON</button>
            <button id="zyrox-edit-btn" class="zyrox-viewer-action">Edit & Resend</button>
            <button id="zyrox-viewer-close" class="zyrox-viewer-action">✕</button>
          </div>
          <div id="zyrox-viewer-tabs">
            <button class="zyrox-tab active" data-tab="json">JSON</button>
            <button class="zyrox-tab" data-tab="raw">RAW</button>
            <button class="zyrox-tab" data-tab="hex">HEX</button>
            <button class="zyrox-tab" data-tab="diff">DIFF</button>
            <button class="zyrox-tab" data-tab="resend">RESEND</button>
          </div>
          <div id="zyrox-viewer-body">
            <div class="zyrox-view-pane active" id="zyrox-json-pane"><div id="zyrox-json-tree"></div></div>
            <div class="zyrox-view-pane" id="zyrox-raw-pane"><pre id="zyrox-raw-content"></pre></div>
            <div class="zyrox-view-pane" id="zyrox-hex-pane"><div id="zyrox-hex-content"></div></div>
            <div class="zyrox-view-pane" id="zyrox-diff-pane"><pre id="zyrox-diff-content">Pin first packet, then right-click another packet and choose "Diff with selected".</pre></div>
            <div class="zyrox-view-pane" id="zyrox-resend-pane">
              <textarea id="zyrox-resend-editor" spellcheck="false"></textarea>
              <div><button id="zyrox-send-btn" class="zyrox-viewer-action">Send</button></div>
              <div id="zyrox-resend-error"></div>
            </div>
          </div>
        </div>
      </div>
      <div id="zyrox-footer"><span id="zyrox-status">CONNECTED</span></div>
    `;
    document.body.appendChild(sidebar);

    listEl = sidebar.querySelector("#zyrox-list");
    countEl = sidebar.querySelector("#zyrox-count");
    filterInput = sidebar.querySelector("#zyrox-filter-input");
    viewerPanel = sidebar.querySelector("#zyrox-viewer");
    bodyEl = sidebar.querySelector("#zyrox-body");
    dividerEl = sidebar.querySelector("#zyrox-divider");
    statsLineEl = sidebar.querySelector("#zyrox-stats-line");
    statusEl = sidebar.querySelector("#zyrox-status");
    pauseBtnEl = sidebar.querySelector("#zyrox-pause-btn");
    autoscrollBtnEl = sidebar.querySelector("#zyrox-autoscroll-btn");
    clearConfirmEl = sidebar.querySelector("#zyrox-inline-confirm");
    resetConfirmEl = sidebar.querySelector("#zyrox-reset-confirm");
    legendEl = sidebar.querySelector("#zyrox-legend");

    contextMenuEl = document.createElement("div");
    contextMenuEl.id = "zyrox-context-menu";
    contextMenuEl.innerHTML = `<div class="zyrox-context-item" data-action="pin">Pin for diff</div><div class="zyrox-context-item" data-action="diff">Diff with selected</div>`;
    document.body.appendChild(contextMenuEl);

    wireEvents();
    applyPageMargin();
    setInterval(updateStats, 1000);
  }

  function wireEvents() {
    sidebar.querySelector("#zyrox-toggle-btn").addEventListener("click", toggleSidebar);
    pauseBtnEl.addEventListener("click", togglePause);
    autoscrollBtnEl.addEventListener("click", () => setAutoScroll(!autoScroll, true));

    listEl.addEventListener("scroll", () => {
      if (!autoScroll) return;
      const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 12;
      if (!nearBottom) setAutoScroll(false, false);
    });

    filterInput.addEventListener("input", () => {
      parseFilter(filterInput.value);
      rerenderList();
    });

    sidebar.querySelectorAll("[data-dir]").forEach((btn) => {
      btn.addEventListener("click", () => {
        filterState.direction = btn.dataset.dir;
        sidebar.querySelectorAll("[data-dir]").forEach((b) => b.classList.toggle("active", b.dataset.dir === filterState.direction));
        rerenderList();
      });
    });

    sidebar.querySelector("#zyrox-decode-btn").addEventListener("click", (e) => {
      decodeStructuredBinaryEnabled = !decodeStructuredBinaryEnabled;
      e.currentTarget.classList.toggle("active", decodeStructuredBinaryEnabled);
    });

    sidebar.querySelector("#zyrox-flag-filter-btn").addEventListener("click", (e) => {
      filterState.flaggedOnly = !filterState.flaggedOnly;
      e.currentTarget.classList.toggle("active", filterState.flaggedOnly);
      rerenderList();
    });

    sidebar.querySelector("#zyrox-clear-btn").addEventListener("click", () => {
      resetConfirmEl.style.display = "none";
      clearConfirmEl.style.display = "block";
      clearConfirmEl.firstChild.textContent = `Clear ${packets.length} packets? `;
    });

    clearConfirmEl.addEventListener("click", (e) => {
      const choice = e.target.dataset.clear;
      if (!choice) return;
      clearConfirmEl.style.display = "none";
      if (choice === "yes") clearPackets();
    });

    sidebar.querySelector("#zyrox-reset-btn").addEventListener("click", () => {
      clearConfirmEl.style.display = "none";
      resetConfirmEl.style.display = "block";
    });

    resetConfirmEl.addEventListener("click", (e) => {
      const choice = e.target.dataset.reset;
      if (!choice) return;
      resetConfirmEl.style.display = "none";
      if (choice === "yes") resetSession();
    });

    sidebar.querySelector("#zyrox-export-btn").addEventListener("click", exportPackets);

    sidebar.querySelector("#zyrox-legend-btn").addEventListener("click", () => {
      legendEl.style.display = legendEl.style.display === "block" ? "none" : "block";
    });

    sidebar.querySelector("#zyrox-stats-toggle").addEventListener("click", () => {
      statsCollapsed = !statsCollapsed;
      sidebar.querySelector("#zyrox-stats").classList.toggle("expanded", !statsCollapsed);
      updateStats();
    });

    sidebar.querySelector("#zyrox-viewer-close").addEventListener("click", closeViewer);

    sidebar.querySelectorAll(".zyrox-tab").forEach((tab) => tab.addEventListener("click", () => setActiveTab(tab.dataset.tab)));

    sidebar.querySelector("#zyrox-copy-btn").addEventListener("click", async () => {
      const p = packets.find((x) => x.id === selectedId);
      if (!p) return;
      await navigator.clipboard.writeText(JSON.stringify(p.parsed.json ?? p.parsed, null, 2));
    });

    sidebar.querySelector("#zyrox-edit-btn").addEventListener("click", () => {
      setActiveTab("resend");
      const p = packets.find((x) => x.id === selectedId);
      if (!p) return;
      sidebar.querySelector("#zyrox-resend-editor").value = JSON.stringify(p.parsed.json ?? p.parsed, null, 2);
      sidebar.querySelector("#zyrox-resend-error").textContent = "";
    });

    sidebar.querySelector("#zyrox-send-btn").addEventListener("click", resendEdited);

    contextMenuEl.addEventListener("click", (e) => {
      const action = e.target.dataset.action;
      const rowId = Number(contextMenuEl.dataset.rowId);
      const p = packets.find((x) => x.id === rowId);
      if (!p) return;
      if (action === "pin") {
        selectedForDiffId = p.id;
        statusEl.textContent = `Pinned packet #${p.id} for diff`;
      } else if (action === "diff") {
        showDiff(selectedForDiffId, p.id);
      }
      contextMenuEl.style.display = "none";
    });

    document.addEventListener("click", () => { contextMenuEl.style.display = "none"; });

    const handle = sidebar.querySelector("#zyrox-resize-handle");
    let resizing = false; let resizeStartX = 0; let resizeStartW = 0;
    handle.addEventListener("mousedown", (e) => {
      resizing = true;
      resizeStartX = e.clientX;
      resizeStartW = sidebar.offsetWidth;
      handle.classList.add("dragging");
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const delta = resizeStartX - e.clientX;
      const newW = Math.min(Math.max(resizeStartW + delta, MIN_WIDTH), window.innerWidth * 0.95);
      currentWidth = newW;
      sidebar.style.width = `${newW}px`;
      if (sidebarOpen) document.body.style.marginRight = `${newW}px`;
    });
    document.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });

    let splitDragging = false;
    dividerEl.addEventListener("mousedown", (e) => {
      splitDragging = viewerPanel.classList.contains("visible");
      if (!splitDragging) return;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!splitDragging) return;
      const rect = bodyEl.getBoundingClientRect();
      const viewerPx = rect.right - e.clientX;
      const clampedPx = Math.max(220, Math.min(rect.width - 180, viewerPx));
      viewerWidthPercent = (clampedPx / rect.width) * 100;
      viewerPanel.style.width = `${viewerWidthPercent}%`;
    });
    document.addEventListener("mouseup", () => {
      if (!splitDragging) return;
      splitDragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });

    window.addEventListener("keydown", (e) => {
      if ((e.key === "k" || e.key === "K") && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) toggleSidebar();
    });
  }

  function setActiveTab(name) {
    sidebar.querySelectorAll(".zyrox-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    sidebar.querySelectorAll(".zyrox-view-pane").forEach((p) => p.classList.toggle("active", p.id === `zyrox-${name}-pane`));
  }

  function pad(n, len = 2) { return String(n).padStart(len, "0"); }
  function formatTime(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; }
  function getTypeTag(parsed) {
    if (parsed.protocol === "colyseus") return "COLYSEUS";
    if (parsed.protocol === "blueboat-binary") return "BLUEBOAT_BINARY";
    if (parsed.transport === "colyseus") return `COLYSEUS/${String(parsed.channel)}`;
    if (parsed.transport === "blueboat-binary") return parsed.eventName ? `BLUEBOAT_BINARY/${parsed.eventName}` : "BLUEBOAT_BINARY";
    if (parsed.socketName) return parsed.socketName;
    if (parsed.engineName) return parsed.engineName;
    if (parsed.kind) return `${parsed.kind} (${parsed.bytes ?? "?"} B)`;
    return "RAW";
  }
  function getFullBody(parsed) {
    if (parsed.json) { try { return JSON.stringify(parsed.json, null, 2); } catch { /**/ } }
    if (parsed.text) return parsed.text;
    if (parsed.raw != null) return String(parsed.raw);
    if (parsed.hex) return parsed.hex;
    return JSON.stringify(parsed, null, 2);
  }
  function getPacketLength(parsed) { return getFullBody(parsed).length; }
  function escapeHtml(str) { return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function parseFilter(raw) {
    filterState.query = "";
    filterState.type = "";
    filterState.flaggedOnly = false;
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    const free = [];
    for (const t of tokens) {
      if (t.startsWith("dir:")) {
        const v = t.slice(4).toUpperCase();
        if (v === "IN" || v === "OUT") filterState.direction = v;
      } else if (t.startsWith("type:")) filterState.type = t.slice(5).toLowerCase();
      else if (t === "flagged:true" || t === "flagged") filterState.flaggedOnly = true;
      else free.push(t);
    }
    filterState.query = free.join(" ").toLowerCase();
    const flagBtn = sidebar?.querySelector("#zyrox-flag-filter-btn");
    if (flagBtn) flagBtn.classList.toggle("active", filterState.flaggedOnly);
  }

  function packetMatchesFilter(p) {
    if (filterState.direction !== "ALL" && p.direction !== filterState.direction) return false;
    if (filterState.flaggedOnly && !flaggedIds.has(p.id)) return false;
    const type = getTypeTag(p.parsed).toLowerCase();
    if (filterState.type && !type.includes(filterState.type)) return false;
    if (filterState.query) {
      const hay = `${type} ${getFullBody(p.parsed).toLowerCase()}`;
      if (!hay.includes(filterState.query)) return false;
    }
    return true;
  }

  function colorForType(type) {
    let h = 0;
    for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) % 360;
    return `hsl(${h} 70% 55%)`;
  }

  function createPacketEl(p) {
    const el = document.createElement("div");
    const type = getTypeTag(p.parsed);
    const tint = p.direction === "IN" ? "rgba(0,200,255,0.07)" : "rgba(255,180,0,0.07)";
    el.className = "zyrox-packet";
    el.dataset.id = p.id;
    el.style.backgroundImage = `linear-gradient(90deg, ${colorForType(type)}33 0 3px, transparent 3px), linear-gradient(90deg, ${tint}, ${tint})`;
    if (p.id === selectedId) el.classList.add("active");
    el.innerHTML = `
      <button class="zyrox-pin-btn ${p.pinned ? "active" : ""}" title="Pin">📌</button>
      <span class="zyrox-dir-badge ${p.direction}">${p.direction}</span>
      <span class="zyrox-type-tag">${escapeHtml(type)}</span>
      ${p.resent ? '<span class="zyrox-badge">resent</span>' : '<span></span>'}
      <span class="zyrox-len-tag">${getPacketLength(p.parsed)}</span>
      <button class="zyrox-flag-btn ${p.flagged ? "active" : ""}" title="Flag">⭐</button>
    `;

    el.querySelector(".zyrox-pin-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      p.pinned = !p.pinned;
      if (p.pinned) pinnedIds.add(p.id); else pinnedIds.delete(p.id);
      rerenderList();
    });

    el.querySelector(".zyrox-flag-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      p.flagged = !p.flagged;
      if (p.flagged) flaggedIds.add(p.id); else flaggedIds.delete(p.id);
      rerenderList();
    });

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      contextMenuEl.dataset.rowId = String(p.id);
      contextMenuEl.style.left = `${e.clientX}px`;
      contextMenuEl.style.top = `${e.clientY}px`;
      contextMenuEl.style.display = "block";
    });

    el.addEventListener("click", () => {
      if (selectedId === p.id) return closeViewer();
      openViewer(p);
    });
    return el;
  }

  function renderListSection(rows, title) {
    const frag = document.createDocumentFragment();
    if (!rows.length) return frag;
    if (title) {
      const section = document.createElement("div");
      section.className = "zyrox-section-title";
      section.textContent = title;
      frag.appendChild(section);
    }
    rows.forEach((p) => frag.appendChild(createPacketEl(p)));
    return frag;
  }

  function rerenderList() {
    listEl.innerHTML = "";
    const filtered = packets.filter(packetMatchesFilter);
    const pinned = filtered.filter((p) => p.pinned);
    const regular = filtered.filter((p) => !p.pinned);
    listEl.appendChild(renderListSection(pinned, pinned.length ? "Pinned" : ""));
    listEl.appendChild(renderListSection(regular, pinned.length ? "Packets" : ""));
    sidebar.querySelector("#zyrox-filter-summary").textContent = `Showing ${filtered.length} / ${packets.length} packets`;
    countEl.textContent = `Showing ${filtered.length} / ${packets.length}`;
    if (autoScroll) listEl.scrollTop = listEl.scrollHeight;
  }

  function updateStats() {
    const now = Date.now();
    while (statsTimestamps.length && now - statsTimestamps[0] > STATS_WINDOW_MS) statsTimestamps.shift();
    const inCount = packets.filter((p) => p.direction === "IN").length;
    const outCount = packets.filter((p) => p.direction === "OUT").length;
    const pps = (statsTimestamps.length / (STATS_WINDOW_MS / 1000)).toFixed(2);
    statsLineEl.textContent = `Total ${packets.length} | ${pps} pkt/s (5s) | In: ${inCount} / Out: ${outCount}`;
    if (statsCollapsed) statsLineEl.textContent = `Total ${packets.length} | ${pps} pkt/s`;
  }

  function togglePause() {
    isPaused = !isPaused;
    pauseBtnEl.textContent = isPaused ? "▶" : "⏸";
    pauseBtnEl.classList.toggle("active", isPaused);
    sidebar.querySelector("#zyrox-pause-note").textContent = isPaused ? `Paused (${pendingPackets.length} buffered)` : "";
    if (!isPaused) flushPausedPackets();
  }

  function flushPausedPackets() {
    if (!pendingPackets.length) return;
    pendingPackets.forEach((p) => packets.push(p));
    pendingPackets = [];
    trimPackets();
    rerenderList();
    updateStats();
    if (autoScroll) listEl.scrollTop = listEl.scrollHeight;
    sidebar.querySelector("#zyrox-pause-note").textContent = "";
  }

  function setAutoScroll(enabled, snap) {
    autoScroll = enabled;
    autoscrollBtnEl.textContent = autoScroll ? "🔓" : "🔒";
    autoscrollBtnEl.classList.toggle("active", autoScroll);
    if (enabled && snap) listEl.scrollTop = listEl.scrollHeight;
  }

  function trimPackets() {
    if (packets.length > MAX_PACKETS * 2) packets = packets.slice(-MAX_PACKETS);
  }

  function clearPackets() {
    packets = packets.filter((p) => p.pinned);
    flaggedIds.clear();
    packets.forEach((p) => { p.flagged = false; });
    pendingPackets = [];
    selectedId = null;
    closeViewer();
    rerenderList();
    updateStats();
  }

  function resetSession() {
    packets = packets.filter((p) => p.pinned).map((p) => ({ ...p, flagged: false }));
    pendingPackets = [];
    flaggedIds.clear();
    statsTimestamps.length = 0;
    selectedForDiffId = null;
    filterState.query = "";
    filterState.type = "";
    filterState.direction = "ALL";
    filterState.flaggedOnly = false;
    filterInput.value = "";
    sidebar.querySelectorAll("[data-dir]").forEach((b) => b.classList.toggle("active", b.dataset.dir === "ALL"));
    hooksGeneration += 1;
    statusEl.textContent = `SESSION RESET @ ${formatTime(Date.now())}`;
    closeViewer();
    rerenderList();
    updateStats();
  }

  function exportPackets() {
    const filtered = packets.filter(packetMatchesFilter).map((p, index) => ({
      index,
      id: p.id,
      direction: p.direction,
      timestamp: new Date(p.timestamp).toISOString(),
      type: getTypeTag(p.parsed),
      payload: p.parsed.json ?? p.parsed,
      flagged: Boolean(p.flagged),
      pinned: Boolean(p.pinned),
      resent: Boolean(p.resent),
    }));
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `packets-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function renderJsonTree(value, depth = 0, key = null, isRootArray = false) {
    const node = document.createElement("div");
    node.className = "zyrox-json-node";

    const row = document.createElement("div");
    row.className = "zyrox-json-row";
    node.appendChild(row);

    const keyPrefix = key !== null ? `"${key}": ` : "";

    if (value === null || typeof value !== "object") {
      let cls = "zyrox-json-null";
      if (typeof value === "string") cls = "zyrox-json-str";
      if (typeof value === "number") cls = "zyrox-json-num";
      if (typeof value === "boolean") cls = "zyrox-json-bool";
      row.innerHTML = `${" ".repeat(depth * 2)}${keyPrefix}<span class="${cls}">${escapeHtml(JSON.stringify(value))}</span>`;
      return node;
    }

    const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    const open = Array.isArray(value) ? "[" : "{";
    const close = Array.isArray(value) ? "]" : "}";
    const collapseDefault = Array.isArray(value) && value.length > 20 && !isRootArray;

    const toggle = document.createElement("span");
    toggle.className = "zyrox-json-toggle";
    toggle.textContent = collapseDefault ? "▶" : "▼";
    row.appendChild(document.createTextNode(" ".repeat(depth * 2)));
    row.appendChild(toggle);
    row.appendChild(document.createTextNode(`${keyPrefix}${open} ${entries.length}`));

    const children = document.createElement("div");
    children.className = "zyrox-json-children";
    if (collapseDefault) children.classList.add("zyrox-hidden");

    const visibleEntries = collapseDefault ? entries.slice(0, 20) : entries;
    visibleEntries.forEach(([k, v]) => children.appendChild(renderJsonTree(v, depth + 1, k)));
    if (collapseDefault && entries.length > 20) {
      const showAll = document.createElement("div");
      showAll.className = "zyrox-json-row";
      showAll.innerHTML = `${" ".repeat((depth + 1) * 2)}<span class="zyrox-json-str" style="cursor:pointer">show all (${entries.length})</span>`;
      showAll.addEventListener("click", () => {
        children.innerHTML = "";
        entries.forEach(([k, v]) => children.appendChild(renderJsonTree(v, depth + 1, k)));
      });
      children.appendChild(showAll);
    }

    const end = document.createElement("div");
    end.className = "zyrox-json-row";
    end.textContent = `${" ".repeat(depth * 2)}${close}`;
    children.appendChild(end);

    toggle.addEventListener("click", () => {
      children.classList.toggle("zyrox-hidden");
      toggle.textContent = children.classList.contains("zyrox-hidden") ? "▶" : "▼";
    });

    node.appendChild(children);
    return node;
  }

  function openViewer(p) {
    selectedId = p.id;
    viewerPanel.classList.add("visible");
    dividerEl.classList.add("visible");
    viewerPanel.style.width = `${viewerWidthPercent}%`;

    const dirEl = sidebar.querySelector("#zyrox-viewer-dir");
    dirEl.textContent = p.direction;
    dirEl.className = p.direction;
    dirEl.id = "zyrox-viewer-dir";
    sidebar.querySelector("#zyrox-viewer-type").textContent = getTypeTag(p.parsed);
    sidebar.querySelector("#zyrox-viewer-time").textContent = formatTime(p.timestamp);

    const tree = sidebar.querySelector("#zyrox-json-tree");
    tree.innerHTML = "";
    if (p.parsed._loading) tree.textContent = "Decoding...";
    else tree.appendChild(renderJsonTree(p.parsed.json ?? p.parsed, 0, null, true));

    sidebar.querySelector("#zyrox-raw-content").textContent = getFullBody(p.parsed);
    sidebar.querySelector("#zyrox-resend-editor").value = JSON.stringify(p.parsed.json ?? p.parsed, null, 2);

    const hexEl = sidebar.querySelector("#zyrox-hex-content");
    hexEl.textContent = p.parsed.hex || "No binary data";

    listEl.querySelectorAll(".zyrox-packet").forEach((el) => el.classList.toggle("active", Number(el.dataset.id) === p.id));
  }

  function closeViewer() {
    selectedId = null;
    viewerPanel.classList.remove("visible");
    dividerEl.classList.remove("visible");
    listEl.querySelectorAll(".zyrox-packet.active").forEach((el) => el.classList.remove("active"));
  }

  function simpleLineDiff(a, b) {
    const aa = a.split("\n");
    const bb = b.split("\n");
    const max = Math.max(aa.length, bb.length);
    const out = [];
    for (let i = 0; i < max; i++) {
      const left = aa[i] ?? "";
      const right = bb[i] ?? "";
      if (left === right) out.push(`  ${left}`);
      else {
        if (left) out.push(`- ${left}`);
        if (right) out.push(`+ ${right}`);
      }
    }
    return out.join("\n");
  }

  function showDiff(leftId, rightId) {
    const a = packets.find((p) => p.id === leftId);
    const b = packets.find((p) => p.id === rightId);
    if (!a || !b) return;
    setActiveTab("diff");
    const diff = simpleLineDiff(getFullBody(a.parsed), getFullBody(b.parsed));
    sidebar.querySelector("#zyrox-diff-content").textContent = `#${a.id} vs #${b.id}\n\n${diff}`;
  }

  function resendEdited() {
    const p = packets.find((x) => x.id === selectedId);
    if (!p) return;
    const text = sidebar.querySelector("#zyrox-resend-editor").value;
    const err = sidebar.querySelector("#zyrox-resend-error");
    let parsed;
    try {
      parsed = JSON.parse(text);
      err.textContent = "";
    } catch (e) {
      err.textContent = `Invalid JSON: ${e.message}`;
      return;
    }

    const ws = getActiveSocket();
    if (!ws) {
      err.textContent = "No active WebSocket connection.";
      return;
    }
    ws.send(JSON.stringify(parsed));
    logPacket("OUT", ws, JSON.stringify(parsed), { resent: true });
  }

  function getActiveSocket() {
    return [...websocketRegistry].find((x) => x.readyState === WebSocket.OPEN) || null;
  }

  function logPacket(direction, socket, payload, opts = {}) {
    const parsed = typeof payload === "string" ? parseTextPacket(payload) : parseBinaryPacket(payload);
    const p = {
      id: packetId++,
      direction,
      parsed,
      timestamp: Date.now(),
      flagged: false,
      pinned: false,
      resent: Boolean(opts.resent),
      generation: hooksGeneration,
    };

    statsTimestamps.push(Date.now());
    if (isPaused) {
      pendingPackets.push(p);
      sidebar.querySelector("#zyrox-pause-note").textContent = `Paused (${pendingPackets.length} buffered)`;
      return;
    }

    packets.push(p);
    trimPackets();
    rerenderList();
    updateStats();

    if (selectedId === p.id) openViewer(p);

    console.log(PREFIX, direction, { parsed, timestamp: new Date().toISOString() });
  }

  function installHooks() {
    if (wsHooksInstalled) return;
    wsHooksInstalled = true;

    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function PatchedWebSocket(...args) {
      const ws = new OriginalWebSocket(...args);
      websocketRegistry.add(ws);
      ws.addEventListener("close", () => websocketRegistry.delete(ws));

      const origSend = ws.send;
      ws.send = function patchedSend(data) {
        try { logPacket("OUT", ws, data); } catch (e) { console.warn(PREFIX, "OUT fail", e); }
        return origSend.call(this, data);
      };

      ws.addEventListener("message", (event) => {
        try { logPacket("IN", ws, event.data); } catch (e) { console.warn(PREFIX, "IN fail", e); }
      });

      return ws;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(window.WebSocket, OriginalWebSocket);
  }

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle("hidden", !sidebarOpen);
    applyPageMargin();
  }

  function init() {
    if (initialized) return;
    if (!document.body) return;
    initialized = true;
    injectStyles();
    buildSidebar();
    installHooks();
    updateStats();
    console.log(PREFIX, "v1.1.0 installed — press [K] to toggle");
  }

  if (document.body) init();
  else {
    document.addEventListener("DOMContentLoaded", init);
    const obs = new MutationObserver(() => {
      if (document.body) { obs.disconnect(); init(); }
    });
    obs.observe(document.documentElement, { childList: true });
  }
})();
