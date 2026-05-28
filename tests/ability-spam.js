// ==UserScript==
// @name         Zyrox ability spam test
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Small test HUD for buying/using Icer, requesting the player leaderboard, and sending freeze attacks.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG = "[ZyroxAbilitySpam]";
  const FREEZE_ABILITY = "Icer";
  if (window.__zyroxAbilitySpam?.destroy) {
    window.__zyroxAbilitySpam.destroy();
  }

  function msgpackEncode(value) {
    const bytes = [];
    const deferred = [];
    const utf8Length = (input) => {
      let len = 0;
      for (let i = 0; i < input.length; i += 1) {
        const code = input.charCodeAt(i);
        if (code < 0x80) len += 1;
        else if (code < 0x800) len += 2;
        else if (code < 0xd800 || code > 0xdfff) len += 3;
        else { i += 1; len += 4; }
      }
      return len;
    };
    const writeStringBytes = (target, input, offset) => {
      let cursor = offset;
      for (let i = 0; i < input.length; i += 1) {
        let code = input.charCodeAt(i);
        if (code < 0x80) target[cursor++] = code;
        else if (code < 0x800) {
          target[cursor++] = 0xc0 | (code >> 6);
          target[cursor++] = 0x80 | (code & 0x3f);
        } else if (code < 0xd800 || code > 0xdfff) {
          target[cursor++] = 0xe0 | (code >> 12);
          target[cursor++] = 0x80 | ((code >> 6) & 0x3f);
          target[cursor++] = 0x80 | (code & 0x3f);
        } else {
          const next = input.charCodeAt(++i);
          code = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff));
          target[cursor++] = 0xf0 | (code >> 18);
          target[cursor++] = 0x80 | ((code >> 12) & 0x3f);
          target[cursor++] = 0x80 | ((code >> 6) & 0x3f);
          target[cursor++] = 0x80 | (code & 0x3f);
        }
      }
    };
    const write = (input) => {
      const type = typeof input;
      if (input == null) { bytes.push(0xc0); return; }
      if (type === "boolean") { bytes.push(input ? 0xc3 : 0xc2); return; }
      if (type === "number") {
        if (Number.isInteger(input) && input >= 0 && input < 0x80) { bytes.push(input); return; }
        if (Number.isInteger(input) && input >= 0 && input < 0x100) { bytes.push(0xcc, input); return; }
        if (Number.isInteger(input) && input >= 0 && input < 0x10000) { bytes.push(0xcd, input >> 8, input & 0xff); return; }
        if (Number.isInteger(input) && input >= 0 && input <= 0xffffffff) { bytes.push(0xce, input >>> 24, (input >>> 16) & 0xff, (input >>> 8) & 0xff, input & 0xff); return; }
        if (Number.isInteger(input) && input >= -0x20 && input < 0) { bytes.push(0x100 + input); return; }
        if (Number.isInteger(input) && input >= -0x80 && input < 0) { bytes.push(0xd0, input & 0xff); return; }
        bytes.push(0xcb);
        deferred.push({ type: "float64", value: input, offset: bytes.length });
        bytes.length += 8;
        return;
      }
      if (type === "string") {
        const len = utf8Length(input);
        if (len < 32) bytes.push(0xa0 | len);
        else if (len < 0x100) bytes.push(0xd9, len);
        else bytes.push(0xda, len >> 8, len & 0xff);
        deferred.push({ type: "string", value: input, offset: bytes.length });
        bytes.length += len;
        return;
      }
      if (Array.isArray(input)) {
        const len = input.length;
        if (len < 16) bytes.push(0x90 | len);
        else bytes.push(0xdc, len >> 8, len & 0xff);
        input.forEach(write);
        return;
      }
      const keys = Object.keys(input);
      if (keys.length < 16) bytes.push(0x80 | keys.length);
      else bytes.push(0xde, keys.length >> 8, keys.length & 0xff);
      keys.forEach((key) => { write(key); write(input[key]); });
    };

    write(value);
    const out = new Uint8Array(bytes.length);
    bytes.forEach((byte, index) => { out[index] = byte || 0; });
    deferred.forEach((item) => {
      if (item.type === "string") writeStringBytes(out, item.value, item.offset);
      else new DataView(out.buffer).setFloat64(item.offset, item.value);
    });
    return out.buffer;
  }

  function msgpackDecode(buffer, startOffset = 0) {
    const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.length);
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
      if (token < 0x90) { const map = {}; for (let i = 0, n = token & 0x0f; i < n; i += 1) map[read()] = read(); return map; }
      if (token < 0xa0) { const arr = []; for (let i = 0, n = token & 0x0f; i < n; i += 1) arr.push(read()); return arr; }
      if (token < 0xc0) return readString(token & 0x1f);
      if (token > 0xdf) return token - 256;
      switch (token) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xca: { const v = view.getFloat32(offset); offset += 4; return v; }
        case 0xcb: { const v = view.getFloat64(offset); offset += 8; return v; }
        case 0xcc: { const v = view.getUint8(offset); offset += 1; return v; }
        case 0xcd: { const v = view.getUint16(offset); offset += 2; return v; }
        case 0xce: { const v = view.getUint32(offset); offset += 4; return v; }
        case 0xd0: { const v = view.getInt8(offset); offset += 1; return v; }
        case 0xd1: { const v = view.getInt16(offset); offset += 2; return v; }
        case 0xd2: { const v = view.getInt32(offset); offset += 4; return v; }
        case 0xd9: { const n = view.getUint8(offset); offset += 1; return readString(n); }
        case 0xda: { const n = view.getUint16(offset); offset += 2; return readString(n); }
        case 0xdb: { const n = view.getUint32(offset); offset += 4; return readString(n); }
        case 0xdc: { const n = view.getUint16(offset); offset += 2; const arr = []; for (let i = 0; i < n; i += 1) arr.push(read()); return arr; }
        case 0xdd: { const n = view.getUint32(offset); offset += 4; const arr = []; for (let i = 0; i < n; i += 1) arr.push(read()); return arr; }
        case 0xde: { const n = view.getUint16(offset); offset += 2; const map = {}; for (let i = 0; i < n; i += 1) map[read()] = read(); return map; }
        case 0xdf: { const n = view.getUint32(offset); offset += 4; const map = {}; for (let i = 0; i < n; i += 1) map[read()] = read(); return map; }
        default: return null;
      }
    };
    return { value: read(), offset };
  }

  function decodeBlueboatBinary(packet) {
    if (!(packet instanceof ArrayBuffer) && !ArrayBuffer.isView(packet)) return null;
    const buffer = packet instanceof ArrayBuffer ? packet : packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength);
    const bytes = new Uint8Array(buffer);
    if (!bytes.byteLength || bytes[0] !== 4) return null;
    const decoded = msgpackDecode(buffer.slice(1), 0)?.value;
    const data = decoded?.data;
    const eventName = Array.isArray(data) ? data[0] : null;
    const payload = Array.isArray(data) ? data[1] : data;
    if (!payload || typeof payload !== "object") return { eventName, payload, raw: decoded };
    return { ...payload, eventName, payload, raw: decoded };
  }

  class AbilitySpamSocketManager extends EventTarget {
    constructor() {
      super();
      this.socket = null;
      this.transportType = "unknown";
      this.blueboatRoomId = null;
      this.nativeWebSocket = window.WebSocket;
      this.nativeXMLSend = XMLHttpRequest.prototype.send;
      this.install();
    }

    install() {
      const manager = this;
      const NativeWebSocket = this.nativeWebSocket;
      window.WebSocket = class ZyroxAbilitySpamWebSocket extends NativeWebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          if (String(url || "").includes("gimkitconnect.com")) manager.registerSocket(this);
        }
        send(data) {
          manager.onSend(data);
          super.send(data);
        }
      };
      XMLHttpRequest.prototype.send = function sendPatched() {
        this.addEventListener("load", () => {
          if (!String(this.responseURL || "").endsWith("/matchmaker/join")) return;
          try {
            const response = JSON.parse(this.responseText);
            if (response?.roomId || response?.room) manager.blueboatRoomId = response.roomId || response.room;
          } catch (_) {}
        });
        return manager.nativeXMLSend.apply(this, arguments);
      };
    }

    registerSocket(socket) {
      this.socket = socket;
      socket.addEventListener("message", (event) => this.onMessage(event.data));
      this.dispatchEvent(new CustomEvent("status", { detail: "socket registered" }));
    }

    onMessage(data) {
      const bytes = (() => {
        try { return new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset || 0, data.byteLength || undefined); } catch (_) { return null; }
      })();
      if (!bytes?.length) return;
      if (this.transportType === "unknown") this.transportType = bytes[0] === 4 ? "blueboat" : "colyseus";
      const blueboatPacket = decodeBlueboatBinary(data);
      if (blueboatPacket) {
        if (typeof blueboatPacket.eventName === "string" && blueboatPacket.eventName.startsWith("message-")) {
          this.blueboatRoomId = blueboatPacket.eventName.slice("message-".length);
        }
        this.dispatchEvent(new CustomEvent("blueboatMessage", { detail: blueboatPacket }));
      }
    }

    onSend(data) {
      const packet = decodeBlueboatBinary(data);
      if (!packet) return;
      if (packet?.room) this.blueboatRoomId = packet.room;
      if (packet?.roomId) this.blueboatRoomId = packet.roomId;
      this.dispatchEvent(new CustomEvent("blueboatSend", { detail: packet }));
    }

    sendMessage(key, data) {
      if (!this.socket) return false;
      if (!this.blueboatRoomId) return false;
      const encoded = msgpackEncode({
        type: 2,
        data: ["blueboat_SEND_MESSAGE", { room: this.blueboatRoomId, key, data }],
        options: { compress: true },
        nsp: "/",
      });
      const packet = new Uint8Array(encoded.byteLength + 1);
      packet[0] = 4;
      packet.set(new Uint8Array(encoded), 1);
      this.socket.send(packet.buffer);
      return true;
    }

    destroy() {
      if (window.WebSocket?.name === "ZyroxAbilitySpamWebSocket") window.WebSocket = this.nativeWebSocket;
      XMLHttpRequest.prototype.send = this.nativeXMLSend;
    }
  }

  const ownedManager = window.socketManager ? null : new AbilitySpamSocketManager();
  const socketManager = window.socketManager || ownedManager;
  window.socketManager = socketManager;

  const state = {
    players: [],
    selectedTargetId: null,
    selfPlayerId: null,
    root: null,
    status: "Waiting for Gimkit socket…",
  };

  function sendMessage(key, data) {
    const canSend = Boolean(socketManager?.sendMessage && socketManager?.socket && socketManager?.blueboatRoomId);
    const ok = canSend && socketManager.sendMessage(key, data) !== false;
    setStatus(ok ? `Sent ${key}` : `Could not send ${key}; missing socket/room`);
    console.log(LOG, "send", { key, data, ok, room: socketManager?.blueboatRoomId });
    return ok;
  }

  function normalizePlayer(item) {
    if (!item || typeof item !== "object" || !item.id) return null;
    return {
      id: String(item.id),
      name: String(item.name || item.nickname || item.username || item.id),
    };
  }

  function onBlueboatMessage(event) {
    const packet = event?.detail;
    const key = packet?.key ?? packet?.payload?.key;
    if (packet?.eventName === "CLIENT_ID_SET") {
      const id = packet?.payload ?? packet?.data;
      if (typeof id === "string" && id.trim()) state.selfPlayerId = id.trim();
    }
    if (key !== "UPDATED_PLAYER_LEADERBOARD") return;
    const items = packet?.data?.items ?? packet?.payload?.data?.items;
    state.players = (Array.isArray(items) ? items : [])
      .map(normalizePlayer)
      .filter((player) => player && player.id !== state.selfPlayerId);
    setStatus(`Got ${state.players.length} leaderboard player(s)`);
    renderPlayerMenu();
  }

  function setStatus(message) {
    state.status = message;
    const status = state.root?.querySelector?.("#zyrox-ability-spam-status");
    if (status) status.textContent = message;
  }

  function buyFreeze() {
    sendMessage("POWERUP_PURCHASED", FREEZE_ABILITY);
  }

  function useFreeze() {
    sendMessage("POWERUP_ACTIVATED", FREEZE_ABILITY);
  }

  function requestLeaderboard() {
    sendMessage("PLAYER_LEADERBOARD_REQUESTED", null);
  }

  function freezeAttack(targetId = state.selectedTargetId) {
    if (!targetId) {
      setStatus("Pick a target first; requesting leaderboard…");
      requestLeaderboard();
      return;
    }
    sendMessage("POWERUP_ATTACK", { name: FREEZE_ABILITY, target: targetId });
  }

  function renderPlayerMenu() {
    document.getElementById("zyrox-ability-spam-player-menu")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "zyrox-ability-spam-player-menu";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif;";
    const panel = document.createElement("div");
    panel.style.cssText = "width:min(380px,calc(100vw - 24px));max-height:min(80vh,520px);overflow:auto;background:#111827;border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:12px;color:#fff;box-shadow:0 18px 50px rgba(0,0,0,.5);";
    const title = document.createElement("div");
    title.textContent = "Select freeze target";
    title.style.cssText = "font-weight:800;font-size:15px;margin-bottom:8px;";
    panel.appendChild(title);

    if (!state.players.length) {
      const empty = document.createElement("div");
      empty.textContent = "No targetable players found yet.";
      empty.style.cssText = "font-size:12px;color:#cbd5e1;margin-bottom:8px;";
      panel.appendChild(empty);
    }

    state.players.forEach((player) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = player.name;
      button.title = player.id;
      button.style.cssText = "display:block;width:100%;text-align:left;margin:0 0 6px;padding:8px 9px;border-radius:9px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.07);color:#fff;cursor:pointer;font-weight:700;";
      button.addEventListener("click", () => {
        state.selectedTargetId = player.id;
        setStatus(`Selected ${player.name}; sending POWERUP_ATTACK`);
        overlay.remove();
        freezeAttack(player.id);
      });
      panel.appendChild(button);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.style.cssText = "display:block;width:100%;margin-top:6px;padding:8px 9px;border-radius:9px;border:1px solid rgba(255,255,255,.2);background:rgba(239,68,68,.22);color:#fff;cursor:pointer;font-weight:800;";
    close.addEventListener("click", () => overlay.remove());
    panel.appendChild(close);
    overlay.appendChild(panel);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function makeButton(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = "appearance:none;border:1px solid rgba(255,255,255,.18);background:rgba(59,130,246,.28);color:#fff;border-radius:8px;padding:7px 9px;font-size:12px;font-weight:800;cursor:pointer;text-align:left;";
    button.addEventListener("click", handler);
    return button;
  }

  function mountWindow() {
    if (state.root?.isConnected) return;
    const root = document.createElement("div");
    root.id = "zyrox-ability-spam";
    root.style.cssText = "position:fixed;right:16px;top:116px;z-index:2147483646;width:210px;background:rgba(15,23,42,.93);color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:10px;font-family:Inter,system-ui,sans-serif;box-shadow:0 12px 38px rgba(0,0,0,.35);";
    const title = document.createElement("div");
    title.textContent = "Ability Spam";
    title.style.cssText = "font-size:13px;font-weight:900;margin-bottom:8px;letter-spacing:.02em;";
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:1fr;gap:6px;";
    grid.append(
      makeButton("Buy Freeze", buyFreeze),
      makeButton("Use Freeze", useFreeze),
      makeButton("Get Player Leaderboard", requestLeaderboard),
      makeButton("Freeze Attack", () => freezeAttack()),
    );
    const status = document.createElement("div");
    status.id = "zyrox-ability-spam-status";
    status.textContent = state.status;
    status.style.cssText = "margin-top:8px;color:#cbd5e1;font-size:11px;line-height:1.35;word-break:break-word;";
    root.append(title, grid, status);
    document.body.appendChild(root);
    state.root = root;
  }

  function destroy() {
    socketManager?.removeEventListener?.("blueboatMessage", onBlueboatMessage);
    state.root?.remove();
    document.getElementById("zyrox-ability-spam-player-menu")?.remove();
    ownedManager?.destroy?.();
    delete window.__zyroxAbilitySpam;
  }

  socketManager?.addEventListener?.("blueboatMessage", onBlueboatMessage);
  socketManager?.addEventListener?.("status", (event) => setStatus(event.detail));
  window.__zyroxAbilitySpam = { destroy, buyFreeze, useFreeze, requestLeaderboard, freezeAttack };

  if (document.body) mountWindow();
  else document.addEventListener("DOMContentLoaded", mountWindow, { once: true });
})();
