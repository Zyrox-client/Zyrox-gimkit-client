// ==UserScript==
// @name         Zyrox client (gimkit)
// @namespace    https://github.com/zyrox
// @version      0.7.7
// @description  Modern UI/menu shell for Zyrox client
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Bob-alt-828100/zyrox-gimkit-client/refs/heads/main/zyrox-base.js
// @downloadURL  https://raw.githubusercontent.com/Bob-alt-828100/zyrox-gimkit-client/refs/heads/main/zyrox-base.js
// @icon         https://raw.githubusercontent.com/Bob-alt-828100/zyrox-gimkit-client/refs/heads/main/images/logo.png
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  // Some userscript runtimes execute bundled code that expects a global `Module`
  // constructor (e.g. `new Module(...)`). Provide a minimal callable fallback.
  if (typeof globalThis.Module === "undefined") {
    globalThis.Module = function Module() {};
  }

  if (window.__ZYROX_UI_MOUNTED__) return;
  window.__ZYROX_UI_MOUNTED__ = true;

  function readUserscriptVersion() {
    // Update this variable whenever you bump @version above.
    const CLIENT_VERSION = "0.7.7";
    return CLIENT_VERSION;
  }

  const CONFIG = {
    toggleKey: "\\",
    defaultToggleKey: "\\",
    title: "Zyrox",
    subtitle: "Client",
    version: readUserscriptVersion(),
    logoUrl: "https://raw.githubusercontent.com/Bob-alt-828100/zyrox-gimkit-client/refs/heads/main/images/logo.png",
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
    collapsedPanels: {},
    listeningForBind: null,
    listeningForMenuBind: false,
    searchAutofocus: true,
    displayMode: "merged",
    looseInitialized: false,
    loosePositions: {
      topbar: { x: 12, y: 12 },
    },
    loosePanelPositions: {},
    mergedRootPosition: { left: 20, top: 28 },
  };

  // Bumped to v3 — includes display-mode and loose layout position persistence
  const STORAGE_KEY = "zyrox_client_settings_v3";

  const style = document.createElement("style");
  style.textContent = `
    :root {
      --zyx-border: #ff6f6f99;
      --zyx-border-soft: rgba(255, 255, 255, 0.12);
      --zyx-text: #d6d6df;
      --zyx-text-strong: #fff;
      --zyx-header-text: #fff;
      --zyx-header-bg-start: rgba(255, 74, 74, 0.24);
      --zyx-header-bg-end: rgba(60, 18, 18, 0.92);
      --zyx-topbar-bg-start: rgba(255, 74, 74, 0.22);
      --zyx-topbar-bg-end: rgba(56, 16, 16, 0.9);
      --zyx-icon-color: #ffdada;
      --zyx-outline-color: #ff5b5bcc;
      --zyx-slider-color: #ff6b6b;
      --zyx-panel-count-text: #ffd9d9;
      --zyx-panel-count-border: rgba(255, 100, 100, 0.45);
      --zyx-panel-count-bg: rgba(8, 8, 10, 0.6);
      --zyx-settings-header-start: rgba(255, 61, 61, .3);
      --zyx-settings-header-end: rgba(45, 12, 12, .95);
      --zyx-settings-sidebar-bg: rgba(24, 24, 32, .22);
      --zyx-settings-body-bg: linear-gradient(180deg, rgba(18, 18, 22, 0.97), rgba(8, 8, 10, 0.97));
      --zyx-settings-text: #ffe5e5;
      --zyx-settings-subtext: #c2c2ce;
      --zyx-settings-card-bg: rgba(255,255,255,.03);
      --zyx-settings-card-border: rgba(255,255,255,.08);
      --zyx-accent-soft: #ffbdbd;
      --zyx-search-text: #ffe6e6;
      --zyx-checkmark-color: #ff6b6b;
      --zyx-module-hover-bg: rgba(30, 30, 36, 0.9);
      --zyx-module-hover-border: rgba(255, 255, 255, 0.14);
      --zyx-module-active-start: rgba(255, 61, 61, 0.32);
      --zyx-module-active-end: rgba(40, 10, 10, 0.8);
      --zyx-module-active-border: rgba(255, 61, 61, 0.52);
      --zyx-hover-shift: 2px;
      --zyx-shell-blur: 10px;
      --zyx-muted: #9b9bab;
      --zyx-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
      --zyx-radius-xl: 14px;
      --zyx-radius-lg: 12px;
      --zyx-radius-md: 10px;
      --zyx-font: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      /* FIX: button accent colours are now CSS variables, updated by applyAppearance() */
      --zyx-btn-bg: rgba(255, 61, 61, 0.12);
      --zyx-btn-hover-bg: rgba(255, 61, 61, 0.2);
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
      background: linear-gradient(150deg, #ff3d3d22, rgba(0, 0, 0, 0.45));
      backdrop-filter: blur(var(--zyx-shell-blur)) saturate(115%);
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
      background: linear-gradient(125deg, var(--zyx-topbar-bg-start), var(--zyx-topbar-bg-end));
      cursor: move;
    }

    .zyrox-topbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Hide legacy topbar category controls from older builds/state */
    .zyrox-collapse-row,
    .zyrox-collapse-btn {
      display: none !important;
    }

    .zyrox-shell.loose-mode {
      padding: 0;
      width: auto !important;
      height: auto !important;
      min-width: 0;
      min-height: 0;
      border: none;
      box-shadow: none;
      background: transparent !important;
      backdrop-filter: none !important;
      overflow: visible;
    }

    .zyrox-shell.loose-mode .zyrox-footer,
    .zyrox-shell.loose-mode .zyrox-resize-handle {
      display: none;
    }

    .zyrox-shell.loose-mode .zyrox-topbar {
      position: absolute;
      top: 0;
      left: 0;
      width: fit-content;
      min-height: 38px;
      padding: 6px 10px;
      z-index: 4;
    }

    .zyrox-shell.loose-mode .zyrox-section {
      display: contents;
    }

    .zyrox-shell.loose-mode .zyrox-section-label {
      display: none;
    }

    .zyrox-shell.loose-mode .zyrox-panels {
      display: block;
      overflow: visible;
      max-height: none;
      padding: 0;
    }

    .zyrox-shell.loose-mode .zyrox-panel {
      position: absolute;
      width: 212px;
      z-index: 3;
    }

    .zyrox-shell.loose-mode .zyrox-panel-header {
      cursor: move;
    }


    .zyrox-brand { display: flex; align-items: center; gap: 10px; color: var(--zyx-text-strong); }

    .zyrox-logo {
      width: 30px;
      height: 30px;
      border-radius: 6px;
      object-fit: contain;
      box-shadow: 0 0 0 1px rgba(255,255,255,.25), 0 0 18px rgba(255,61,61,.45);
      outline: 1px solid var(--zyx-icon-color);
    }

    .zyrox-brand .title { font-size: 13px; font-weight: 700; line-height: 1; }
    .zyrox-brand .subtitle { font-size: 11px; font-weight: 500; color: rgba(255,255,255,.7); }

    .zyrox-chip {
      font-size: 10px;
      color: var(--zyx-settings-text);
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--zyx-outline-color);
      border-radius: 999px;
      padding: 4px 8px;
      line-height: 1;
    }

    .zyrox-keybind-btn {
      font-size: 11px;
      color: var(--zyx-icon-color);
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--zyx-outline-color);
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
      color: var(--zyx-icon-color);
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--zyx-outline-color);
      border-radius: 8px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
    }

    .zyrox-search {
      width: 190px;
      height: 28px;
      border-radius: 8px;
      border: 1px solid var(--zyx-outline-color);
      background: rgba(10, 8, 8, 0.72);
      color: var(--zyx-search-text);
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
      color: var(--zyx-accent-soft);
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

    /* FIX: was hardcoded rgba(255, 61, 61, 0.3) — now follows theme */
    .zyrox-panels::-webkit-scrollbar { width: 8px; height: 8px; }
    .zyrox-panels::-webkit-scrollbar-thumb { background: var(--zyx-btn-hover-bg); border-radius: 999px; }

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
      color: var(--zyx-header-text);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: linear-gradient(90deg, var(--zyx-header-bg-start), var(--zyx-header-bg-end));
    }

    .zyrox-panel-collapse-btn {
      font-size: 10px;
      color: var(--zyx-panel-count-text);
      background: var(--zyx-panel-count-bg);
      border: 1px solid var(--zyx-panel-count-border);
      border-radius: 999px;
      padding: 3px 7px;
      line-height: 1;
      cursor: pointer;
    }

    .zyrox-panel-collapse-btn.collapsed {
      opacity: 0.62;
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
      background: var(--zyx-module-hover-bg);
      border-color: var(--zyx-module-hover-border);
      color: var(--zyx-settings-text);
      transform: translateX(var(--zyx-hover-shift));
    }

    .zyrox-module.active {
      color: #fff;
      background: linear-gradient(90deg, var(--zyx-module-active-start), var(--zyx-module-active-end));
      border-color: var(--zyx-module-active-border);
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
      border: 1px solid var(--zyx-border);
      background: linear-gradient(180deg, rgba(18, 18, 22, 0.97), rgba(8, 8, 10, 0.97));
      box-shadow: var(--zyx-shadow);
      overflow: hidden;
    }

    .zyrox-config.hidden { display: none !important; }
    /* FIX: config header now uses settings-header vars so it follows the theme */
    .zyrox-config-header { padding: 11px 13px; border-bottom: 1px solid rgba(255,255,255,.09); background: linear-gradient(90deg, var(--zyx-settings-header-start), var(--zyx-settings-header-end)); }
    .zyrox-config-title { color: var(--zyx-settings-text); font-size: 14px; font-weight: 700; margin-bottom: 3px; }
    .zyrox-config-sub { color: var(--zyx-settings-subtext); font-size: 12px; }
    .zyrox-config-body { padding: 13px; }
    .zyrox-config-row { display:flex; justify-content:space-between; align-items:center; gap:8px; color:var(--zyx-settings-text); font-size:14px; }
    .zyrox-config-actions { display: flex; align-items: center; gap: 6px; }

    /* FIX: was hardcoded rgba(255, 61, 61, ...) — now reads CSS variables set by applyAppearance() */
    .zyrox-btn {
      border: 1px solid var(--zyx-outline-color);
      background: var(--zyx-btn-bg);
      color: var(--zyx-settings-text);
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 12px;
      cursor: pointer;
    }

    .zyrox-btn:hover { background: var(--zyx-btn-hover-bg); color: #fff; }

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
      color: var(--zyx-icon-color);
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
      width: min(760px, 92vw);
      height: min(620px, 88vh);
      border-radius: 12px;
      border: 1px solid var(--zyx-border);
      background: var(--zyx-settings-body-bg);
      box-shadow: var(--zyx-shadow);
      overflow: hidden;
      color: #fff;
    }

    .zyrox-settings.hidden { display: none !important; }
    .zyrox-settings-header { padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,.09); background: linear-gradient(90deg, var(--zyx-settings-header-start), var(--zyx-settings-header-end)); }
    .zyrox-settings-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; color: var(--zyx-settings-text); }
    .zyrox-settings-sub { font-size: 12px; color: var(--zyx-settings-subtext); }
    .zyrox-settings-layout { display: grid; grid-template-columns: 150px 1fr; min-height: 0; height: 500px; }
    .zyrox-settings-sidebar {
      border-right: 1px solid rgba(255,255,255,.08);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--zyx-settings-sidebar-bg);
    }
    .zyrox-settings-tab {
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px;
      padding: 7px 8px;
      font-size: 12px;
      color: var(--zyx-settings-text);
      background: rgba(0,0,0,.2);
      text-align: left;
      cursor: pointer;
    }
    .zyrox-settings-tab.active {
      border-color: var(--zyx-outline-color);
      background: color-mix(in srgb, var(--zyx-topbar-bg-start) 75%, transparent);
      color: #fff;
    }
    .zyrox-settings-pane { min-height: 0; display: flex; }
    .zyrox-settings-body { padding: 14px; display: flex; flex-direction: column; gap: 8px; overflow: auto; min-height: 0; width: 100%; }
    .zyrox-settings-body::-webkit-scrollbar { width: 10px; }
    .zyrox-settings-body::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--zyx-outline-color) 70%, transparent); border-radius: 999px; }
    .zyrox-settings-pane.hidden { display: none !important; }
    .zyrox-setting-card { border: 1px solid var(--zyx-settings-card-border); border-radius: 10px; padding: 8px 10px; background: var(--zyx-settings-card-bg); display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .zyrox-setting-card label { display:block; font-size: 12px; color: var(--zyx-settings-text); margin: 0; }
    .zyrox-setting-card input[type='color'] {
      width: 52px;
      height: 30px;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 8px;
      background: transparent;
      cursor: pointer;
      overflow: hidden;
      padding: 0;
    }
    .zyrox-setting-card input[type='range'] { width: 190px; accent-color: var(--zyx-slider-color); }
    .zyrox-setting-card input[type='checkbox'] { width: 16px; height: 16px; accent-color: var(--zyx-checkmark-color); }
    .zyrox-gradient-pair { display: inline-flex; align-items: center; gap: 8px; }
    .zyrox-preset-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 2px; }
    .zyrox-preset-btn { border: 1px solid var(--zyx-outline-color); background: rgba(0,0,0,.26); color: var(--zyx-settings-text); border-radius: 8px; padding: 6px 10px; font-size: 11px; cursor: pointer; }
    .zyrox-preset-btn:hover { background: var(--zyx-btn-hover-bg); }
    .zyrox-subheading {
      grid-column: 1 / -1;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.25px;
      color: var(--zyx-accent-soft);
      margin-top: -2px;
      margin-bottom: -4px;
    }
    .zyrox-about-content {
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 12px;
      color: var(--zyx-settings-subtext);
      line-height: 1.45;
      user-select: text;
    }
    .zyrox-about-content b {
      color: var(--zyx-settings-text);
      font-weight: 700;
    }
    .zyrox-about-source-btn {
      align-self: flex-start;
      text-decoration: none;
      margin-top: 4px;
    }
    .zyrox-settings-actions { display:flex; justify-content:space-between; gap:8px; padding: 0 14px 14px; }
    .zyrox-settings-actions-group { display:flex; gap:8px; }
    .zyrox-close-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      border: 1px solid var(--zyx-outline-color);
      background: rgba(0, 0, 0, 0.25);
      color: var(--zyx-icon-color);
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
      <img class="zyrox-logo" src="${CONFIG.logoUrl}" alt="Zyrox logo" />
      <div>
        <div class="title">${CONFIG.title}</div>
        <div class="subtitle">${CONFIG.subtitle}</div>
      </div>
    </div>
    <div class="zyrox-collapse-row"></div>
    <div class="zyrox-topbar-right">
      <input class="zyrox-search" type="text" placeholder="Search utilities..." autocomplete="off" />
      <button class="zyrox-settings-btn" type="button" title="Open client settings">⚙</button>
      <span class="zyrox-chip">v${CONFIG.version}</span>
    </div>
  `;

  const searchInput = topbar.querySelector(".zyrox-search");
  const settingsBtn = topbar.querySelector(".zyrox-settings-btn");
  const collapseRow = topbar.querySelector(".zyrox-collapse-row");

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
    <div class="zyrox-settings-layout">
      <div class="zyrox-settings-sidebar">
        <button class="zyrox-settings-tab active" type="button" data-tab="controls">Controls</button>
        <button class="zyrox-settings-tab" type="button" data-tab="theme">Theme</button>
        <button class="zyrox-settings-tab" type="button" data-tab="appearance">Appearance</button>
        <button class="zyrox-settings-tab" type="button" data-tab="about">About</button>
      </div>
      <div class="zyrox-settings-pane" data-pane="controls">
        <div class="zyrox-settings-body">
          <div class="zyrox-subheading">Menu</div>
          <div class="zyrox-setting-card">
            <label>Menu Toggle Key</label>
            <button class="zyrox-keybind-btn settings-menu-key" type="button">Menu Key: ${CONFIG.toggleKey}</button>
            <button class="zyrox-btn zyrox-btn-square settings-menu-key-reset" type="button" title="Reset menu key">↺</button>
          </div>
          <div class="zyrox-subheading">Search</div>
          <div class="zyrox-setting-card">
            <label>Auto Focus Search</label>
            <input type="checkbox" class="set-search-autofocus" checked />
          </div>
        </div>
      </div>
      <div class="zyrox-settings-pane hidden" data-pane="theme">
        <div class="zyrox-settings-body">
          <div class="zyrox-preset-row">
            <button type="button" class="zyrox-preset-btn" data-preset="default">Default</button>
            <button type="button" class="zyrox-preset-btn" data-preset="green">Green</button>
            <button type="button" class="zyrox-preset-btn" data-preset="ice">Ice</button>
            <button type="button" class="zyrox-preset-btn" data-preset="grayscale">Greyscale</button>
          </div>
          <div class="zyrox-subheading">Main Window</div>
          <div class="zyrox-setting-card">
            <label>Accent Color</label>
            <input type="color" class="set-accent" value="#ff3d3d" />
          </div>
          <div class="zyrox-setting-card">
            <label>Background Gradient</label>
            <span class="zyrox-gradient-pair">
              <input type="color" class="set-shell-bg-start" value="#ff3d3d" />
              <input type="color" class="set-shell-bg-end" value="#000000" />
            </span>
          </div>
          <div class="zyrox-setting-card">
            <label>Top Bar Color</label>
            <input type="color" class="set-topbar-color" value="#ff4a4a" />
          </div>
          <div class="zyrox-setting-card">
            <label>Text Color</label>
            <input type="color" class="set-text" value="#d6d6df" />
          </div>
          <div class="zyrox-setting-card">
            <label>Panel Border</label>
            <input type="color" class="set-border" value="#ff6f6f" />
          </div>
          <div class="zyrox-setting-card">
            <label>Background Opacity</label>
            <input type="range" class="set-opacity" min="20" max="100" value="45" />
          </div>
          <div class="zyrox-subheading">Buttons & Inputs</div>
          <div class="zyrox-setting-card">
            <label>Outline Color</label>
            <input type="color" class="set-outline-color" value="#ff5b5b" />
          </div>
          <div class="zyrox-setting-card">
            <label>Slider Color</label>
            <input type="color" class="set-slider-color" value="#ff6b6b" />
          </div>
          <div class="zyrox-setting-card">
            <label>Checkmark Color</label>
            <input type="color" class="set-checkmark-color" value="#ff6b6b" />
          </div>
          <div class="zyrox-subheading">Typography</div>
          <div class="zyrox-setting-card">
            <label>Muted Text</label>
            <input type="color" class="set-muted-text" value="#9b9bab" />
          </div>
          <div class="zyrox-setting-card">
            <label>Label Accent</label>
            <input type="color" class="set-accent-soft" value="#ffbdbd" />
          </div>
          <div class="zyrox-setting-card">
            <label>Search Text</label>
            <input type="color" class="set-search-text" value="#ffe6e6" />
          </div>
          <div class="zyrox-subheading">Icons & Badges</div>
          <div class="zyrox-setting-card">
            <label>Icon Color</label>
            <input type="color" class="set-icon-color" value="#ffdada" />
          </div>
          <div class="zyrox-setting-card">
            <label>Panel Count Text</label>
            <input type="color" class="set-panel-count-text" value="#ffd9d9" />
          </div>
          <div class="zyrox-setting-card">
            <label>Panel Count Border</label>
            <input type="color" class="set-panel-count-border" value="#ff6464" />
          </div>
          <div class="zyrox-setting-card">
            <label>Panel Count Background</label>
            <input type="color" class="set-panel-count-bg" value="#08080a" />
          </div>
          <div class="zyrox-subheading">Panels & Modules</div>
          <div class="zyrox-setting-card">
            <label>Module Bar Gradient</label>
            <span class="zyrox-gradient-pair">
              <input type="color" class="set-header-start" value="#ff4a4a" />
              <input type="color" class="set-header-end" value="#3c1212" />
            </span>
          </div>
          <div class="zyrox-setting-card">
            <label>Module Bar Text</label>
            <input type="color" class="set-header-text" value="#ffffff" />
          </div>
          <div class="zyrox-subheading">Settings Menu</div>
          <div class="zyrox-setting-card">
            <label>Settings Header Gradient</label>
            <span class="zyrox-gradient-pair">
              <input type="color" class="set-settings-header-start" value="#ff3d3d" />
              <input type="color" class="set-settings-header-end" value="#2d0c0c" />
            </span>
          </div>
          <div class="zyrox-setting-card">
            <label>Settings Sidebar Tint</label>
            <input type="color" class="set-settings-sidebar" value="#181820" />
          </div>
          <div class="zyrox-setting-card">
            <label>Settings Body Tint</label>
            <input type="color" class="set-settings-body" value="#121216" />
          </div>
          <div class="zyrox-setting-card">
            <label>Settings Text Color</label>
            <input type="color" class="set-settings-text" value="#ffe5e5" />
          </div>
          <div class="zyrox-setting-card">
            <label>Settings Subtext Color</label>
            <input type="color" class="set-settings-subtext" value="#c2c2ce" />
          </div>
          <div class="zyrox-setting-card">
            <label>Settings Card Border</label>
            <input type="color" class="set-settings-card-border" value="#ffffff" />
          </div>
          <div class="zyrox-setting-card">
            <label>Settings Card Background</label>
            <input type="color" class="set-settings-card-bg" value="#ffffff" />
          </div>
        </div>
      </div>
      <div class="zyrox-settings-pane hidden" data-pane="appearance">
        <div class="zyrox-settings-body">
          <div class="zyrox-subheading">Layout</div>
          <div class="zyrox-setting-card">
            <label>Display Mode</label>
            <div class="zyrox-settings-actions-group">
              <button class="zyrox-btn set-display-mode active" data-display-mode="merged" type="button">Merged</button>
              <button class="zyrox-btn set-display-mode" data-display-mode="loose" type="button">Loose</button>
            </div>
          </div>
          <div class="zyrox-setting-card">
            <label>UI Scale</label>
            <input type="range" class="set-scale" min="80" max="130" value="100" />
          </div>
          <div class="zyrox-setting-card">
            <label>Corner Radius</label>
            <input type="range" class="set-radius" min="6" max="20" value="14" />
          </div>
          <div class="zyrox-setting-card">
            <label>Panel Blur</label>
            <input type="range" class="set-blur" min="0" max="16" value="10" />
          </div>
          <div class="zyrox-subheading">Motion</div>
          <div class="zyrox-setting-card">
            <label>Module Hover Shift</label>
            <input type="range" class="set-hover-shift" min="0" max="6" value="2" />
          </div>
        </div>
      </div>
      <div class="zyrox-settings-pane hidden" data-pane="about">
        <div class="zyrox-settings-body">
          <div class="zyrox-subheading">Client Info</div>
          <div class="zyrox-setting-card">
            <div class="zyrox-about-content">
              <div><b>Zyrox Client</b> is a custom opensource userscript hacked client for Gimkit with module toggles, keybinds, and theming controls.</div>
              <div>We are not responsible for any bans, account issues, data loss, or damages that may result from using this client. Use it at your own risk.</div>
              <div>Version: ${CONFIG.version}</div>
              <a
                class="zyrox-btn zyrox-about-source-btn"
                href="https://github.com/Bob-alt-828100/zyrox-gimkit-client"
                target="_blank"
                rel="noopener noreferrer"
              >View Source Code</a>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="zyrox-settings-actions">
      <div class="zyrox-settings-actions-group">
        <button class="zyrox-btn settings-reset" type="button">Reset Appearance</button>
      </div>
      <div class="zyrox-settings-actions-group">
        <button class="zyrox-btn settings-save" type="button">Save</button>
        <button class="zyrox-btn settings-close" type="button">Close</button>
      </div>
    </div>
  `;
  configBackdrop.appendChild(settingsMenu);

  const configTitleEl = configMenu.querySelector(".zyrox-config-title");
  const configSubEl = configMenu.querySelector(".zyrox-config-sub");
  const configCloseBtn = configMenu.querySelector(".config-close-btn");
  const settingsTabs = [...settingsMenu.querySelectorAll(".zyrox-settings-tab")];
  const settingsPanes = [...settingsMenu.querySelectorAll(".zyrox-settings-pane")];
  const resetBindBtn = configMenu.querySelector(".zyrox-btn-square");
  const setBindButtonEl = configMenu.querySelector(".zyrox-btn:not(.zyrox-btn-square)");
  const settingsMenuKeyBtn = settingsMenu.querySelector(".settings-menu-key");
  const settingsMenuKeyResetBtn = settingsMenu.querySelector(".settings-menu-key-reset");
  const settingsTopCloseBtn = settingsMenu.querySelector(".settings-close-top");
  const settingsSaveBtn = settingsMenu.querySelector(".settings-save");
  const presetButtons = [...settingsMenu.querySelectorAll(".zyrox-preset-btn")];
  const searchAutofocusInput = settingsMenu.querySelector(".set-search-autofocus");
  const accentInput = settingsMenu.querySelector(".set-accent");
  const shellBgStartInput = settingsMenu.querySelector(".set-shell-bg-start");
  const shellBgEndInput = settingsMenu.querySelector(".set-shell-bg-end");
  const topbarColorInput = settingsMenu.querySelector(".set-topbar-color");
  const iconColorInput = settingsMenu.querySelector(".set-icon-color");
  const outlineColorInput = settingsMenu.querySelector(".set-outline-color");
  const panelCountTextInput = settingsMenu.querySelector(".set-panel-count-text");
  const panelCountBorderInput = settingsMenu.querySelector(".set-panel-count-border");
  const panelCountBgInput = settingsMenu.querySelector(".set-panel-count-bg");
  const borderInput = settingsMenu.querySelector(".set-border");
  const textInput = settingsMenu.querySelector(".set-text");
  const opacityInput = settingsMenu.querySelector(".set-opacity");
  const sliderColorInput = settingsMenu.querySelector(".set-slider-color");
  const checkmarkColorInput = settingsMenu.querySelector(".set-checkmark-color");
  const mutedTextInput = settingsMenu.querySelector(".set-muted-text");
  const accentSoftInput = settingsMenu.querySelector(".set-accent-soft");
  const searchTextInput = settingsMenu.querySelector(".set-search-text");
  const headerStartInput = settingsMenu.querySelector(".set-header-start");
  const headerEndInput = settingsMenu.querySelector(".set-header-end");
  const headerTextInput = settingsMenu.querySelector(".set-header-text");
  const settingsHeaderStartInput = settingsMenu.querySelector(".set-settings-header-start");
  const settingsHeaderEndInput = settingsMenu.querySelector(".set-settings-header-end");
  const settingsSidebarInput = settingsMenu.querySelector(".set-settings-sidebar");
  const settingsBodyInput = settingsMenu.querySelector(".set-settings-body");
  const settingsTextInput = settingsMenu.querySelector(".set-settings-text");
  const settingsSubtextInput = settingsMenu.querySelector(".set-settings-subtext");
  const settingsCardBorderInput = settingsMenu.querySelector(".set-settings-card-border");
  const settingsCardBgInput = settingsMenu.querySelector(".set-settings-card-bg");
  const scaleInput = settingsMenu.querySelector(".set-scale");
  const radiusInput = settingsMenu.querySelector(".set-radius");
  const blurInput = settingsMenu.querySelector(".set-blur");
  const hoverShiftInput = settingsMenu.querySelector(".set-hover-shift");
  const displayModeButtons = [...settingsMenu.querySelectorAll(".set-display-mode")];
  const settingsResetBtn = settingsMenu.querySelector(".settings-reset");
  const settingsCloseBtn = settingsMenu.querySelector(".settings-close");
  const panelByName = new Map();
  const panelCollapseButtons = new Map();
  let openConfigModule = null;

  function setBindButtonText(text) {
    const bindButton = setBindButtonEl || configMenu.querySelector(".zyrox-btn:not(.zyrox-btn-square)");
    if (bindButton) bindButton.textContent = text;
  }

  function ensureModuleConfigStore() {
    if (state.moduleConfig instanceof Map) return state.moduleConfig;

    const recovered = new Map();
    if (state.moduleConfig && typeof state.moduleConfig === "object") {
      for (const [moduleName, cfg] of Object.entries(state.moduleConfig)) {
        if (cfg && typeof cfg === "object") {
          recovered.set(moduleName, { keybind: cfg.keybind || null });
        }
      }
    }
    state.moduleConfig = recovered;
    return state.moduleConfig;
  }

  function moduleCfg(name) {
    const store = ensureModuleConfigStore();
    if (!store.has(name)) {
      store.set(name, { keybind: null });
    }
    return store.get(name);
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
    setBindButtonText("Set keybind");
  }

  function openConfig(moduleName) {
    openConfigModule = moduleName;
    const cfg = moduleCfg(moduleName);

    configTitleEl.textContent = moduleName;
    configSubEl.textContent = cfg.keybind ? `Current bind: ${cfg.keybind}` : "No keybind assigned";
    setBindButtonText("Set keybind");

    configBackdrop.classList.remove("hidden");
    configMenu.classList.remove("hidden");
    settingsMenu.classList.add("hidden");
  }

  function openSettings() {
    configBackdrop.classList.remove("hidden");
    settingsMenu.classList.remove("hidden");
    configMenu.classList.add("hidden");
  }

  function collectSettings() {
    return {
      toggleKey: CONFIG.toggleKey,
      searchAutofocus: searchAutofocusInput.checked,
      accent: accentInput.value,
      shellBgStart: shellBgStartInput.value,
      shellBgEnd: shellBgEndInput.value,
      topbarColor: topbarColorInput.value,
      iconColor: iconColorInput.value,
      outlineColor: outlineColorInput.value,
      panelCountText: panelCountTextInput.value,
      panelCountBorder: panelCountBorderInput.value,
      panelCountBg: panelCountBgInput.value,
      border: borderInput.value,
      text: textInput.value,
      opacity: opacityInput.value,
      sliderColor: sliderColorInput.value,
      checkmarkColor: checkmarkColorInput.value,
      mutedText: mutedTextInput.value,
      accentSoft: accentSoftInput.value,
      searchText: searchTextInput.value,
      headerStart: headerStartInput.value,
      headerEnd: headerEndInput.value,
      headerText: headerTextInput.value,
      settingsHeaderStart: settingsHeaderStartInput.value,
      settingsHeaderEnd: settingsHeaderEndInput.value,
      settingsSidebar: settingsSidebarInput.value,
      settingsBody: settingsBodyInput.value,
      settingsText: settingsTextInput.value,
      settingsSubtext: settingsSubtextInput.value,
      settingsCardBorder: settingsCardBorderInput.value,
      settingsCardBg: settingsCardBgInput.value,
      scale: scaleInput.value,
      radius: radiusInput.value,
      blur: blurInput.value,
      hoverShift: hoverShiftInput.value,
      displayMode: state.displayMode,
      looseInitialized: state.looseInitialized,
      loosePositions: state.loosePositions,
      loosePanelPositions: state.loosePanelPositions,
      collapsedPanels: state.collapsedPanels,
    };
  }

  function setPanelCollapsed(panelName, collapsed) {
    const panel = panelByName.get(panelName);
    if (!panel) return;
    const list = panel.querySelector(".zyrox-module-list");
    if (!list) return;
    state.collapsedPanels[panelName] = collapsed;
    list.style.display = collapsed ? "none" : "";
    const button = panelCollapseButtons.get(panelName);
    if (button) {
      button.textContent = collapsed ? "▸" : "▾";
      button.title = collapsed ? "Expand category" : "Collapse category";
      button.setAttribute("aria-label", button.title);
      button.classList.toggle("collapsed", collapsed);
    }
  }

  function syncCollapseButtons() {
    for (const [panelName, button] of panelCollapseButtons.entries()) {
      const collapsed = !!state.collapsedPanels[panelName];
      button.textContent = collapsed ? "▸" : "▾";
      button.title = collapsed ? "Expand category" : "Collapse category";
      button.setAttribute("aria-label", button.title);
      button.classList.toggle("collapsed", collapsed);
    }
  }

  function clampToViewport(x, y, el) {
    const maxX = Math.max(0, window.innerWidth - el.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - el.offsetHeight);
    return {
      x: Math.max(0, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    };
  }

  function captureLoosePanelPositionsFromMerged() {
    const shellRect = shell.getBoundingClientRect();
    for (const [name, panel] of panelByName.entries()) {
      const rect = panel.getBoundingClientRect();
      state.loosePanelPositions[name] = {
        x: Math.round(rect.left - shellRect.left),
        y: Math.round(rect.top - shellRect.top),
      };
    }
  }

  function setDisplayMode(mode) {
    const nextMode = mode === "loose" ? "loose" : "merged";

    if (nextMode === "loose" && !state.looseInitialized) {
      // Capture while still in merged flow layout so the first loose layout mirrors merged positions.
      shell.classList.remove("loose-mode");
      captureLoosePanelPositionsFromMerged();
      state.looseInitialized = true;
    }

    state.displayMode = nextMode;
    shell.classList.toggle("loose-mode", state.displayMode === "loose");

    for (const btn of displayModeButtons) {
      btn.classList.toggle("active", btn.dataset.displayMode === state.displayMode);
    }

    if (state.displayMode === "loose") {
      state.mergedRootPosition = {
        left: parseInt(root.style.left || "20", 10),
        top: parseInt(root.style.top || "28", 10),
      };
      root.style.left = "0px";
      root.style.top = "0px";

      const clampedTopbar = clampToViewport(state.loosePositions.topbar.x, state.loosePositions.topbar.y, topbar);
      state.loosePositions.topbar = clampedTopbar;
      topbar.style.left = `${clampedTopbar.x}px`;
      topbar.style.top = `${clampedTopbar.y}px`;

      for (const [name, panel] of panelByName.entries()) {
        const pos = state.loosePanelPositions[name] || { x: 0, y: 0 };
        const clamped = clampToViewport(pos.x, pos.y, panel);
        state.loosePanelPositions[name] = clamped;
        panel.style.left = `${clamped.x}px`;
        panel.style.top = `${clamped.y}px`;
      }
    } else {
      root.style.left = `${state.mergedRootPosition.left}px`;
      root.style.top = `${state.mergedRootPosition.top}px`;
      topbar.style.left = "";
      topbar.style.top = "";
      for (const panel of panelByName.values()) {
        panel.style.left = "";
        panel.style.top = "";
      }
      shell.style.width = `${state.shellWidth}px`;
      shell.style.height = `${state.shellHeight}px`;
    }
  }

  function applyPreset(presetName) {
    const preset = (() => {
      if (presetName === "green") {
        return {
          accent: "#2dff75", shellStart: "#2dff75", shellEnd: "#03130a", topbar: "#35d96d", border: "#5dff9a",
          outline: "#37d878", text: "#d7ffe6", muted: "#88b79b", soft: "#a8ffd0", search: "#e6fff0", icon: "#d7ffe9",
          panelText: "#d9ffe8", panelBorder: "#5fff99", panelBg: "#04110a", slider: "#2dff75", checkmark: "#2dff75",
          headerStart: "#2dff75", headerEnd: "#0f2f1b", headerText: "#f0fff4",
          settingsHeaderStart: "#2dff75", settingsHeaderEnd: "#0f2f1b",
        };
      }
      if (presetName === "ice") {
        return {
          accent: "#6cd8ff", shellStart: "#6cd8ff", shellEnd: "#07131a", topbar: "#58bff1", border: "#8ae4ff",
          outline: "#6fbce8", text: "#d7edff", muted: "#8ea7bd", soft: "#b8e5ff", search: "#e7f5ff", icon: "#dff3ff",
          panelText: "#e1f4ff", panelBorder: "#8fd7ff", panelBg: "#071019", slider: "#7bdfff", checkmark: "#7bdfff",
          headerStart: "#6cd8ff", headerEnd: "#133042", headerText: "#f4fbff",
          settingsHeaderStart: "#6cd8ff", settingsHeaderEnd: "#133042",
        };
      }
      if (presetName === "grayscale") {
        return {
          accent: "#d3d3d3", shellStart: "#7a7a7a", shellEnd: "#0a0a0a", topbar: "#8d8d8d", border: "#b1b1b1",
          outline: "#9a9a9a", text: "#dddddd", muted: "#9a9a9a", soft: "#c9c9c9", search: "#f1f1f1", icon: "#f5f5f5",
          panelText: "#efefef", panelBorder: "#a0a0a0", panelBg: "#0f0f0f", slider: "#c4c4c4", checkmark: "#d0d0d0",
          headerStart: "#8f8f8f", headerEnd: "#1d1d1d", headerText: "#ffffff",
          settingsHeaderStart: "#8f8f8f", settingsHeaderEnd: "#1d1d1d",
        };
      }
      // Default (red)
      return {
        accent: "#ff3d3d", shellStart: "#ff3d3d", shellEnd: "#000000", topbar: "#ff4a4a", border: "#ff6f6f",
        outline: "#ff5b5b", text: "#d6d6df", muted: "#9b9bab", soft: "#ffbdbd", search: "#ffe6e6", icon: "#ffdada",
        panelText: "#ffd9d9", panelBorder: "#ff6464", panelBg: "#08080a", slider: "#ff6b6b", checkmark: "#ff6b6b",
        headerStart: "#ff4a4a", headerEnd: "#3c1212", headerText: "#ffffff",
        settingsHeaderStart: "#ff3d3d", settingsHeaderEnd: "#2d0c0c",
      };
    })();

    accentInput.value = preset.accent;
    shellBgStartInput.value = preset.shellStart;
    shellBgEndInput.value = preset.shellEnd;
    topbarColorInput.value = preset.topbar;
    borderInput.value = preset.border;
    outlineColorInput.value = preset.outline;
    textInput.value = preset.text;
    mutedTextInput.value = preset.muted;
    accentSoftInput.value = preset.soft;
    searchTextInput.value = preset.search;
    iconColorInput.value = preset.icon;
    panelCountTextInput.value = preset.panelText;
    panelCountBorderInput.value = preset.panelBorder;
    panelCountBgInput.value = preset.panelBg;
    sliderColorInput.value = preset.slider;
    checkmarkColorInput.value = preset.checkmark;
    headerStartInput.value = preset.headerStart;
    headerEndInput.value = preset.headerEnd;
    headerTextInput.value = preset.headerText;
    settingsHeaderStartInput.value = preset.settingsHeaderStart;
    settingsHeaderEndInput.value = preset.settingsHeaderEnd;
    applyAppearance();
  }

  function applyAppearance() {
    const toRgba = (hex, alpha) => {
      const h = hex.replace("#", "");
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    const darken = (hex, factor) => {
      const h = hex.replace("#", "");
      const r = Math.max(0, Math.floor(parseInt(h.slice(0, 2), 16) * factor));
      const g = Math.max(0, Math.floor(parseInt(h.slice(2, 4), 16) * factor));
      const b = Math.max(0, Math.floor(parseInt(h.slice(4, 6), 16) * factor));
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    };

    const shellBgStart = shellBgStartInput.value;
    const shellBgEnd = shellBgEndInput.value;
    const topbarColor = topbarColorInput.value;
    const iconColor = iconColorInput.value;
    const outlineColor = outlineColorInput.value;
    const panelCountText = panelCountTextInput.value;
    const panelCountBorder = panelCountBorderInput.value;
    const panelCountBg = panelCountBgInput.value;
    const border = borderInput.value;
    const text = textInput.value;
    const opacity = Number(opacityInput.value) / 100;
    const sliderColor = sliderColorInput.value;
    const checkmarkColor = checkmarkColorInput.value;
    const mutedText = mutedTextInput.value;
    const accentSoft = accentSoftInput.value;
    const searchText = searchTextInput.value;
    const headerStart = headerStartInput.value;
    const headerEnd = headerEndInput.value;
    const headerText = headerTextInput.value;
    const settingsHeaderStart = settingsHeaderStartInput.value;
    const settingsHeaderEnd = settingsHeaderEndInput.value;
    const settingsSidebar = settingsSidebarInput.value;
    const settingsBody = settingsBodyInput.value;
    const settingsText = settingsTextInput.value;
    const settingsSubtext = settingsSubtextInput.value;
    const settingsCardBorder = settingsCardBorderInput.value;
    const settingsCardBg = settingsCardBgInput.value;
    const scale = Number(scaleInput.value) / 100;
    const radius = Number(radiusInput.value);
    const blur = Number(blurInput.value);
    const hoverShift = Number(hoverShiftInput.value);
    const cssRoot = document.documentElement.style;
    cssRoot.setProperty("--zyx-border", `${border}99`);
    cssRoot.setProperty("--zyx-text", text);
    cssRoot.setProperty("--zyx-muted", mutedText);
    cssRoot.setProperty("--zyx-accent-soft", accentSoft);
    cssRoot.setProperty("--zyx-search-text", searchText);
    cssRoot.setProperty("--zyx-topbar-bg-start", toRgba(topbarColor, 0.22));
    cssRoot.setProperty("--zyx-topbar-bg-end", toRgba(darken(topbarColor, 0.22), 0.9));
    cssRoot.setProperty("--zyx-module-hover-bg", toRgba(topbarColor, 0.16));
    cssRoot.setProperty("--zyx-module-hover-border", toRgba(topbarColor, 0.4));
    cssRoot.setProperty("--zyx-module-active-start", toRgba(headerStart, 0.35));
    cssRoot.setProperty("--zyx-module-active-end", toRgba(headerEnd, 0.82));
    cssRoot.setProperty("--zyx-module-active-border", toRgba(headerStart, 0.55));
    cssRoot.setProperty("--zyx-icon-color", iconColor);
    cssRoot.setProperty("--zyx-outline-color", `${outlineColor}cc`);
    cssRoot.setProperty("--zyx-panel-count-text", panelCountText);
    cssRoot.setProperty("--zyx-panel-count-border", toRgba(panelCountBorder, 0.45));
    cssRoot.setProperty("--zyx-panel-count-bg", toRgba(panelCountBg, 0.6));
    cssRoot.setProperty("--zyx-header-bg-start", toRgba(headerStart, 0.24));
    cssRoot.setProperty("--zyx-header-bg-end", toRgba(headerEnd, 0.92));
    cssRoot.setProperty("--zyx-header-text", headerText);
    cssRoot.setProperty("--zyx-settings-header-start", toRgba(settingsHeaderStart, 0.3));
    cssRoot.setProperty("--zyx-settings-header-end", toRgba(settingsHeaderEnd, 0.95));
    cssRoot.setProperty("--zyx-settings-sidebar-bg", toRgba(settingsSidebar, 0.22));
    cssRoot.setProperty("--zyx-settings-body-bg", `linear-gradient(180deg, ${toRgba(settingsBody, 0.97)}, rgba(8, 8, 10, 0.97))`);
    cssRoot.setProperty("--zyx-settings-text", settingsText);
    cssRoot.setProperty("--zyx-settings-subtext", settingsSubtext);
    cssRoot.setProperty("--zyx-settings-card-border", toRgba(settingsCardBorder, 0.18));
    cssRoot.setProperty("--zyx-settings-card-bg", toRgba(settingsCardBg, 0.05));
    cssRoot.setProperty("--zyx-slider-color", sliderColor);
    cssRoot.setProperty("--zyx-checkmark-color", checkmarkColor);
    cssRoot.setProperty("--zyx-radius-xl", `${radius}px`);
    cssRoot.setProperty("--zyx-radius-lg", `${Math.max(4, radius - 2)}px`);
    cssRoot.setProperty("--zyx-radius-md", `${Math.max(3, radius - 4)}px`);
    cssRoot.setProperty("--zyx-hover-shift", `${hoverShift}px`);
    shell.style.transform = `scale(${scale.toFixed(2)})`;
    shell.style.transformOrigin = "top left";
    shell.style.background = `linear-gradient(150deg, ${toRgba(shellBgStart, 0.22)}, ${toRgba(shellBgEnd, opacity.toFixed(2))})`;
    cssRoot.setProperty("--zyx-shell-blur", `${blur}px`);
    shell.style.backdropFilter = `blur(var(--zyx-shell-blur)) saturate(115%)`;

    // FIX: derive button accent background from outlineColor so buttons always match the theme
    cssRoot.setProperty("--zyx-btn-bg", toRgba(outlineColor, 0.12));
    cssRoot.setProperty("--zyx-btn-hover-bg", toRgba(outlineColor, 0.2));
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
    }
  }

  function buildPanel(name, modules) {
    const panel = document.createElement("section");
    panel.className = "zyrox-panel";
    panel.dataset.panelName = name;

    const header = document.createElement("header");
    header.className = "zyrox-panel-header";

    const title = document.createElement("span");
    title.textContent = name;

    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.className = "zyrox-panel-collapse-btn";
    collapseButton.textContent = "▾";
    collapseButton.title = "Collapse category";
    collapseButton.setAttribute("aria-label", "Collapse category");
    collapseButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const nextCollapsed = !state.collapsedPanels[name];
      setPanelCollapsed(name, nextCollapsed);
    });

    header.appendChild(title);
    header.appendChild(collapseButton);

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
    panelByName.set(name, panel);
    panelCollapseButtons.set(name, collapseButton);
    state.modulePanels.set(panel, { modules: [...modules] });
    return panel;
  }

  if (setBindButtonEl) {
    setBindButtonEl.addEventListener("click", () => {
      if (!openConfigModule) return;
      state.listeningForBind = openConfigModule;
      setBindButtonText("Press any key...");
    });
  }

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

  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset || "default"));
  });

  settingsBtn.addEventListener("click", () => {
    openSettings();
  });

  settingsTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      for (const t of settingsTabs) t.classList.toggle("active", t === tab);
      for (const pane of settingsPanes) pane.classList.toggle("hidden", pane.dataset.pane !== target);
    });
  });

  resetBindBtn.addEventListener("click", () => {
    if (!openConfigModule) return;
    const cfg = moduleCfg(openConfigModule);
    cfg.keybind = null;
    const item = state.moduleItems.get(openConfigModule);
    if (item) setBindLabel(item, openConfigModule);
    configSubEl.textContent = "No keybind assigned";
    state.listeningForBind = null;
    setBindButtonText("Set keybind");
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
  shellBgStartInput.addEventListener("input", applyAppearance);
  shellBgEndInput.addEventListener("input", applyAppearance);
  topbarColorInput.addEventListener("input", applyAppearance);
  iconColorInput.addEventListener("input", applyAppearance);
  outlineColorInput.addEventListener("input", applyAppearance);
  panelCountTextInput.addEventListener("input", applyAppearance);
  panelCountBorderInput.addEventListener("input", applyAppearance);
  panelCountBgInput.addEventListener("input", applyAppearance);
  borderInput.addEventListener("input", applyAppearance);
  textInput.addEventListener("input", applyAppearance);
  opacityInput.addEventListener("input", applyAppearance);
  sliderColorInput.addEventListener("input", applyAppearance);
  checkmarkColorInput.addEventListener("input", applyAppearance);
  mutedTextInput.addEventListener("input", applyAppearance);
  accentSoftInput.addEventListener("input", applyAppearance);
  searchTextInput.addEventListener("input", applyAppearance);
  headerStartInput.addEventListener("input", applyAppearance);
  headerEndInput.addEventListener("input", applyAppearance);
  headerTextInput.addEventListener("input", applyAppearance);
  settingsHeaderStartInput.addEventListener("input", applyAppearance);
  settingsHeaderEndInput.addEventListener("input", applyAppearance);
  settingsSidebarInput.addEventListener("input", applyAppearance);
  settingsBodyInput.addEventListener("input", applyAppearance);
  settingsTextInput.addEventListener("input", applyAppearance);
  settingsSubtextInput.addEventListener("input", applyAppearance);
  settingsCardBorderInput.addEventListener("input", applyAppearance);
  settingsCardBgInput.addEventListener("input", applyAppearance);
  scaleInput.addEventListener("input", applyAppearance);
  radiusInput.addEventListener("input", applyAppearance);
  blurInput.addEventListener("input", applyAppearance);
  hoverShiftInput.addEventListener("input", applyAppearance);
  displayModeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setDisplayMode(btn.dataset.displayMode || "merged"));
  });
  searchAutofocusInput.addEventListener("change", () => {
    state.searchAutofocus = searchAutofocusInput.checked;
  });

  settingsResetBtn.addEventListener("click", () => {
    accentInput.value = "#ff3d3d";
    shellBgStartInput.value = "#ff3d3d";
    shellBgEndInput.value = "#000000";
    topbarColorInput.value = "#ff4a4a";
    iconColorInput.value = "#ffdada";
    outlineColorInput.value = "#ff5b5b";
    panelCountTextInput.value = "#ffd9d9";
    panelCountBorderInput.value = "#ff6464";
    panelCountBgInput.value = "#08080a";
    borderInput.value = "#ff6f6f";
    textInput.value = "#d6d6df";
    opacityInput.value = "45";
    sliderColorInput.value = "#ff6b6b";
    checkmarkColorInput.value = "#ff6b6b";
    mutedTextInput.value = "#9b9bab";
    accentSoftInput.value = "#ffbdbd";
    searchTextInput.value = "#ffe6e6";
    headerStartInput.value = "#ff4a4a";
    headerEndInput.value = "#3c1212";
    headerTextInput.value = "#ffffff";
    settingsHeaderStartInput.value = "#ff3d3d";
    settingsHeaderEndInput.value = "#2d0c0c";
    settingsSidebarInput.value = "#181820";
    settingsBodyInput.value = "#121216";
    settingsTextInput.value = "#ffe5e5";
    settingsSubtextInput.value = "#c2c2ce";
    settingsCardBorderInput.value = "#ffffff";
    settingsCardBgInput.value = "#ffffff";
    searchAutofocusInput.checked = true;
    state.searchAutofocus = true;
    scaleInput.value = "100";
    radiusInput.value = "14";
    blurInput.value = "10";
    hoverShiftInput.value = "2";
    state.looseInitialized = false;
    state.loosePositions = { topbar: { x: 12, y: 12 } };
    state.loosePanelPositions = {};
    state.collapsedPanels = {};
    for (const panelName of panelByName.keys()) {
      setPanelCollapsed(panelName, false);
    }
    syncCollapseButtons();
    setDisplayMode("merged");
    const cssRoot = document.documentElement.style;
    cssRoot.removeProperty("--zyx-border");
    cssRoot.removeProperty("--zyx-text");
    cssRoot.removeProperty("--zyx-muted");
    cssRoot.removeProperty("--zyx-accent-soft");
    cssRoot.removeProperty("--zyx-search-text");
    cssRoot.removeProperty("--zyx-topbar-bg-start");
    cssRoot.removeProperty("--zyx-topbar-bg-end");
    cssRoot.removeProperty("--zyx-module-hover-bg");
    cssRoot.removeProperty("--zyx-module-hover-border");
    cssRoot.removeProperty("--zyx-module-active-start");
    cssRoot.removeProperty("--zyx-module-active-end");
    cssRoot.removeProperty("--zyx-module-active-border");
    cssRoot.removeProperty("--zyx-icon-color");
    cssRoot.removeProperty("--zyx-outline-color");
    cssRoot.removeProperty("--zyx-panel-count-text");
    cssRoot.removeProperty("--zyx-panel-count-border");
    cssRoot.removeProperty("--zyx-panel-count-bg");
    cssRoot.removeProperty("--zyx-header-bg-start");
    cssRoot.removeProperty("--zyx-header-bg-end");
    cssRoot.removeProperty("--zyx-header-text");
    cssRoot.removeProperty("--zyx-settings-header-start");
    cssRoot.removeProperty("--zyx-settings-header-end");
    cssRoot.removeProperty("--zyx-settings-sidebar-bg");
    cssRoot.removeProperty("--zyx-settings-body-bg");
    cssRoot.removeProperty("--zyx-settings-text");
    cssRoot.removeProperty("--zyx-settings-subtext");
    cssRoot.removeProperty("--zyx-settings-card-border");
    cssRoot.removeProperty("--zyx-settings-card-bg");
    cssRoot.removeProperty("--zyx-slider-color");
    cssRoot.removeProperty("--zyx-checkmark-color");
    cssRoot.removeProperty("--zyx-radius-xl");
    cssRoot.removeProperty("--zyx-radius-lg");
    cssRoot.removeProperty("--zyx-radius-md");
    cssRoot.removeProperty("--zyx-hover-shift");
    cssRoot.removeProperty("--zyx-shell-blur");
    cssRoot.removeProperty("--zyx-btn-bg");
    cssRoot.removeProperty("--zyx-btn-hover-bg");
    shell.style.background = "";
    shell.style.transform = "";
    shell.style.backdropFilter = "";
  });

  settingsSaveBtn.addEventListener("click", () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collectSettings()));
      settingsSaveBtn.textContent = "Saved";
      setTimeout(() => {
        settingsSaveBtn.textContent = "Save";
      }, 850);
    } catch (_) {
      settingsSaveBtn.textContent = "Save failed";
      setTimeout(() => {
        settingsSaveBtn.textContent = "Save";
      }, 1200);
    }
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

  for (const [panelName] of panelByName.entries()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zyrox-collapse-btn";
    btn.textContent = panelName;
    btn.addEventListener("click", () => {
      const nextCollapsed = !state.collapsedPanels[panelName];
      setPanelCollapsed(panelName, nextCollapsed);
      btn.classList.toggle("inactive", nextCollapsed);
    });
    collapseRow.appendChild(btn);
  }

  shell.appendChild(topbar);
  shell.appendChild(generalSection);
  shell.appendChild(gamemodeSection);
  shell.appendChild(footer);
  shell.appendChild(resizeHandle);

  root.appendChild(shell);

  document.head.appendChild(style);
  document.body.appendChild(root);
  document.body.appendChild(configBackdrop);

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === "object") {
        if (saved.toggleKey) CONFIG.toggleKey = saved.toggleKey;
        if (typeof saved.searchAutofocus === "boolean") {
          state.searchAutofocus = saved.searchAutofocus;
          searchAutofocusInput.checked = saved.searchAutofocus;
        }
        const assign = (input, key) => {
          if (saved[key] !== undefined && input) input.value = String(saved[key]);
        };
        assign(accentInput, "accent");
        assign(shellBgStartInput, "shellBgStart");
        assign(shellBgEndInput, "shellBgEnd");
        assign(topbarColorInput, "topbarColor");
        assign(iconColorInput, "iconColor");
        assign(outlineColorInput, "outlineColor");
        assign(panelCountTextInput, "panelCountText");
        assign(panelCountBorderInput, "panelCountBorder");
        assign(panelCountBgInput, "panelCountBg");
        assign(borderInput, "border");
        assign(textInput, "text");
        assign(opacityInput, "opacity");
        assign(sliderColorInput, "sliderColor");
        assign(checkmarkColorInput, "checkmarkColor");
        assign(mutedTextInput, "mutedText");
        assign(accentSoftInput, "accentSoft");
        assign(searchTextInput, "searchText");
        assign(headerStartInput, "headerStart");
        assign(headerEndInput, "headerEnd");
        assign(headerTextInput, "headerText");
        assign(settingsHeaderStartInput, "settingsHeaderStart");
        assign(settingsHeaderEndInput, "settingsHeaderEnd");
        assign(settingsSidebarInput, "settingsSidebar");
        assign(settingsBodyInput, "settingsBody");
        assign(settingsTextInput, "settingsText");
        assign(settingsSubtextInput, "settingsSubtext");
        assign(settingsCardBorderInput, "settingsCardBorder");
        assign(settingsCardBgInput, "settingsCardBg");
        assign(scaleInput, "scale");
        assign(radiusInput, "radius");
        assign(blurInput, "blur");
        assign(hoverShiftInput, "hoverShift");
        if (saved.displayMode) state.displayMode = saved.displayMode === "loose" ? "loose" : "merged";
        if (typeof saved.looseInitialized === "boolean") state.looseInitialized = saved.looseInitialized;
        if (saved.loosePositions && typeof saved.loosePositions === "object") {
          state.loosePositions = {
            topbar: saved.loosePositions.topbar || state.loosePositions.topbar,
          };
        }
        if (saved.loosePanelPositions && typeof saved.loosePanelPositions === "object") {
          state.loosePanelPositions = saved.loosePanelPositions;
        }
        if (saved.collapsedPanels && typeof saved.collapsedPanels === "object") {
          state.collapsedPanels = saved.collapsedPanels;
        }
        settingsMenuKeyBtn.textContent = `Menu Key: ${CONFIG.toggleKey}`;
        footer.innerHTML = `<span>Press <b>${CONFIG.toggleKey}</b> to show/hide menu</span><span>Right click modules for settings</span>`;
      }
    }
  } catch (_) {}
  for (const panelName of panelByName.keys()) {
    setPanelCollapsed(panelName, !!state.collapsedPanels[panelName]);
  }
  syncCollapseButtons();
  applyAppearance();
  setDisplayMode(state.displayMode);

  function setVisible(nextVisible) {
    state.visible = nextVisible;
    root.classList.toggle("zyrox-hidden", !nextVisible);
    if (!nextVisible) closeConfig();
    if (nextVisible && state.searchAutofocus) {
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
    if (event.key === "Escape") {
      if (!configBackdrop.classList.contains("hidden")) {
        event.preventDefault();
        closeConfig();
        return;
      }
    }

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
      setBindButtonText("Set keybind");
      state.listeningForBind = null;
      return;
    }

    if (event.key === CONFIG.toggleKey) {
      event.preventDefault();
      setVisible(!state.visible);
      return;
    }

    for (const [moduleName, cfg] of ensureModuleConfigStore()) {
      if (cfg.keybind && cfg.keybind === event.key) {
        toggleModule(moduleName);
      }
    }
  });

  // Intentionally no backdrop click-to-close; menus close only via explicit close buttons.

  let dragState = null;
  let resizeState = null;

  const panelDragState = { panelName: null, offsetX: 0, offsetY: 0 };

  topbar.addEventListener("mousedown", (event) => {
    const interactiveTarget = event.target instanceof Element
      ? event.target.closest("input, button")
      : null;
    if (interactiveTarget) return;

    const rootBox = root.getBoundingClientRect();
    if (state.displayMode === "loose") {
      const box = topbar.getBoundingClientRect();
      dragState = {
        mode: "topbar",
        offsetX: event.clientX - box.left,
        offsetY: event.clientY - box.top,
      };
    } else {
      dragState = {
        mode: "root",
        offsetX: event.clientX - rootBox.left,
        offsetY: event.clientY - rootBox.top,
      };
    }
    event.preventDefault();
  });

  panelByName.forEach((panel, panelName) => {
    const header = panel.querySelector(".zyrox-panel-header");
    header.addEventListener("mousedown", (event) => {
      if (state.displayMode !== "loose") return;
      const box = panel.getBoundingClientRect();
      panelDragState.panelName = panelName;
      panelDragState.offsetX = event.clientX - box.left;
      panelDragState.offsetY = event.clientY - box.top;
      event.preventDefault();
      event.stopPropagation();
    });
  });

  document.addEventListener("mousemove", (event) => {
    if (dragState?.mode === "root") {
      const nextX = Math.max(0, event.clientX - dragState.offsetX);
      const nextY = Math.max(0, event.clientY - dragState.offsetY);
      root.style.left = `${nextX}px`;
      root.style.top = `${nextY}px`;
    }

    if (dragState?.mode === "topbar") {
      const clamped = clampToViewport(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY, topbar);
      state.loosePositions.topbar = clamped;
      topbar.style.left = `${clamped.x}px`;
      topbar.style.top = `${clamped.y}px`;
    }

    if (panelDragState.panelName) {
      const panel = panelByName.get(panelDragState.panelName);
      if (panel) {
        const clamped = clampToViewport(event.clientX - panelDragState.offsetX, event.clientY - panelDragState.offsetY, panel);
        state.loosePanelPositions[panelDragState.panelName] = clamped;
        panel.style.left = `${clamped.x}px`;
        panel.style.top = `${clamped.y}px`;
      }
    }
  });

  document.addEventListener("mouseup", () => {
    dragState = null;
    resizeState = null;
    panelDragState.panelName = null;
  });

  resizeHandle.addEventListener("mousedown", (event) => {
    if (state.displayMode === "loose") return;
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
    if (!resizeState || state.displayMode === "loose") return;

    const width = Math.max(760, resizeState.startWidth + (event.clientX - resizeState.startX));
    const height = Math.max(420, resizeState.startHeight + (event.clientY - resizeState.startY));
    state.shellWidth = width;
    state.shellHeight = height;
    shell.style.width = `${width}px`;
    shell.style.height = `${height}px`;
  });
})();
