// ==UserScript==
// @name         Zyrox Client (UI Base)
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Base click-GUI shell for Zyrox client (UI only, no utilities wired)
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
    title: "Zyrox Client",
    subtitle: "UI Base",
  };

  const CATEGORIES = [
    {
      name: "Combat",
      modules: ["Aura", "AutoCrystal", "Criticals", "Velocity", "TriggerBot"],
    },
    {
      name: "Exploits",
      modules: ["PacketControl", "FastUse", "NoDelay", "Disabler", "Phase"],
    },
    {
      name: "Movement",
      modules: ["Sprint", "Speed", "Fly", "NoSlow", "HighJump"],
    },
    {
      name: "Render",
      modules: ["ESP", "Tracers", "Waypoints", "NoWeather", "NameTags"],
    },
    {
      name: "World",
      modules: ["Scaffold", "FastPlace", "AutoMine", "NoInteract", "GhostHand"],
    },
    {
      name: "Misc",
      modules: ["AutoGG", "AutoRespawn", "Spammer", "MiddleClick", "Timer"],
    },
    {
      name: "Other",
      modules: ["ClickGUI", "Theme", "HUD", "Chat", "Profiles"],
    },
    {
      name: "Debug",
      modules: ["UptimeResolver"],
    },
  ];

  const state = {
    visible: true,
    enabledModules: new Set(),
  };

  const style = document.createElement("style");
  style.textContent = `
    :root {
      --zyx-bg: rgba(18, 18, 23, 0.96);
      --zyx-bg-soft: rgba(29, 29, 37, 0.92);
      --zyx-line: #d33;
      --zyx-text: #a9a9b2;
      --zyx-text-strong: #efefef;
      --zyx-accent: #ff3a3a;
      --zyx-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      --zyx-font: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
    }

    .zyrox-root {
      all: initial;
      font-family: var(--zyx-font);
      position: fixed;
      top: 28px;
      left: 20px;
      z-index: 2147483647;
      color: var(--zyx-text);
      user-select: none;
    }

    .zyrox-root * {
      box-sizing: border-box;
      font-family: inherit;
    }

    .zyrox-hidden {
      display: none !important;
    }

    .zyrox-topbar {
      height: 28px;
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--zyx-text-strong);
      background: linear-gradient(180deg, #3a1515 0%, #2c0f0f 100%);
      border: 1px solid var(--zyx-line);
      box-shadow: var(--zyx-shadow);
      width: fit-content;
      min-width: 260px;
      padding: 0 10px;
      margin-bottom: 8px;
      cursor: move;
    }

    .zyrox-topbar .dot {
      width: 8px;
      height: 8px;
      border-radius: 99px;
      background: var(--zyx-accent);
      box-shadow: 0 0 8px rgba(255, 58, 58, 0.7);
    }

    .zyrox-topbar .meta {
      font-size: 12px;
      opacity: 0.95;
      letter-spacing: 0.2px;
    }

    .zyrox-panels {
      display: flex;
      gap: 3px;
      align-items: flex-start;
    }

    .zyrox-panel {
      width: 185px;
      border: 1px solid var(--zyx-line);
      background: var(--zyx-bg);
      box-shadow: var(--zyx-shadow);
      overflow: hidden;
    }

    .zyrox-panel-header {
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 7px;
      font-size: 12px;
      background: linear-gradient(180deg, #bb3434 0%, #7a1e1e 100%);
      color: #fff;
      border-bottom: 1px solid rgba(0, 0, 0, 0.35);
    }

    .zyrox-panel-count {
      color: rgba(255, 255, 255, 0.9);
      font-size: 11px;
      border: 1px solid rgba(255, 255, 255, 0.45);
      padding: 0 4px;
      line-height: 14px;
      height: 15px;
      border-radius: 2px;
    }

    .zyrox-module-list {
      margin: 0;
      padding: 3px 0;
      list-style: none;
      background: var(--zyx-bg-soft);
    }

    .zyrox-module {
      height: 25px;
      display: flex;
      align-items: center;
      padding: 0 10px;
      font-size: 15px;
      line-height: 1;
      color: var(--zyx-text);
      transition: background 0.12s ease, color 0.12s ease;
      cursor: pointer;
    }

    .zyrox-module:hover {
      background: rgba(255, 70, 70, 0.09);
      color: var(--zyx-text-strong);
    }

    .zyrox-module.active {
      color: var(--zyx-accent);
      text-shadow: 0 0 8px rgba(255, 58, 58, 0.25);
    }

    .zyrox-hint {
      margin-top: 8px;
      color: #c3c3cb;
      font-size: 11px;
      opacity: 0.85;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.35);
      font-family: var(--zyx-font);
    }
  `;

  const root = document.createElement("div");
  root.className = "zyrox-root";

  const topbar = document.createElement("div");
  topbar.className = "zyrox-topbar";
  topbar.innerHTML = `
    <span class="dot"></span>
    <span class="meta">${CONFIG.title} • ${CONFIG.subtitle}</span>
  `;

  const panelsWrap = document.createElement("div");
  panelsWrap.className = "zyrox-panels";

  const hint = document.createElement("div");
  hint.className = "zyrox-hint";
  hint.textContent = `Press ${CONFIG.toggleKey} to show/hide UI • Left click toggles visual state only`;

  for (const category of CATEGORIES) {
    const panel = document.createElement("section");
    panel.className = "zyrox-panel";

    const header = document.createElement("header");
    header.className = "zyrox-panel-header";

    const title = document.createElement("span");
    title.textContent = category.name;

    const count = document.createElement("span");
    count.className = "zyrox-panel-count";
    count.textContent = `[${category.modules.length}]`;

    header.appendChild(title);
    header.appendChild(count);

    const list = document.createElement("ul");
    list.className = "zyrox-module-list";

    for (const moduleName of category.modules) {
      const item = document.createElement("li");
      item.className = "zyrox-module";
      item.textContent = moduleName;

      item.addEventListener("click", () => {
        if (state.enabledModules.has(moduleName)) {
          state.enabledModules.delete(moduleName);
          item.classList.remove("active");
        } else {
          state.enabledModules.add(moduleName);
          item.classList.add("active");
        }
      });

      list.appendChild(item);
    }

    panel.appendChild(header);
    panel.appendChild(list);
    panelsWrap.appendChild(panel);
  }

  root.appendChild(topbar);
  root.appendChild(panelsWrap);
  root.appendChild(hint);

  document.head.appendChild(style);
  document.body.appendChild(root);

  function setVisible(nextVisible) {
    state.visible = nextVisible;
    root.classList.toggle("zyrox-hidden", !nextVisible);
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === CONFIG.toggleKey) {
      setVisible(!state.visible);
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
