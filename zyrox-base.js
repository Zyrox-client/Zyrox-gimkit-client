// ==UserScript==
// @name         Zyrox Client
// @namespace    https://github.com/zyrox
// @version      0.5.4
// @description  Modern UI/menu shell for Zyrox client
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Bob-alt-828100/zyrox-gimkit-client/refs/heads/main/zyrox-base.js
// @downloadURL  https://raw.githubusercontent.com/Bob-alt-828100/zyrox-gimkit-client/refs/heads/main/zyrox-base.js
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  if (window.__ZYROX_UI_MOUNTED__) return;
  window.__ZYROX_UI_MOUNTED__ = true;

  function readUserscriptVersion() {
    // Update this variable whenever you bump @version above.
    const CLIENT_VERSION = "0.5.4";
    return CLIENT_VERSION;
  }

  const CONFIG = {
    toggleKey: "\\",
    defaultToggleKey: "\\",
    title: "Zyrox",
    subtitle: "Client",
    version: readUserscriptVersion(),
  };

  const MENU_LAYOUT = {
    general: {
      title: "General",
      groups: [
        {
          name: "Core",
          modules: ["Auto Answer", "Answer Streak", "Question Preview", "Skip Animation", "Instant Continue"],
        },
        {
          name: "Visual",
          modules: ["ESP", "HUD", "Overlay"],
        },
        {
          name: "Quality of Life",
          modules: ["Notifications", "Session Timer", "Hotkeys", "Clipboard Tools"],
        },
      ],
    },
    gamemodeSpecific: {
      title: "Gamemode Specific",
      groups: [
        {
          name: "Classic",
          modules: ["Classic Auto Buy", "Classic Streak Manager", "Classic Speed Round"],
        },
        {
          name: "Team Mode",
          modules: ["Team Comms Overlay", "Team Upgrade Sync", "Team Split Strategy"],
        },
        {
          name: "Capture The Flag",
          modules: ["Flag Pathing", "Flag Return Alert", "Carrier Tracker"],
        },
        {
          name: "Tag: Domination",
          modules: ["Zone Priority", "Tag Timer Overlay", "Defense Rotation"],
        },
        {
          name: "The Floor Is Lava",
          modules: ["Safe Tile Highlight", "Lava Cycle Timer", "Route Assist"],
        },
      ],
    },
  };

  const state = {
    visible: true,
    searchQuery: "",
    shellWidth: 1160,
    shellHeight: 640,
    enabledModules: new Set(),
    moduleItems: new Map(),
    modulePanels: new Map(),
    moduleEntries: [],
    moduleConfig: new Map(),
    listeningForBind: null,
    listeningForMenuBind: false,
  };

  const style = document.createElement("style");
  style.textContent = `
    :root {
      --zyx-border: rgba(255, 58, 58, 0.35);
      --zyx-border-soft: rgba(255, 255, 255, 0.12);
      --zyx-text: #d6d6df;
      --zyx-text-strong: #fff;
      --zyx-muted: #9b9bab;
      --zyx-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
      --zyx-radius-xl: 14px;
      --zyx-radius-lg: 12px;
      --zyx-radius-md: 10px;
      --zyx-font: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    }

    .zyrox-root {
      all: initial;
      position: fixed;
      top: 28px;
      left: 20px;
      z-index: 2147483647;
      color: var(--zyx-text);
      user-select: none;
      font-family: var(--zyx-font);
    }

    .zyrox-root * { box-sizing: border-box; font-family: inherit; }
    .zyrox-hidden { display: none !important; }

    .zyrox-shell {
      position: relative;
      display: inline-flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px;
      width: 1160px;
      height: 640px;
      border-radius: var(--zyx-radius-xl);
      border: 1px solid var(--zyx-border-soft);
      background: linear-gradient(150deg, rgba(255, 54, 54, 0.08), rgba(0, 0, 0, 0.45));
      backdrop-filter: blur(10px) saturate(115%);
      box-shadow: var(--zyx-shadow);
      overflow: auto;
    }

    .zyrox-topbar {
      min-height: 42px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      border-radius: var(--zyx-radius-lg);
      border: 1px solid var(--zyx-border);
      background: linear-gradient(125deg, rgba(255, 62, 62, 0.22), rgba(32, 10, 10, 0.9));
      cursor: move;
    }

    .zyrox-topbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .zyrox-brand { display: flex; align-items: center; gap: 10px; color: var(--zyx-text-strong); }

    .zyrox-logo {
      width: 18px;
      height: 18px;
      border-radius: 6px;
      background: radial-gradient(circle at 30% 30%, #ff8b8b 0%, #ff3d3d 45%, #c31818 100%);
      box-shadow: 0 0 0 1px rgba(255,255,255,.25), 0 0 18px rgba(255,61,61,.45);
    }

    .zyrox-brand .title { font-size: 13px; font-weight: 700; line-height: 1; }
    .zyrox-brand .subtitle { font-size: 11px; font-weight: 500; color: rgba(255,255,255,.7); }

    .zyrox-chip {
      font-size: 10px;
      color: #ffd6d6;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 91, 91, 0.55);
      border-radius: 999px;
      padding: 4px 8px;
      line-height: 1;
    }

    .zyrox-keybind-btn {
      font-size: 11px;
      color: #ffd6d6;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 91, 91, 0.55);
      border-radius: 8px;
      padding: 4px 8px;
      line-height: 1;
      cursor: pointer;
    }

    .zyrox-settings-btn {
      width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      color: #ffd6d6;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 91, 91, 0.55);
      border-radius: 8px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
    }

    .zyrox-search {
      width: 190px;
      height: 28px;
      border-radius: 8px;
      border: 1px solid rgba(255, 108, 108, 0.45);
      background: rgba(10, 8, 8, 0.72);
      color: #ffe6e6;
      padding: 0 10px;
      font-size: 12px;
      outline: none;
    }

    .zyrox-search:focus {
      border-color: rgba(255, 130, 130, 0.8);
      box-shadow: 0 0 0 2px rgba(255, 61, 61, 0.22);
    }

    .zyrox-section { display: flex; flex-direction: column; gap: 7px; }
    .zyrox-section-label {
      font-size: 11px;
      letter-spacing: 0.25px;
      color: #ffb0b0;
      padding-left: 2px;
      text-transform: uppercase;
    }

    .zyrox-panels {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: flex-start;
      align-content: flex-start;
      overflow: auto;
      max-width: 100%;
      padding-bottom: 2px;
      max-height: 38vh;
    }

    .zyrox-panels::-webkit-scrollbar { width: 8px; height: 8px; }
    .zyrox-panels::-webkit-scrollbar-thumb { background: rgba(255, 61, 61, 0.3); border-radius: 999px; }

    .zyrox-panel {
      width: 212px;
      border-radius: var(--zyx-radius-lg);
      border: 1px solid var(--zyx-border-soft);
      background: linear-gradient(180deg, rgba(24, 24, 30, 0.9), rgba(10, 10, 12, 0.9));
      overflow: hidden;
    }

    .zyrox-panel-header {
      min-height: 33px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 600;
      color: var(--zyx-text-strong);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: linear-gradient(90deg, rgba(255, 61, 61, 0.24), rgba(40, 12, 12, 0.92));
    }

    .zyrox-panel-count {
      font-size: 10px;
      color: #ffd9d9;
      background: rgba(8, 8, 10, 0.6);
      border: 1px solid rgba(255, 100, 100, 0.4);
      border-radius: 999px;
      padding: 3px 7px;
      line-height: 1;
    }

    .zyrox-module-list { margin: 0; padding: 7px; list-style: none; display: flex; flex-direction: column; gap: 5px; }

    .zyrox-module {
      min-height: 30px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 10px;
      font-size: 13px;
      font-weight: 500;
      color: var(--zyx-text);
      border: 1px solid transparent;
      border-radius: var(--zyx-radius-md);
      background: rgba(255, 255, 255, 0.03);
      transition: transform .11s ease, background .11s ease, border-color .11s ease, color .11s ease;
      cursor: pointer;
      white-space: nowrap;
    }

    .zyrox-module:hover {
      background: rgba(30, 30, 36, 0.9);
      border-color: rgba(255, 255, 255, 0.14);
      color: #fff;
      transform: translateX(2px);
    }

    .zyrox-module.active {
      color: #fff;
      background: linear-gradient(90deg, rgba(255, 61, 61, 0.32), rgba(40, 10, 10, 0.8));
      border-color: rgba(255, 61, 61, 0.52);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
    }

    .zyrox-bind-label {
      font-size: 10px;
      color: var(--zyx-muted);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 2px 5px;
      line-height: 1;
      background: rgba(0, 0, 0, 0.35);
    }

    .zyrox-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      color: var(--zyx-muted);
      font-size: 11px;
      padding: 0 3px;
    }

    .zyrox-config {
      position: relative;
      z-index: 2147483649;
      min-width: 340px;
      border-radius: 11px;
      border: 1px solid rgba(255, 79, 79, 0.45);
      background: linear-gradient(180deg, rgba(18, 18, 22, 0.97), rgba(8, 8, 10, 0.97));
      box-shadow: var(--zyx-shadow);
      overflow: hidden;
    }

    .zyrox-config.hidden { display: none !important; }
    .zyrox-config-header { padding: 11px 13px; border-bottom: 1px solid rgba(255,255,255,.09); background: linear-gradient(90deg, rgba(255, 61, 61, .23), rgba(45, 12, 12, .95)); }
    .zyrox-config-title { color: #fff; font-size: 14px; font-weight: 700; margin-bottom: 3px; }
    .zyrox-config-sub { color: #b8b8c2; font-size: 12px; }
    .zyrox-config-body { padding: 13px; }
    .zyrox-config-row { display:flex; justify-content:space-between; align-items:center; gap:8px; color:#d8d8df; font-size:14px; }
    .zyrox-config-actions { display: flex; align-items: center; gap: 6px; }

    .zyrox-btn {
      border: 1px solid rgba(255, 94, 94, 0.5);
      background: rgba(255, 61, 61, 0.12);
      color: #ffdada;
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 12px;
      cursor: pointer;
    }

    .zyrox-btn:hover { background: rgba(255, 61, 61, 0.2); color: #fff; }

    .zyrox-btn-square {
      width: 33px;
      height: 33px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      line-height: 1;
      font-size: 16px;
    }

    .zyrox-config-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483648;
      background: rgba(0, 0, 0, 0.26);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .zyrox-config-backdrop.hidden { display: none !important; }

    .zyrox-settings {
      position: relative;
      z-index: 2147483649;
      width: min(640px, 90vw);
      border-radius: 12px;
      border: 1px solid rgba(255, 79, 79, 0.45);
      background: linear-gradient(180deg, rgba(18, 18, 22, 0.97), rgba(8, 8, 10, 0.97));
      box-shadow: var(--zyx-shadow);
      overflow: hidden;
      color: #fff;
    }

    .zyrox-settings.hidden { display: none !important; }
    .zyrox-settings-header { padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,.09); background: linear-gradient(90deg, rgba(255, 61, 61, .23), rgba(45, 12, 12, .95)); }
    .zyrox-settings-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
    .zyrox-settings-sub { font-size: 12px; color: #c2c2ce; }
    .zyrox-settings-body { padding: 14px; display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 12px; }
    .zyrox-setting-category {
      grid-column: 1 / -1;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .3px;
      color: #ffb9b9;
      margin-top: 2px;
    }
    .zyrox-setting-card { border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 10px; background: rgba(255,255,255,.03); }
    .zyrox-setting-card label { display:block; font-size: 12px; margin-bottom: 8px; color: #ffe5e5; }
    .zyrox-setting-card input[type='color'] { width: 100%; height: 34px; border: none; background: transparent; cursor: pointer; }
    .zyrox-setting-card input[type='range'] { width: 100%; }
    .zyrox-settings-actions { display:flex; justify-content:flex-end; gap:8px; padding: 0 14px 14px; }
    .zyrox-close-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      border: 1px solid rgba(255, 95, 95, 0.4);
      background: rgba(0, 0, 0, 0.25);
      color: #ffdada;
      cursor: pointer;
      line-height: 1;
      font-size: 14px;
    }

    .zyrox-resize-handle {
      position: absolute;
      right: 2px;
      bottom: 2px;
      width: 14px;
      height: 14px;
      cursor: nwse-resize;
      border-right: 2px solid rgba(255, 110, 110, 0.85);
      border-bottom: 2px solid rgba(255, 110, 110, 0.85);
      border-radius: 0 0 8px 0;
      opacity: 0.9;
    }
  `;

  const root = document.createElement("div");
  root.className = "zyrox-root";

  const shell = document.createElement("div");
  shell.className = "zyrox-shell";

  const topbar = document.createElement("div");
  topbar.className = "zyrox-topbar";
  topbar.innerHTML = `
    <div class="zyrox-brand">
      <span class="zyrox-logo"></span>
      <div>
        <div class="title">${CONFIG.title}</div>
        <div class="subtitle">${CONFIG.subtitle}</div>
      </div>
    </div>
    <div class="zyrox-topbar-right">
      <input class="zyrox-search" type="text" placeholder="Search utilities..." autocomplete="off" />
      <button class="zyrox-settings-btn" type="button" title="Open client settings">⚙</button>
      <span class="zyrox-chip">v${CONFIG.version}</span>
    </div>
  `;

  const searchInput = topbar.querySelector(".zyrox-search");
  const settingsBtn = topbar.querySelector(".zyrox-settings-btn");

  const generalSection = document.createElement("section");
  generalSection.className = "zyrox-section";
  generalSection.innerHTML = `<div class="zyrox-section-label">General</div>`;

  const gamemodeSection = document.createElement("section");
  gamemodeSection.className = "zyrox-section";
  gamemodeSection.innerHTML = `<div class="zyrox-section-label">Gamemode Specific</div>`;

  const footer = document.createElement("div");
  footer.className = "zyrox-footer";
  footer.innerHTML = `<span>Press <b>${CONFIG.toggleKey}</b> to show/hide menu</span><span>Right click modules for settings</span>`;

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "zyrox-resize-handle";

  const configMenu = document.createElement("div");
  configMenu.className = "zyrox-config hidden";
  configMenu.innerHTML = `
    <div class="zyrox-config-header">
      <div class="zyrox-config-title">Module Config</div>
      <div class="zyrox-config-sub">Edit settings</div>
    </div>
    <button class="zyrox-close-btn config-close-btn" type="button" title="Close">✕</button>
    <div class="zyrox-config-body">
      <div class="zyrox-config-row">
        <span>Keybind</span>
        <div class="zyrox-config-actions">
          <button class="zyrox-btn zyrox-btn-square" type="button" title="Reset keybind">↺</button>
          <button class="zyrox-btn" type="button">Set keybind</button>
        </div>
      </div>
    </div>
  `;

  const configBackdrop = document.createElement("div");
  configBackdrop.className = "zyrox-config-backdrop hidden";
  configBackdrop.appendChild(configMenu);

  const settingsMenu = document.createElement("div");
  settingsMenu.className = "zyrox-settings hidden";
  settingsMenu.innerHTML = `
    <div class="zyrox-settings-header">
      <div class="zyrox-settings-title">Client Settings</div>
      <div class="zyrox-settings-sub">Customize colors and appearance</div>
    </div>
    <button class="zyrox-close-btn settings-close-top" type="button" title="Close">✕</button>
    <div class="zyrox-settings-body">
      <div class="zyrox-setting-category">Controls</div>
      <div class="zyrox-setting-card">
        <label>Menu Toggle Key</label>
        <button class="zyrox-keybind-btn settings-menu-key" type="button">Menu Key: ${CONFIG.toggleKey}</button>
        <button class="zyrox-btn zyrox-btn-square settings-menu-key-reset" type="button" title="Reset menu key">↺</button>
      </div>
      <div class="zyrox-setting-card">
        <label>UI Scale</label>
        <input type="range" class="set-scale" min="80" max="130" value="100" />
      </div>
      <div class="zyrox-setting-category">Theme</div>
      <div class="zyrox-setting-card">
        <label>Accent Color</label>
        <input type="color" class="set-accent" value="#ff3d3d" />
      </div>
      <div class="zyrox-setting-card">
        <label>Panel Border</label>
        <input type="color" class="set-border" value="#ff6f6f" />
      </div>
      <div class="zyrox-setting-card">
        <label>Text Color</label>
        <input type="color" class="set-text" value="#d6d6df" />
      </div>
      <div class="zyrox-setting-card">
        <label>Background Opacity</label>
        <input type="range" class="set-opacity" min="20" max="100" value="45" />
      </div>
      <div class="zyrox-setting-category">Appearance</div>
      <div class="zyrox-setting-card">
        <label>Corner Radius</label>
        <input type="range" class="set-radius" min="6" max="20" value="14" />
      </div>
      <div class="zyrox-setting-card">
        <label>Panel Blur</label>
        <input type="range" class="set-blur" min="0" max="16" value="10" />
      </div>
    </div>
    <div class="zyrox-settings-actions">
      <button class="zyrox-btn settings-reset" type="button">Reset Appearance</button>
      <button class="zyrox-btn settings-close" type="button">Close</button>
    </div>
  `;
  configBackdrop.appendChild(settingsMenu);

  const configTitleEl = configMenu.querySelector(".zyrox-config-title");
  const configSubEl = configMenu.querySelector(".zyrox-config-sub");
  const configCloseBtn = configMenu.querySelector(".config-close-btn");
  const resetBindBtn = configMenu.querySelector(".zyrox-btn-square");
  const setBindBtn = configMenu.querySelector(".zyrox-btn:not(.zyrox-btn-square)");
  const settingsMenuKeyBtn = settingsMenu.querySelector(".settings-menu-key");
  const settingsMenuKeyResetBtn = settingsMenu.querySelector(".settings-menu-key-reset");
  const settingsTopCloseBtn = settingsMenu.querySelector(".settings-close-top");
  const accentInput = settingsMenu.querySelector(".set-accent");
  const borderInput = settingsMenu.querySelector(".set-border");
  const textInput = settingsMenu.querySelector(".set-text");
  const opacityInput = settingsMenu.querySelector(".set-opacity");
  const scaleInput = settingsMenu.querySelector(".set-scale");
  const radiusInput = settingsMenu.querySelector(".set-radius");
  const blurInput = settingsMenu.querySelector(".set-blur");
  const settingsResetBtn = settingsMenu.querySelector(".settings-reset");
  const settingsCloseBtn = settingsMenu.querySelector(".settings-close");
  let openConfigModule = null;

  function moduleCfg(name) {
    if (!state.moduleConfig.has(name)) {
      state.moduleConfig.set(name, { keybind: null });
    }
    return state.moduleConfig.get(name);
  }

  function setBindLabel(item, moduleName) {
    const label = item.querySelector(".zyrox-bind-label");
    const bind = moduleCfg(moduleName).keybind;
    label.textContent = bind || "-";
  }

  function toggleModule(moduleName) {
    const item = state.moduleItems.get(moduleName);
    if (!item) return;

    if (state.enabledModules.has(moduleName)) {
      state.enabledModules.delete(moduleName);
      item.classList.remove("active");
    } else {
      state.enabledModules.add(moduleName);
      item.classList.add("active");
    }
  }

  function closeConfig() {
    configBackdrop.classList.add("hidden");
    configMenu.classList.add("hidden");
    settingsMenu.classList.add("hidden");
    openConfigModule = null;
    state.listeningForBind = null;
    setBindBtn.textContent = "Set keybind";
  }

  function openConfig(moduleName) {
    openConfigModule = moduleName;
    const cfg = moduleCfg(moduleName);

    configTitleEl.textContent = moduleName;
    configSubEl.textContent = cfg.keybind ? `Current bind: ${cfg.keybind}` : "No keybind assigned";
    setBindBtn.textContent = "Set keybind";

    configBackdrop.classList.remove("hidden");
    configMenu.classList.remove("hidden");
    settingsMenu.classList.add("hidden");
  }

  function openSettings() {
    configBackdrop.classList.remove("hidden");
    settingsMenu.classList.remove("hidden");
    configMenu.classList.add("hidden");
  }

  function applyAppearance() {
    const accent = accentInput.value;
    const border = borderInput.value;
    const text = textInput.value;
    const opacity = Number(opacityInput.value) / 100;
    const scale = Number(scaleInput.value) / 100;
    const radius = Number(radiusInput.value);
    const blur = Number(blurInput.value);
    shell.style.setProperty("--zyx-border", `${border}99`);
    shell.style.setProperty("--zyx-text", text);
    shell.style.setProperty("--zyx-radius-xl", `${radius}px`);
    shell.style.transform = `scale(${scale.toFixed(2)})`;
    shell.style.transformOrigin = "top left";
    shell.style.background = `linear-gradient(150deg, ${accent}22, rgba(0, 0, 0, ${opacity.toFixed(2)}))`;
    shell.style.backdropFilter = `blur(${blur}px) saturate(115%)`;
  }

  function applySearchFilter() {
    const query = state.searchQuery.trim().toLowerCase();

    for (const entry of state.moduleEntries) {
      const visible = !query || entry.name.toLowerCase().includes(query);
      entry.item.style.display = visible ? "" : "none";
    }

    for (const [panel, meta] of state.modulePanels.entries()) {
      let visibleCount = 0;
      for (const moduleName of meta.modules) {
        const item = state.moduleItems.get(moduleName);
        if (item && item.style.display !== "none") visibleCount += 1;
      }

      panel.style.display = visibleCount > 0 ? "" : "none";
      meta.countEl.textContent = `${visibleCount}`;
    }
  }

  function buildPanel(name, modules) {
    const panel = document.createElement("section");
    panel.className = "zyrox-panel";

    const header = document.createElement("header");
    header.className = "zyrox-panel-header";

    const title = document.createElement("span");
    title.textContent = name;

    const count = document.createElement("span");
    count.className = "zyrox-panel-count";
    count.textContent = `${modules.length}`;

    header.appendChild(title);
    header.appendChild(count);

    const list = document.createElement("ul");
    list.className = "zyrox-module-list";

    for (const moduleName of modules) {
      const item = document.createElement("li");
      item.className = "zyrox-module";
      item.innerHTML = `<span>${moduleName}</span><span class="zyrox-bind-label">-</span>`;

      state.moduleItems.set(moduleName, item);
      state.moduleEntries.push({ name: moduleName, item, panel });
      moduleCfg(moduleName);
      setBindLabel(item, moduleName);

      item.addEventListener("click", () => {
        toggleModule(moduleName);
      });

      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openConfig(moduleName);
      });

      list.appendChild(item);
    }

    panel.appendChild(header);
    panel.appendChild(list);
    state.modulePanels.set(panel, { countEl: count, modules: [...modules] });
    return panel;
  }

  setBindBtn.addEventListener("click", () => {
    if (!openConfigModule) return;
    state.listeningForBind = openConfigModule;
    setBindBtn.textContent = "Press any key...";
  });

  settingsMenuKeyBtn.addEventListener("click", () => {
    state.listeningForMenuBind = true;
    settingsMenuKeyBtn.textContent = "Press key...";
    searchInput.blur();
  });

  settingsMenuKeyResetBtn.addEventListener("click", () => {
    CONFIG.toggleKey = CONFIG.defaultToggleKey;
    settingsMenuKeyBtn.textContent = `Menu Key: ${CONFIG.toggleKey}`;
    footer.innerHTML = `<span>Press <b>${CONFIG.toggleKey}</b> to show/hide menu</span><span>Right click modules for settings</span>`;
    state.listeningForMenuBind = false;
  });

  settingsBtn.addEventListener("click", () => {
    openSettings();
  });

  resetBindBtn.addEventListener("click", () => {
    if (!openConfigModule) return;
    const cfg = moduleCfg(openConfigModule);
    cfg.keybind = null;
    const item = state.moduleItems.get(openConfigModule);
    if (item) setBindLabel(item, openConfigModule);
    configSubEl.textContent = "No keybind assigned";
    state.listeningForBind = null;
    setBindBtn.textContent = "Set keybind";
  });

  searchInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === CONFIG.toggleKey) {
      event.preventDefault();
      setVisible(false);
    }
  });

  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    applySearchFilter();
  });

  accentInput.addEventListener("input", applyAppearance);
  borderInput.addEventListener("input", applyAppearance);
  textInput.addEventListener("input", applyAppearance);
  opacityInput.addEventListener("input", applyAppearance);
  scaleInput.addEventListener("input", applyAppearance);
  radiusInput.addEventListener("input", applyAppearance);
  blurInput.addEventListener("input", applyAppearance);

  settingsResetBtn.addEventListener("click", () => {
    accentInput.value = "#ff3d3d";
    borderInput.value = "#ff6f6f";
    textInput.value = "#d6d6df";
    opacityInput.value = "45";
    scaleInput.value = "100";
    radiusInput.value = "14";
    blurInput.value = "10";
    shell.style.removeProperty("--zyx-border");
    shell.style.removeProperty("--zyx-text");
    shell.style.removeProperty("--zyx-radius-xl");
    shell.style.background = "";
    shell.style.transform = "";
    shell.style.backdropFilter = "";
  });

  settingsCloseBtn.addEventListener("click", () => {
    closeConfig();
  });
  configCloseBtn.addEventListener("click", () => closeConfig());
  settingsTopCloseBtn.addEventListener("click", () => closeConfig());

  const generalPanels = document.createElement("div");
  generalPanels.className = "zyrox-panels";
  for (const generalGroup of MENU_LAYOUT.general.groups) {
    generalPanels.appendChild(buildPanel(generalGroup.name, generalGroup.modules));
  }
  generalSection.appendChild(generalPanels);

  const gamemodePanels = document.createElement("div");
  gamemodePanels.className = "zyrox-panels";
  for (const gm of MENU_LAYOUT.gamemodeSpecific.groups) {
    gamemodePanels.appendChild(buildPanel(gm.name, gm.modules));
  }
  gamemodeSection.appendChild(gamemodePanels);

  shell.appendChild(topbar);
  shell.appendChild(generalSection);
  shell.appendChild(gamemodeSection);
  shell.appendChild(footer);
  shell.appendChild(resizeHandle);

  root.appendChild(shell);

  document.head.appendChild(style);
  document.body.appendChild(root);
  document.body.appendChild(configBackdrop);

  function setVisible(nextVisible) {
    state.visible = nextVisible;
    root.classList.toggle("zyrox-hidden", !nextVisible);
    if (!nextVisible) closeConfig();
    if (nextVisible) {
      requestAnimationFrame(() => {
        searchInput.focus();
        if (searchInput.value === CONFIG.toggleKey) {
          searchInput.value = "";
          state.searchQuery = "";
          applySearchFilter();
        }
      });
    }
  }

  document.addEventListener("keydown", (event) => {
    if (state.listeningForMenuBind) {
      event.preventDefault();
      CONFIG.toggleKey = event.key;
      settingsMenuKeyBtn.textContent = `Menu Key: ${CONFIG.toggleKey}`;
      footer.innerHTML = `<span>Press <b>${CONFIG.toggleKey}</b> to show/hide menu</span><span>Right click modules for settings</span>`;
      state.listeningForMenuBind = false;
      return;
    }

    if (state.listeningForBind && openConfigModule === state.listeningForBind) {
      event.preventDefault();
      const cfg = moduleCfg(openConfigModule);
      cfg.keybind = event.key;
      const item = state.moduleItems.get(openConfigModule);
      if (item) setBindLabel(item, openConfigModule);
      configSubEl.textContent = `Current bind: ${cfg.keybind}`;
      setBindBtn.textContent = "Set keybind";
      state.listeningForBind = null;
      return;
    }

    if (event.key === CONFIG.toggleKey) {
      event.preventDefault();
      setVisible(!state.visible);
      return;
    }

    for (const [moduleName, cfg] of state.moduleConfig) {
      if (cfg.keybind && cfg.keybind === event.key) {
        toggleModule(moduleName);
      }
    }
  });

  // Intentionally no backdrop click-to-close; menus close only via explicit close buttons.

  let dragState = null;
  let resizeState = null;

  topbar.addEventListener("mousedown", (event) => {
    const rootBox = root.getBoundingClientRect();
    dragState = {
      offsetX: event.clientX - rootBox.left,
      offsetY: event.clientY - rootBox.top,
    };
    event.preventDefault();
  });

  document.addEventListener("mousemove", (event) => {
    if (!dragState) return;

    const nextX = Math.max(0, event.clientX - dragState.offsetX);
    const nextY = Math.max(0, event.clientY - dragState.offsetY);

    root.style.left = `${nextX}px`;
    root.style.top = `${nextY}px`;
  });

  document.addEventListener("mouseup", () => {
    dragState = null;
    resizeState = null;
  });

  resizeHandle.addEventListener("mousedown", (event) => {
    resizeState = {
      startX: event.clientX,
      startY: event.clientY,
      startWidth: state.shellWidth,
      startHeight: state.shellHeight,
    };
    event.preventDefault();
    event.stopPropagation();
  });

  document.addEventListener("mousemove", (event) => {
    if (!resizeState) return;

    const width = Math.max(760, resizeState.startWidth + (event.clientX - resizeState.startX));
    const height = Math.max(420, resizeState.startHeight + (event.clientY - resizeState.startY));
    state.shellWidth = width;
    state.shellHeight = height;
    shell.style.width = `${width}px`;
    shell.style.height = `${height}px`;
  });
})();
