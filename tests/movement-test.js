// ==UserScript==
// @name         Zyrox movement packet editor
// @namespace    https://github.com/zyrox
// @version      0.2.0
// @description  Shows and edits outgoing Colyseus INPUT movement packet values before they reach the server.
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
    modifiedPacketCount: 0,
    decodeErrors: 0,
    lastPacketAt: 0,
    lastPacket: null,
    lastOriginalBody: [],
    lastSentBody: [],
    lastChangedIndexes: [],
    lastError: "",
    overrides: {},
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
    rows: [],
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

  function utf8Bytes(value) {
    return Array.from(new TextEncoder().encode(value));
  }

  function pushUint16(bytes, value) {
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  function pushUint32(bytes, value) {
    bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  function msgpackEncode(value) {
    const bytes = [];

    const write = (item) => {
      if (item === null || item === undefined) {
        bytes.push(0xc0);
        return;
      }

      if (typeof item === "boolean") {
        bytes.push(item ? 0xc3 : 0xc2);
        return;
      }

      if (typeof item === "number") {
        if (Number.isInteger(item) && Number.isFinite(item)) {
          if (item >= 0 && item < 0x80) bytes.push(item);
          else if (item >= 0 && item <= 0xff) bytes.push(0xcc, item);
          else if (item >= 0 && item <= 0xffff) { bytes.push(0xcd); pushUint16(bytes, item); }
          else if (item >= 0 && item <= 0xffffffff) { bytes.push(0xce); pushUint32(bytes, item); }
          else if (item >= -32 && item < 0) bytes.push(0x100 + item);
          else if (item >= -128 && item < 0) bytes.push(0xd0, item & 0xff);
          else if (item >= -32768 && item < 0) { bytes.push(0xd1); pushUint16(bytes, item & 0xffff); }
          else if (item >= -2147483648 && item < 0) { bytes.push(0xd2); pushUint32(bytes, item >>> 0); }
          else writeFloat64(item);
          return;
        }

        writeFloat64(item);
        return;
      }

      if (typeof item === "string") {
        const encoded = utf8Bytes(item);
        if (encoded.length < 32) bytes.push(0xa0 | encoded.length);
        else if (encoded.length <= 0xff) bytes.push(0xd9, encoded.length);
        else if (encoded.length <= 0xffff) { bytes.push(0xda); pushUint16(bytes, encoded.length); }
        else { bytes.push(0xdb); pushUint32(bytes, encoded.length); }
        bytes.push(...encoded);
        return;
      }

      if (Array.isArray(item)) {
        if (item.length < 16) bytes.push(0x90 | item.length);
        else if (item.length <= 0xffff) { bytes.push(0xdc); pushUint16(bytes, item.length); }
        else { bytes.push(0xdd); pushUint32(bytes, item.length); }
        item.forEach(write);
        return;
      }

      if (typeof item === "object") {
        const keys = Object.keys(item);
        if (keys.length < 16) bytes.push(0x80 | keys.length);
        else if (keys.length <= 0xffff) { bytes.push(0xde); pushUint16(bytes, keys.length); }
        else { bytes.push(0xdf); pushUint32(bytes, keys.length); }
        keys.forEach((key) => {
          write(key);
          write(item[key]);
        });
        return;
      }

      bytes.push(0xc0);
    };

    const writeFloat64 = (number) => {
      const buffer = new ArrayBuffer(8);
      new DataView(buffer).setFloat64(0, number);
      bytes.push(0xcb, ...new Uint8Array(buffer));
    };

    write(value);
    return Uint8Array.from(bytes);
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

  function encodeColyseusInputPacket(body) {
    const channelBytes = msgpackEncode(INPUT_CHANNEL);
    const bodyBytes = msgpackEncode(body);
    const packet = new Uint8Array(1 + channelBytes.length + bodyBytes.length);
    packet[0] = ROOM_DATA;
    packet.set(channelBytes, 1);
    packet.set(bodyBytes, 1 + channelBytes.length);
    return packet.buffer;
  }

  function parseOverride(rawValue, currentValue) {
    const trimmed = rawValue.trim();
    if (!trimmed) return { active: false };

    if (typeof currentValue === "number") {
      const value = Number(trimmed);
      if (!Number.isFinite(value)) return { active: false, error: "Number overrides must be finite." };
      return { active: true, value };
    }

    if (typeof currentValue === "boolean") {
      if (/^(true|1)$/i.test(trimmed)) return { active: true, value: true };
      if (/^(false|0)$/i.test(trimmed)) return { active: true, value: false };
      return { active: false, error: "Boolean overrides must be true/false." };
    }

    try {
      return { active: true, value: JSON.parse(trimmed) };
    } catch (_) {
      return { active: true, value: trimmed };
    }
  }

  function applyOverrides(body) {
    const nextBody = body.slice();
    const changedIndexes = [];
    const errors = [];

    nextBody.forEach((currentValue, index) => {
      const parsed = parseOverride(state.overrides[index] || "", currentValue);
      if (parsed.error) errors.push(`${FIELD_LABELS[index] || `body[${index}]`}: ${parsed.error}`);
      if (!parsed.active) return;
      nextBody[index] = parsed.value;
      if (!Object.is(currentValue, parsed.value)) changedIndexes.push(index);
    });

    return { body: nextBody, changedIndexes, errors };
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
          width: 355px;
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
        #zyrox-movement-test .zmt-value {
          color: #ffffff;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          text-align: right;
        }
        #zyrox-movement-test .zmt-changed .zmt-value {
          color: #7dffbf;
        }
        #zyrox-movement-test .zmt-override {
          width: 86px;
          box-sizing: border-box;
          padding: 4px 6px;
          color: #ffffff;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-radius: 6px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11px;
          outline: none;
        }
        #zyrox-movement-test .zmt-override:focus {
          border-color: rgba(125, 255, 191, 0.72);
          box-shadow: 0 0 0 2px rgba(125, 255, 191, 0.12);
        }
        #zyrox-movement-test .zmt-override.zmt-invalid {
          border-color: rgba(255, 91, 123, 0.8);
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
      <div class="zmt-title"><span>Movement INPUT editor</span><span class="zmt-pill">LIVE</span></div>
      <div class="zmt-status">Waiting for Colyseus INPUT packets...</div>
      <table>
        <thead><tr><th>Item</th><th>Value sent</th><th>Set to</th></tr></thead>
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

  function ensureRows(length) {
    if (!state.uiReady) return;

    while (dom.rows.length < length) {
      const index = dom.rows.length;
      const row = document.createElement("tr");
      const labelCell = document.createElement("td");
      const valueCell = document.createElement("td");
      const inputCell = document.createElement("td");
      const input = document.createElement("input");

      labelCell.textContent = FIELD_LABELS[index] || `body[${index}]`;
      valueCell.className = "zmt-value";
      input.className = "zmt-override";
      input.placeholder = "blank = off";
      input.spellcheck = false;
      input.value = state.overrides[index] || "";
      input.addEventListener("input", () => {
        state.overrides[index] = input.value;
        queueRender();
      });

      inputCell.appendChild(input);
      row.append(labelCell, valueCell, inputCell);
      dom.tableBody.appendChild(row);
      dom.rows.push({ row, valueCell, input });
    }

    while (dom.rows.length > length) {
      dom.rows.pop().row.remove();
    }
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

    const body = state.lastSentBody;
    const changed = new Set(state.lastChangedIndexes);
    const overrideErrors = [];
    ensureRows(Math.max(body.length, FIELD_LABELS.length));

    dom.rows.forEach(({ row, valueCell, input }, index) => {
      const value = body[index];
      const parsed = parseOverride(input.value, state.lastOriginalBody[index]);
      if (parsed.error) overrideErrors.push(`${FIELD_LABELS[index] || `body[${index}]`}: ${parsed.error}`);
      valueCell.textContent = value === undefined ? "—" : formatValue(value);
      row.classList.toggle("zmt-changed", changed.has(index));
      input.classList.toggle("zmt-invalid", Boolean(parsed.error));
    });

    dom.status.textContent = state.lastPacket
      ? `${state.packetCount} packets • ${state.modifiedPacketCount} modified • ${formatAge(state.lastPacketAt)} • ${state.lastPacket.transport}/${state.lastPacket.channel}`
      : "Waiting for Colyseus INPUT packets... Fill a Set to box to override that body item.";

    dom.raw.textContent = JSON.stringify(state.lastPacket || { transport: "colyseus", channel: INPUT_CHANNEL, body: [] }, null, 2);
    dom.error.style.display = state.lastError || overrideErrors.length ? "block" : "none";
    dom.error.textContent = [state.lastError, ...overrideErrors].filter(Boolean).join("\n");
  }

  function inspectAndMaybeModify(data) {
    const packet = decodeColyseusInputPacket(data);
    if (!packet) return data;

    const originalBody = packet.body.slice();
    const overrideResult = applyOverrides(originalBody);
    const shouldModify = overrideResult.changedIndexes.length > 0;
    const sentBody = overrideResult.body;

    state.packetCount += 1;
    if (shouldModify) state.modifiedPacketCount += 1;
    state.lastPacketAt = Date.now();
    state.lastOriginalBody = originalBody;
    state.lastSentBody = sentBody.slice();
    state.lastChangedIndexes = overrideResult.changedIndexes;
    state.lastPacket = {
      transport: packet.transport,
      channel: packet.channel,
      body: sentBody,
      originalBody: shouldModify ? originalBody : undefined,
    };
    state.lastError = overrideResult.errors.join("\n");
    queueRender();

    return shouldModify ? encodeColyseusInputPacket(sentBody) : data;
  }

  WebSocket.prototype.send = function sendPatched(data) {
    let dataToSend = data;
    try {
      dataToSend = inspectAndMaybeModify(data);
    } catch (error) {
      state.decodeErrors += 1;
      state.lastError = `Decode/edit error #${state.decodeErrors}: ${error?.message || error}`;
      queueRender();
      console.warn(`${LOG_PREFIX} failed to decode or edit outgoing packet`, error);
    }

    return state.originalSend.call(this, dataToSend);
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

  console.log(`${LOG_PREFIX} ready - watching and editing outgoing Colyseus INPUT packets.`);
})();
