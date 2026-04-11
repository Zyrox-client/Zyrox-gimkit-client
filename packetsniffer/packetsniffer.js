// ==UserScript==
// @name         Zyrox packet sniffer
// @namespace    https://github.com/zyrox
// @version      0.2.0
// @description  Logs every websocket packet (incoming + outgoing) with a slick sidebar UI.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  // ─── Constants ───────────────────────────────────────────────────────────────
  const PREFIX = "[PacketSniffer]";
  const MAX_PACKETS = 500;

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

  function parseBinaryPacket(value) {
    if (value instanceof Blob) return { kind: "Blob", size: value.size, type: value.type || "(none)" };
    if (value instanceof ArrayBuffer) return { kind: "ArrayBuffer", bytes: value.byteLength };
    if (ArrayBuffer.isView(value)) return { kind: value.constructor?.name || "TypedArray", bytes: value.byteLength };
    return { kind: typeof value };
  }

  // ─── Sidebar state ────────────────────────────────────────────────────────────
  let packets = [];
  let sidebarOpen = true;
  let filterText = "";
  let filterDir = "ALL"; // ALL | IN | OUT
  let autoScroll = true;
  let sidebar, listEl, countEl, filterInput;

  // ─── Inject styles ────────────────────────────────────────────────────────────
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');

      #zyrox-sidebar {
        position: fixed;
        top: 0; right: 0;
        width: 400px;
        height: 100vh;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        background: rgba(8, 10, 18, 0.97);
        border-left: 1px solid rgba(0, 255, 136, 0.15);
        box-shadow: -8px 0 40px rgba(0,0,0,0.6), inset 1px 0 0 rgba(0,255,136,0.05);
        transform: translateX(0);
        transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        backdrop-filter: blur(12px);
      }

      #zyrox-sidebar.hidden {
        transform: translateX(100%);
      }

      #zyrox-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        background: rgba(0,255,136,0.04);
        border-bottom: 1px solid rgba(0,255,136,0.12);
        flex-shrink: 0;
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
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        flex: 1;
      }

      #zyrox-count {
        color: rgba(0,255,136,0.5);
        font-size: 10px;
        letter-spacing: 0.05em;
      }

      #zyrox-toggle-btn {
        background: none;
        border: 1px solid rgba(0,255,136,0.2);
        color: rgba(0,255,136,0.6);
        cursor: pointer;
        padding: 3px 7px;
        font-family: inherit;
        font-size: 10px;
        border-radius: 3px;
        transition: all 0.15s;
        letter-spacing: 0.05em;
      }
      #zyrox-toggle-btn:hover {
        background: rgba(0,255,136,0.1);
        color: #00ff88;
        border-color: rgba(0,255,136,0.5);
      }

      #zyrox-controls {
        display: flex;
        gap: 6px;
        padding: 8px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        flex-shrink: 0;
      }

      #zyrox-filter-input {
        flex: 1;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 4px;
        color: #e0e0e0;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        padding: 5px 8px;
        outline: none;
        transition: border-color 0.15s;
      }
      #zyrox-filter-input::placeholder { color: rgba(255,255,255,0.2); }
      #zyrox-filter-input:focus { border-color: rgba(0,255,136,0.4); }

      .zyrox-dir-btn {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.07);
        color: rgba(255,255,255,0.4);
        font-family: 'JetBrains Mono', monospace;
        font-size: 9px;
        padding: 4px 7px;
        border-radius: 4px;
        cursor: pointer;
        letter-spacing: 0.06em;
        transition: all 0.15s;
      }
      .zyrox-dir-btn:hover { color: rgba(255,255,255,0.7); border-color: rgba(255,255,255,0.2); }
      .zyrox-dir-btn.active-all  { background: rgba(150,150,255,0.12); border-color: rgba(150,150,255,0.4); color: #aaaaff; }
      .zyrox-dir-btn.active-in   { background: rgba(0,200,255,0.10);   border-color: rgba(0,200,255,0.4);   color: #00c8ff; }
      .zyrox-dir-btn.active-out  { background: rgba(255,180,0,0.10);   border-color: rgba(255,180,0,0.4);   color: #ffb400; }

      #zyrox-clear-btn {
        background: rgba(255,60,60,0.06);
        border: 1px solid rgba(255,60,60,0.15);
        color: rgba(255,100,100,0.6);
        font-family: 'JetBrains Mono', monospace;
        font-size: 9px;
        padding: 4px 7px;
        border-radius: 4px;
        cursor: pointer;
        letter-spacing: 0.04em;
        transition: all 0.15s;
      }
      #zyrox-clear-btn:hover { background: rgba(255,60,60,0.14); color: #ff6464; border-color: rgba(255,60,60,0.35); }

      #zyrox-list {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
        scroll-behavior: smooth;
      }

      #zyrox-list::-webkit-scrollbar { width: 4px; }
      #zyrox-list::-webkit-scrollbar-track { background: transparent; }
      #zyrox-list::-webkit-scrollbar-thumb { background: rgba(0,255,136,0.2); border-radius: 2px; }

      .zyrox-packet {
        display: grid;
        grid-template-columns: 28px 32px 1fr auto;
        gap: 0 6px;
        align-items: start;
        padding: 5px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.025);
        cursor: pointer;
        transition: background 0.1s;
        position: relative;
      }
      .zyrox-packet:hover { background: rgba(255,255,255,0.03); }
      .zyrox-packet.expanded { background: rgba(0,255,136,0.03); }

      .zyrox-dir-badge {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.08em;
        padding: 1px 0;
        text-align: center;
        border-radius: 2px;
        align-self: center;
      }
      .zyrox-dir-badge.IN  { color: #00c8ff; }
      .zyrox-dir-badge.OUT { color: #ffb400; }

      .zyrox-type-tag {
        font-size: 9px;
        letter-spacing: 0.05em;
        color: rgba(255,255,255,0.3);
        align-self: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .zyrox-body {
        font-size: 10px;
        color: rgba(255,255,255,0.65);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        align-self: center;
        min-width: 0;
      }

      .zyrox-time {
        font-size: 9px;
        color: rgba(255,255,255,0.2);
        white-space: nowrap;
        align-self: center;
      }

      .zyrox-expanded-body {
        grid-column: 1 / -1;
        margin-top: 5px;
        padding: 8px;
        background: rgba(0,0,0,0.35);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 4px;
        color: #a8e6c8;
        font-size: 10px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 220px;
        overflow-y: auto;
      }
      .zyrox-expanded-body::-webkit-scrollbar { width: 3px; }
      .zyrox-expanded-body::-webkit-scrollbar-thumb { background: rgba(0,255,136,0.2); }

      #zyrox-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 14px;
        border-top: 1px solid rgba(255,255,255,0.04);
        flex-shrink: 0;
        background: rgba(0,0,0,0.2);
      }

      #zyrox-status {
        font-size: 9px;
        color: rgba(255,255,255,0.25);
        letter-spacing: 0.05em;
      }

      #zyrox-autoscroll-toggle {
        display: flex;
        align-items: center;
        gap: 5px;
        cursor: pointer;
        font-size: 9px;
        color: rgba(255,255,255,0.3);
        letter-spacing: 0.05em;
        user-select: none;
        transition: color 0.15s;
      }
      #zyrox-autoscroll-toggle:hover { color: rgba(255,255,255,0.6); }
      #zyrox-autoscroll-toggle.on { color: rgba(0,255,136,0.7); }

      #zyrox-autoscroll-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        background: rgba(255,255,255,0.2);
        transition: background 0.15s;
      }
      #zyrox-autoscroll-toggle.on #zyrox-autoscroll-dot { background: #00ff88; }

      /* Hotkey hint pill */
      #zyrox-hint {
        position: fixed;
        top: 50%;
        right: 0;
        transform: translateY(-50%);
        z-index: 999998;
        writing-mode: vertical-rl;
        text-orientation: mixed;
        background: rgba(8,10,18,0.85);
        border: 1px solid rgba(0,255,136,0.18);
        border-right: none;
        color: rgba(0,255,136,0.5);
        font-family: 'JetBrains Mono', monospace;
        font-size: 9px;
        letter-spacing: 0.1em;
        padding: 10px 5px;
        border-radius: 4px 0 0 4px;
        cursor: pointer;
        transition: all 0.2s;
        backdrop-filter: blur(8px);
      }
      #zyrox-hint:hover { color: #00ff88; background: rgba(0,255,136,0.08); }
      #zyrox-hint.sidebar-open { opacity: 0; pointer-events: none; }

      /* Scanline effect on header */
      #zyrox-header::after {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background: repeating-linear-gradient(
          0deg,
          transparent,
          transparent 2px,
          rgba(0,255,136,0.01) 2px,
          rgba(0,255,136,0.01) 4px
        );
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Build sidebar DOM ────────────────────────────────────────────────────────
  function buildSidebar() {
    sidebar = document.createElement("div");
    sidebar.id = "zyrox-sidebar";
    if (!sidebarOpen) sidebar.classList.add("hidden");

    sidebar.innerHTML = `
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
        <button id="zyrox-clear-btn">CLR</button>
      </div>
      <div id="zyrox-list"></div>
      <div id="zyrox-footer">
        <span id="zyrox-status">CONNECTED</span>
        <div id="zyrox-autoscroll-toggle" class="on">
          <div id="zyrox-autoscroll-dot"></div>
          AUTO-SCROLL
        </div>
      </div>
    `;

    document.body.appendChild(sidebar);

    listEl   = sidebar.querySelector("#zyrox-list");
    countEl  = sidebar.querySelector("#zyrox-count");
    filterInput = sidebar.querySelector("#zyrox-filter-input");

    // Hint tab (shown when sidebar is hidden)
    const hint = document.createElement("div");
    hint.id = "zyrox-hint";
    hint.textContent = "PACKETS [K]";
    if (sidebarOpen) hint.classList.add("sidebar-open");
    hint.addEventListener("click", () => toggleSidebar());
    document.body.appendChild(hint);

    // Events
    sidebar.querySelector("#zyrox-toggle-btn").addEventListener("click", () => toggleSidebar());
    sidebar.querySelector("#zyrox-clear-btn").addEventListener("click", () => {
      packets = [];
      listEl.innerHTML = "";
      updateCount();
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
          if (b.dataset.dir === filterDir) {
            b.classList.add(`active-${filterDir.toLowerCase()}`);
          }
        });
        rerenderList();
      });
    });

    const scrollToggle = sidebar.querySelector("#zyrox-autoscroll-toggle");
    scrollToggle.addEventListener("click", () => {
      autoScroll = !autoScroll;
      scrollToggle.classList.toggle("on", autoScroll);
    });
  }

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle("hidden", !sidebarOpen);
    const hint = document.getElementById("zyrox-hint");
    if (hint) hint.classList.toggle("sidebar-open", sidebarOpen);
  }

  // ─── Render helpers ───────────────────────────────────────────────────────────
  function formatTime(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}.${String(d.getMilliseconds()).padStart(3,"0")}`;
  }

  function getTypeTag(parsed) {
    if (parsed.socketName) return parsed.socketName;
    if (parsed.engineName) return parsed.engineName;
    if (parsed.kind) return parsed.kind;
    return "RAW";
  }

  function getBodyPreview(parsed) {
    if (parsed.json) {
      try { return JSON.stringify(parsed.json).slice(0, 120); } catch { /**/ }
    }
    if (parsed.body) return parsed.body.slice(0, 120);
    if (parsed.payload) return parsed.payload.slice(0, 120);
    if (parsed.raw) return String(parsed.raw).slice(0, 120);
    if (parsed.kind) return `[${parsed.kind} ${parsed.bytes ?? parsed.size ?? "?"} bytes]`;
    return "";
  }

  function getFullBody(parsed) {
    if (parsed.json) {
      try { return JSON.stringify(parsed.json, null, 2); } catch { /**/ }
    }
    return parsed.raw ?? JSON.stringify(parsed);
  }

  function packetMatchesFilter(p) {
    if (filterDir !== "ALL" && p.direction !== filterDir) return false;
    if (!filterText) return true;
    const haystack = getFullBody(p.parsed).toLowerCase() + getTypeTag(p.parsed).toLowerCase();
    return haystack.includes(filterText);
  }

  function createPacketEl(p) {
    const el = document.createElement("div");
    el.className = "zyrox-packet";
    el.dataset.id = p.id;

    const typeTag = getTypeTag(p.parsed);
    const preview = getBodyPreview(p.parsed);

    el.innerHTML = `
      <span class="zyrox-dir-badge ${p.direction}">${p.direction}</span>
      <span class="zyrox-type-tag">${typeTag}</span>
      <span class="zyrox-body">${escapeHtml(preview)}</span>
      <span class="zyrox-time">${formatTime(p.timestamp)}</span>
    `;

    el.addEventListener("click", () => {
      const existing = el.querySelector(".zyrox-expanded-body");
      if (existing) { existing.remove(); el.classList.remove("expanded"); return; }
      el.classList.add("expanded");
      const exp = document.createElement("pre");
      exp.className = "zyrox-expanded-body";
      exp.textContent = getFullBody(p.parsed);
      el.appendChild(exp);
    });

    return el;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function rerenderList() {
    listEl.innerHTML = "";
    const fragment = document.createDocumentFragment();
    packets.filter(packetMatchesFilter).forEach(p => fragment.appendChild(createPacketEl(p)));
    listEl.appendChild(fragment);
    if (autoScroll) listEl.scrollTop = listEl.scrollHeight;
  }

  function appendPacketEl(p) {
    if (!packetMatchesFilter(p)) return;
    const el = createPacketEl(p);
    listEl.appendChild(el);
    // Trim DOM nodes if too many
    while (listEl.children.length > MAX_PACKETS) listEl.removeChild(listEl.firstChild);
    if (autoScroll) listEl.scrollTop = listEl.scrollHeight;
  }

  function updateCount() {
    countEl.textContent = `${packets.length} pkts`;
  }

  // ─── Log packet (called by WS hooks) ─────────────────────────────────────────
  let packetId = 0;

  function logPacket(direction, socket, payload) {
    const parsed = typeof payload === "string" ? parseTextPacket(payload) : parseBinaryPacket(payload);

    // Always log to console too
    console.log(PREFIX, direction, {
      url: socket.url, readyState: socket.readyState,
      parsed, raw: payload, timestamp: new Date().toISOString(),
    });

    if (!listEl) return; // sidebar not ready yet

    const p = { id: packetId++, direction, parsed, timestamp: Date.now() };
    packets.push(p);
    if (packets.length > MAX_PACKETS * 2) packets = packets.slice(-MAX_PACKETS);
    updateCount();
    appendPacketEl(p);
  }

  // ─── WebSocket hooks ──────────────────────────────────────────────────────────
  const originalSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function patchedSend(data) {
    try { logPacket("OUT", this, data); } catch (err) { console.warn(PREFIX, "OUT log fail", err); }
    return originalSend.call(this, data);
  };

  const originalAddEventListener = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
    if (type !== "message" || typeof listener !== "function")
      return originalAddEventListener.call(this, type, listener, options);
    const wrapped = function wrappedMessageListener(event) {
      try { logPacket("IN", this, event.data); } catch (err) { console.warn(PREFIX, "IN log fail", err); }
      return listener.call(this, event);
    };
    return originalAddEventListener.call(this, type, wrapped, options);
  };

  const onMessageDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
  if (onMessageDescriptor?.set && onMessageDescriptor?.get) {
    Object.defineProperty(WebSocket.prototype, "onmessage", {
      configurable: true,
      enumerable: onMessageDescriptor.enumerable,
      get: onMessageDescriptor.get,
      set(handler) {
        if (typeof handler !== "function") return onMessageDescriptor.set.call(this, handler);
        const wrapped = (event) => {
          try { logPacket("IN", this, event.data); } catch (err) { console.warn(PREFIX, "IN log fail", err); }
          return handler.call(this, event);
        };
        return onMessageDescriptor.set.call(this, wrapped);
      },
    });
  }

  // ─── Keyboard shortcut ────────────────────────────────────────────────────────
  window.addEventListener("keydown", (e) => {
    if (e.key === "k" || e.key === "K") {
      // Don't trigger if typing in an input
      if (document.activeElement?.tagName === "INPUT" ||
          document.activeElement?.tagName === "TEXTAREA") return;
      toggleSidebar();
    }
  });

  // ─── Init (wait for DOM) ──────────────────────────────────────────────────────
  function init() {
    injectStyles();
    buildSidebar();
    console.log(PREFIX, "sidebar installed — press [K] to toggle");
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
    // Fallback for very early script injection
    const observer = new MutationObserver(() => {
      if (document.body) { observer.disconnect(); init(); }
    });
    observer.observe(document.documentElement, { childList: true });
  }
})();
