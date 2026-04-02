// ==UserScript==
// @name         Zyrox Client (UI Base)
// @namespace    https://github.com/zyrox
// @version      0.4.0
// @description  Modern UI/menu shell for Zyrox client
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  if (window.__ZYROX_UI_MOUNTED__) return;
  window.__ZYROX_UI_MOUNTED__ = true;

  const CONFIG = {
    toggleKey: "\\",
    title: "Zyrox",
    subtitle: "Client",
  };

  const MENU_LAYOUT = {
    general: {
      title: "General",
      modules: [
        "Auto Answer",
        "Answer Streak",
        "ESP",
        "Question Preview",
        "Skip Animation",
        "Instant Continue",
        "HUD",
        "Notifications",
        "Session Timer",
        "Hotkeys",
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
    enabledModules: new Set(),
    moduleItems: new Map(),
    moduleConfig: new Map(),
    listeningForBind: null,
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
      display: inline-flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px;
      border-radius: var(--zyx-radius-xl);
      border: 1px solid var(--zyx-border-soft);
      background: linear-gradient(150deg, rgba(255, 54, 54, 0.08), rgba(0, 0, 0, 0.45));
      backdrop-filter: blur(10px) saturate(115%);
      box-shadow: var(--zyx-shadow);
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
      gap: 8px;
      align-items: flex-start;
      overflow-x: auto;
      max-width: min(96vw, 1530px);
      padding-bottom: 2px;
    }

    .zyrox-panels::-webkit-scrollbar { height: 8px; }
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
      position: fixed;
      z-index: 2147483647;
      min-width: 220px;
      border-radius: 11px;
      border: 1px solid rgba(255, 79, 79, 0.45);
      background: linear-gradient(180deg, rgba(18, 18, 22, 0.97), rgba(8, 8, 10, 0.97));
      box-shadow: var(--zyx-shadow);
      overflow: hidden;
    }

    .zyrox-config.hidden { display: none !important; }
    .zyrox-config-header { padding: 9px 11px; border-bottom: 1px solid rgba(255,255,255,.09); background: linear-gradient(90deg, rgba(255, 61, 61, .23), rgba(45, 12, 12, .95)); }
    .zyrox-config-title { color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 2px; }
    .zyrox-config-sub { color: #b8b8c2; font-size: 10px; }
    .zyrox-config-body { padding: 10px; }
    .zyrox-config-row { display:flex; justify-content:space-between; align-items:center; gap:8px; color:#d8d8df; font-size:12px; }

    .zyrox-btn {
      border: 1px solid rgba(255, 94, 94, 0.5);
      background: rgba(255, 61, 61, 0.12);
      color: #ffdada;
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11px;
      cursor: pointer;
    }

    .zyrox-btn:hover { background: rgba(255, 61, 61, 0.2); color: #fff; }
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
    <span class="zyrox-chip">v0.4</span>
  `;

  const generalSection = document.createElement("section");
  generalSection.className = "zyrox-section";
  generalSection.innerHTML = `<div class="zyrox-section-label">General</div>`;

  const gamemodeSection = document.createElement("section");
  gamemodeSection.className = "zyrox-section";
  gamemodeSection.innerHTML = `<div class="zyrox-section-label">Gamemode Specific</div>`;

  const footer = document.createElement("div");
  footer.className = "zyrox-footer";
  footer.innerHTML = `<span>Press <b>${CONFIG.toggleKey}</b> to show/hide menu</span><span>Right click modules for settings</span>`;

  const configMenu = document.createElement("div");
  configMenu.className = "zyrox-config hidden";
  configMenu.innerHTML = `
    <div class="zyrox-config-header">
      <div class="zyrox-config-title">Module Config</div>
      <div class="zyrox-config-sub">Edit settings</div>
    </div>
    <div class="zyrox-config-body">
      <div class="zyrox-config-row">
        <span>Keybind</span>
        <button class="zyrox-btn" type="button">Set keybind</button>
      </div>
    </div>
  `;

  const configTitleEl = configMenu.querySelector(".zyrox-config-title");
  const configSubEl = configMenu.querySelector(".zyrox-config-sub");
  const setBindBtn = configMenu.querySelector(".zyrox-btn");
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
    configMenu.classList.add("hidden");
    openConfigModule = null;
    state.listeningForBind = null;
    setBindBtn.textContent = "Set keybind";
  }

  function openConfig(moduleName, x, y) {
    openConfigModule = moduleName;
    const cfg = moduleCfg(moduleName);

    configTitleEl.textContent = moduleName;
    configSubEl.textContent = cfg.keybind ? `Current bind: ${cfg.keybind}` : "No keybind assigned";
    setBindBtn.textContent = "Set keybind";

    configMenu.style.left = `${x}px`;
    configMenu.style.top = `${y}px`;
    configMenu.classList.remove("hidden");
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
      moduleCfg(moduleName);
      setBindLabel(item, moduleName);

      item.addEventListener("click", () => {
        toggleModule(moduleName);
      });

      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openConfig(moduleName, event.clientX + 6, event.clientY + 6);
      });

      list.appendChild(item);
    }

    panel.appendChild(header);
    panel.appendChild(list);
    return panel;
  }

  setBindBtn.addEventListener("click", () => {
    if (!openConfigModule) return;
    state.listeningForBind = openConfigModule;
    setBindBtn.textContent = "Press any key...";
  });

  const generalPanels = document.createElement("div");
  generalPanels.className = "zyrox-panels";
  generalPanels.appendChild(buildPanel(MENU_LAYOUT.general.title, MENU_LAYOUT.general.modules));
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

  root.appendChild(shell);

  document.head.appendChild(style);
  document.body.appendChild(root);
  document.body.appendChild(configMenu);

  function setVisible(nextVisible) {
    state.visible = nextVisible;
    root.classList.toggle("zyrox-hidden", !nextVisible);
    if (!nextVisible) closeConfig();
  }

  document.addEventListener("keydown", (event) => {
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
      setVisible(!state.visible);
      return;
    }

    for (const [moduleName, cfg] of state.moduleConfig) {
      if (cfg.keybind && cfg.keybind === event.key) {
        toggleModule(moduleName);
      }
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (!configMenu.classList.contains("hidden") && !configMenu.contains(event.target)) {
      closeConfig();
    }
  });

  let dragState = null;

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
  });
})();
