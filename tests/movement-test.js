// ==UserScript==
// @name         Zyrox movement packet monitor
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Shows a live floating window with the latest Colyseus INPUT movement packet values.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxMovementTest]";
  const ROOM_DATA = 13;
  const INPUT_CHANNEL = "INPUT";
  const FIELD_LABELS = [
    "body[0]",
    "body[1]",
    "body[2]",
    "body[3]",
    "body[4]",
    "body[5]",
    "body[6]",
  ];

  const unsafe = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const previous = unsafe.__zyroxMovementTest;
  if (previous?.destroy) previous.destroy();

  const state = {
    packetCount: 0,
    decodeErrors: 0,
    lastPacketAt: 0,
    lastPacket: null,
    lastBody: [],
    lastError: "",
    renderQueued: false,
    uiReady: false,
    dragging: null,
    originalSend: WebSocket.prototype.send,
  };

  const dom = {
    root: null,
    title: null,
    status: null,
    tableBody: null,
    raw: null,
    error: null,
  };

  function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    return null;
  }

  function formatValue(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return String(value);
      return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    }
    if (typeof value === "string") return JSON.stringify(value);
    if (value === undefined) return "undefined";
    return JSON.stringify(value);
  }

  function formatAge(timestamp) {
    if (!timestamp) return "waiting";
    const age = Date.now() - timestamp;
    if (age < 1000) return `${age}ms ago`;
    return `${(age / 1000).toFixed(1)}s ago`;
  }

  function readUtf8(view, offset, length) {
    let out = "";
    const end = offset + length;
    while (offset < end) {
      const byte = view.getUint8(offset++);
      if ((byte & 0x80) === 0) {
        out += String.fromCharCode(byte);
      } else if ((byte & 0xe0) === 0xc0) {
        out += String.fromCharCode(((byte & 0x1f) << 6) | (view.getUint8(offset++) & 0x3f));
      } else if ((byte & 0xf0) === 0xe0) {
        out += String.fromCharCode(((byte & 0x0f) << 12) | ((view.getUint8(offset++) & 0x3f) << 6) | (view.getUint8(offset++) & 0x3f));
      } else {
        const codePoint = ((byte & 0x07) << 18) | ((view.getUint8(offset++) & 0x3f) << 12) | ((view.getUint8(offset++) & 0x3f) << 6) | (view.getUint8(offset++) & 0x3f);
        const shifted = codePoint - 0x10000;
        out += String.fromCharCode((shifted >> 10) + 0xd800, (shifted & 1023) + 0xdc00);
      }
    }
    return { value: out, offset };
  }

  function msgpackDecode(buffer, startOffset = 0) {
    const view = new DataView(buffer);
    let offset = startOffset;

    const read = () => {
      const token = view.getUint8(offset++);

      if (token < 0x80) return token;
      if (token < 0x90) {
        const size = token & 0x0f;
        const map = {};
        for (let i = 0; i < size; i += 1) map[read()] = read();
        return map;
      }
      if (token < 0xa0) {
        const size = token & 0x0f;
        const arr = [];
        for (let i = 0; i < size; i += 1) arr.push(read());
        return arr;
      }
      if (token < 0xc0) {
        const str = readUtf8(view, offset, token & 0x1f);
        offset = str.offset;
        return str.value;
      }
      if (token > 0xdf) return token - 256;

      switch (token) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xca: { const value = view.getFloat32(offset); offset += 4; return value; }
        case 0xcb: { const value = view.getFloat64(offset); offset += 8; return value; }
        case 0xcc: { const value = view.getUint8(offset); offset += 1; return value; }
        case 0xcd: { const value = view.getUint16(offset); offset += 2; return value; }
        case 0xce: { const value = view.getUint32(offset); offset += 4; return value; }
        case 0xcf: {
          const high = view.getUint32(offset);
          const low = view.getUint32(offset + 4);
          offset += 8;
          return high * 4294967296 + low;
        }
        case 0xd0: { const value = view.getInt8(offset); offset += 1; return value; }
        case 0xd1: { const value = view.getInt16(offset); offset += 2; return value; }
        case 0xd2: { const value = view.getInt32(offset); offset += 4; return value; }
        case 0xd3: {
          const high = view.getInt32(offset);
          const low = view.getUint32(offset + 4);
          offset += 8;
          return high * 4294967296 + low;
        }
        case 0xd9: { const length = view.getUint8(offset); offset += 1; const str = readUtf8(view, offset, length); offset = str.offset; return str.value; }
        case 0xda: { const length = view.getUint16(offset); offset += 2; const str = readUtf8(view, offset, length); offset = str.offset; return str.value; }
        case 0xdb: { const length = view.getUint32(offset); offset += 4; const str = readUtf8(view, offset, length); offset = str.offset; return str.value; }
        case 0xdc: { const size = view.getUint16(offset); offset += 2; const arr = []; for (let i = 0; i < size; i += 1) arr.push(read()); return arr; }
        case 0xdd: { const size = view.getUint32(offset); offset += 4; const arr = []; for (let i = 0; i < size; i += 1) arr.push(read()); return arr; }
        case 0xde: { const size = view.getUint16(offset); offset += 2; const map = {}; for (let i = 0; i < size; i += 1) map[read()] = read(); return map; }
        case 0xdf: { const size = view.getUint32(offset); offset += 4; const map = {}; for (let i = 0; i < size; i += 1) map[read()] = read(); return map; }
        default: return undefined;
      }
    };

    return { value: read(), offset };
  }

  function decodeColyseusInputPacket(data) {
    const buffer = toArrayBuffer(data);
    if (!buffer) return null;

    const bytes = new Uint8Array(buffer);
    if (!bytes.length || bytes[0] !== ROOM_DATA) return null;

    const channel = msgpackDecode(buffer, 1);
    if (channel?.value !== INPUT_CHANNEL || channel.offset >= bytes.byteLength) return null;

    const body = msgpackDecode(buffer, channel.offset);
    if (!Array.isArray(body?.value)) return null;

    return {
      transport: "colyseus",
      channel: channel.value,
      body: body.value,
    };
  }

  function ensureUi() {
    if (state.uiReady) return;
    if (!document.documentElement) return;

    const root = document.createElement("div");
    root.id = "zyrox-movement-test";
    root.innerHTML = `
      <style>
        #zyrox-movement-test {
          position: fixed;
          top: 72px;
          right: 18px;
          z-index: 2147483647;
          width: 275px;
          color: #eaf2ff;
          background: rgba(10, 15, 28, 0.94);
          border: 1px solid rgba(90, 173, 255, 0.55);
          border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38);
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 12px;
          overflow: hidden;
          backdrop-filter: blur(8px);
        }
        #zyrox-movement-test .zmt-title {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 9px 10px;
          cursor: move;
          user-select: none;
          background: linear-gradient(135deg, rgba(32, 122, 255, 0.36), rgba(100, 65, 255, 0.22));
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          font-weight: 800;
          letter-spacing: 0.02em;
        }
        #zyrox-movement-test .zmt-pill {
          padding: 2px 7px;
          border-radius: 999px;
          background: rgba(59, 255, 163, 0.13);
          border: 1px solid rgba(59, 255, 163, 0.32);
          color: #7dffbf;
          font-size: 10px;
          font-weight: 800;
        }
        #zyrox-movement-test .zmt-status {
          padding: 8px 10px 6px;
          color: #a9b7d0;
          line-height: 1.45;
        }
        #zyrox-movement-test table {
          width: calc(100% - 16px);
          margin: 0 8px 8px;
          border-collapse: collapse;
          overflow: hidden;
          border-radius: 8px;
        }
        #zyrox-movement-test th,
        #zyrox-movement-test td {
          padding: 5px 7px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.07);
          text-align: left;
        }
        #zyrox-movement-test th {
          color: #89a4d9;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          background: rgba(255, 255, 255, 0.04);
        }
        #zyrox-movement-test td:last-child {
          color: #ffffff;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          text-align: right;
        }
        #zyrox-movement-test .zmt-raw {
          margin: 0 8px 8px;
          max-height: 84px;
          overflow: auto;
          padding: 7px;
          border-radius: 8px;
          color: #c6d5ed;
          background: rgba(0, 0, 0, 0.24);
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 10px;
          white-space: pre-wrap;
          word-break: break-word;
        }
        #zyrox-movement-test .zmt-error {
          display: none;
          margin: 0 8px 8px;
          color: #ffb4c2;
          font-size: 11px;
        }
      </style>
      <div class="zmt-title"><span>Movement INPUT</span><span class="zmt-pill">LIVE</span></div>
      <div class="zmt-status">Waiting for Colyseus INPUT packets...</div>
      <table>
        <thead><tr><th>Item</th><th>Value</th></tr></thead>
        <tbody></tbody>
      </table>
      <pre class="zmt-raw">[]</pre>
      <div class="zmt-error"></div>
    `;

    document.documentElement.appendChild(root);
    dom.root = root;
    dom.title = root.querySelector(".zmt-title");
    dom.status = root.querySelector(".zmt-status");
    dom.tableBody = root.querySelector("tbody");
    dom.raw = root.querySelector(".zmt-raw");
    dom.error = root.querySelector(".zmt-error");

    dom.title.addEventListener("pointerdown", startDrag);
    document.addEventListener("pointermove", onDrag);
    document.addEventListener("pointerup", stopDrag);
    state.uiReady = true;
    renderNow();
  }

  function startDrag(event) {
    const rect = dom.root.getBoundingClientRect();
    state.dragging = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    dom.root.style.right = "auto";
    dom.root.setPointerCapture?.(event.pointerId);
  }

  function onDrag(event) {
    if (!state.dragging || !dom.root) return;
    const maxLeft = Math.max(0, window.innerWidth - dom.root.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - dom.root.offsetHeight);
    const left = Math.min(maxLeft, Math.max(0, event.clientX - state.dragging.offsetX));
    const top = Math.min(maxTop, Math.max(0, event.clientY - state.dragging.offsetY));
    dom.root.style.left = `${left}px`;
    dom.root.style.top = `${top}px`;
  }

  function stopDrag() {
    state.dragging = null;
  }

  function queueRender() {
    ensureUi();
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(renderNow);
  }

  function renderNow() {
    state.renderQueued = false;
    if (!state.uiReady) return;

    const body = state.lastBody;
    dom.status.textContent = state.lastPacket
      ? `${state.packetCount} packets • ${formatAge(state.lastPacketAt)} • ${state.lastPacket.transport}/${state.lastPacket.channel}`
      : "Waiting for Colyseus INPUT packets...";

    dom.tableBody.innerHTML = body.map((value, index) => {
      const label = FIELD_LABELS[index] || `body[${index}]`;
      return `<tr><td>${label}</td><td>${formatValue(value)}</td></tr>`;
    }).join("") || `<tr><td colspan="2">No packet captured yet</td></tr>`;

    dom.raw.textContent = JSON.stringify(state.lastPacket || { transport: "colyseus", channel: INPUT_CHANNEL, body: [] }, null, 2);
    dom.error.style.display = state.lastError ? "block" : "none";
    dom.error.textContent = state.lastError;
  }

  function handleSend(data) {
    const packet = decodeColyseusInputPacket(data);
    if (!packet) return;

    state.packetCount += 1;
    state.lastPacketAt = Date.now();
    state.lastPacket = packet;
    state.lastBody = packet.body.slice();
    state.lastError = "";
    queueRender();
  }

  WebSocket.prototype.send = function sendPatched(data) {
    try {
      handleSend(data);
    } catch (error) {
      state.decodeErrors += 1;
      state.lastError = `Decode error #${state.decodeErrors}: ${error?.message || error}`;
      queueRender();
      console.warn(`${LOG_PREFIX} failed to decode outgoing packet`, error);
    }

    return state.originalSend.apply(this, arguments);
  };

  unsafe.__zyroxMovementTest = {
    state,
    destroy() {
      WebSocket.prototype.send = state.originalSend;
      document.removeEventListener("pointermove", onDrag);
      document.removeEventListener("pointerup", stopDrag);
      dom.root?.remove();
      state.uiReady = false;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureUi, { once: true });
  } else {
    ensureUi();
  }

  console.log(`${LOG_PREFIX} ready - watching outgoing Colyseus INPUT packets.`);
})();
