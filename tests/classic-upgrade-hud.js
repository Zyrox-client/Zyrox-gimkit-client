// ==UserScript==
// @name         Zyrox classic upgrade HUD logger
// @namespace    https://github.com/zyrox
// @version      0.2.0
// @description  Shows a top-right HUD for Classic upgrades and logs level changes from Blueboat packets.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxClassicUpgradeHud]";
  const DEFAULT_UPGRADES = ["moneyPerQuestion", "streakBonus", "multiplier", "insurance"];

  const state = {
    upgradeLevels: Object.create(null),
    settings: {
      displayTitle: true,
    },
    ui: {
      root: null,
      title: null,
      list: null,
      displayTitleToggle: null,
    },
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

  async function normalizeData(raw) {
    if (raw instanceof ArrayBuffer) return raw;
    if (ArrayBuffer.isView(raw)) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    if (typeof Blob !== "undefined" && raw instanceof Blob) return raw.arrayBuffer();
    return raw;
  }

  function formatUpgradeName(key) {
    return String(key)
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (c) => c.toUpperCase())
      .trim();
  }

  function ensureHud() {
    if (state.ui.root?.isConnected) return;

    const root = document.createElement("div");
    root.id = "zyrox-classic-upgrade-hud";
    root.style.cssText = [
      "position: fixed",
      "top: 12px",
      "right: 12px",
      "z-index: 2147483647",
      "min-width: 220px",
      "padding: 10px",
      "border-radius: 10px",
      "border: 1px solid rgba(255,255,255,.14)",
      "background: rgba(14, 16, 22, .86)",
      "color: #f4f6ff",
      "font: 12px/1.4 Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      "backdrop-filter: blur(6px)",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "Upgrades";
    title.style.cssText = "font-weight:700;letter-spacing:.04em;text-transform:uppercase;opacity:.9;margin-bottom:6px;";

    const list = document.createElement("div");
    list.style.cssText = "display:grid;gap:4px;margin-bottom:8px;";

    const settingsRow = document.createElement("label");
    settingsRow.style.cssText = "display:flex;align-items:center;gap:6px;opacity:.92;user-select:none;";

    const displayTitleToggle = document.createElement("input");
    displayTitleToggle.type = "checkbox";
    displayTitleToggle.checked = true;
    displayTitleToggle.addEventListener("change", () => {
      state.settings.displayTitle = Boolean(displayTitleToggle.checked);
      renderHud();
    });

    const settingsLabel = document.createElement("span");
    settingsLabel.textContent = "Display title";

    settingsRow.append(displayTitleToggle, settingsLabel);
    root.append(title, list, settingsRow);

    state.ui.root = root;
    state.ui.title = title;
    state.ui.list = list;
    state.ui.displayTitleToggle = displayTitleToggle;

    const mount = () => {
      if (root.isConnected) return;
      (document.body || document.documentElement).appendChild(root);
    };

    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });

    renderHud();
  }

  function renderHud() {
    ensureHud();

    state.ui.title.style.display = state.settings.displayTitle ? "block" : "none";
    state.ui.displayTitleToggle.checked = state.settings.displayTitle;

    const sourceKeys = Object.keys(state.upgradeLevels);
    const keys = sourceKeys.length ? sourceKeys : DEFAULT_UPGRADES;

    state.ui.list.innerHTML = "";
    for (const key of keys) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;gap:12px;";

      const name = document.createElement("span");
      name.textContent = formatUpgradeName(key);
      name.style.opacity = ".88";

      const level = document.createElement("span");
      level.textContent = String(state.upgradeLevels[key] ?? 0);
      level.style.fontWeight = "700";

      row.append(name, level);
      state.ui.list.appendChild(row);
    }
  }

  function logUpgradeChanges(nextLevels) {
    if (!nextLevels || typeof nextLevels !== "object") return;

    let changed = false;
    for (const upgradeName of Object.keys(nextLevels)) {
      const level = nextLevels[upgradeName];
      const prev = state.upgradeLevels[upgradeName];
      if (prev === level) continue;

      state.upgradeLevels[upgradeName] = level;
      changed = true;
      console.log(LOG_PREFIX, `${upgradeName}: level ${level}`);
    }

    if (changed) renderHud();
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

    onDecodedPacket(decodeBlueboatBinary(normalized));
  }

  function install() {
    ensureHud();

    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);

        if (!String(url || "").includes("gimkitconnect.com")) return;
        this.addEventListener("message", (event) => {
          inspectPacket(event.data).catch((err) => console.warn(LOG_PREFIX, "Failed to inspect incoming packet:", err));
        });
      }
    };

    window.__zyroxClassicUpgradeHud = {
      setDisplayTitle(enabled) {
        state.settings.displayTitle = Boolean(enabled);
        renderHud();
      },
      getState() {
        return {
          displayTitle: state.settings.displayTitle,
          levels: { ...state.upgradeLevels },
        };
      },
    };

    console.log(LOG_PREFIX, "Ready. HUD anchored top-right; logging UPGRADE_LEVELS changes.");
  }

  install();
})();
