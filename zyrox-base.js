// ==UserScript==
// @name         Zyrox Client (UI Base)
// @namespace    https://github.com/zyrox
// @version      0.2.0
// @description  Modern UI/menu shell for Zyrox client (visual only, no utilities wired)
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
    subtitle: "Client UI Base",
  };

  // UI labels only; no functionality is implemented yet.
  const CATEGORIES = [
    {
      name: "Gameplay",
      modules: ["Auto Answer", "Answer Streak", "Question Preview", "Skip Animation", "Instant Continue"],
    },
    {
      name: "Economy",
      modules: ["Auto Purchase", "Priority Upgrades", "Shop Presets", "Auto Save Loadout", "Quick Sell"],
    },
    {
      name: "Automation",
      modules: ["Auto Ready", "Auto Requeue", "Auto Respawn", "Idle Prevention", "Smart Delay"],
    },
    {
      name: "Lobby",
      modules: ["Name Presets", "Join Shortcuts", "Party Helper", "Host Tools", "Code History"],
    },
    {
      name: "Visual",
      modules: ["HUD", "Overlay", "Theme", "Compact Cards", "Minimal Labels"],
    },
    {
      name: "QoL",
      modules: ["Hotkeys", "Notifications", "Session Timer", "Clipboard Tools", "Menu Lock"],
    },
    {
      name: "Profiles",
      modules: ["Config Slots", "Import Config", "Export Config", "Quick Reset", "Cloud Sync"],
    },
    {
      name: "Debug",
      modules: ["Event Log", "State Viewer", "Latency Meter"],
    },
  ];

  const state = {
    visible: true,
    enabledModules: new Set(),
  };

  const style = document.createElement("style");
  style.textContent = `
    :root {
      --zyx-bg: rgba(8, 10, 18, 0.72);
      --zyx-bg-strong: rgba(10, 13, 24, 0.92);
      --zyx-panel: rgba(18, 22, 36, 0.72);
      --zyx-panel-hover: rgba(25, 30, 48, 0.82);
      --zyx-border: rgba(255, 255, 255, 0.14);
      --zyx-text: #c7cfde;
      --zyx-text-strong: #f3f6ff;
      --zyx-muted: #8f9ab1;
      --zyx-accent: #7c5cff;
      --zyx-accent-2: #15d1ff;
      --zyx-shadow: 0 18px 50px rgba(5, 8, 15, 0.55);
      --zyx-radius-xl: 14px;
      --zyx-radius-lg: 12px;
      --zyx-radius-md: 9px;
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

    .zyrox-root * {
      box-sizing: border-box;
      font-family: inherit;
    }

    .zyrox-hidden {
      display: none !important;
    }

    .zyrox-shell {
      display: inline-flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px;
      border-radius: var(--zyx-radius-xl);
      background: linear-gradient(140deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.02));
      backdrop-filter: blur(8px) saturate(115%);
      border: 1px solid var(--zyx-border);
      box-shadow: var(--zyx-shadow);
    }

    .zyrox-topbar {
      min-height: 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      border-radius: var(--zyx-radius-lg);
      background: linear-gradient(110deg, rgba(124, 92, 255, 0.22), rgba(21, 209, 255, 0.18));
      border: 1px solid rgba(255, 255, 255, 0.16);
      cursor: move;
    }

    .zyrox-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--zyx-text-strong);
      letter-spacing: 0.2px;
    }

    .zyrox-logo {
      width: 18px;
      height: 18px;
      border-radius: 6px;
      background: radial-gradient(circle at 25% 25%, #9e87ff 0%, #7c5cff 55%, #6040ff 100%);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25), 0 0 22px rgba(124, 92, 255, 0.55);
    }

    .zyrox-brand .title {
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
    }

    .zyrox-brand .subtitle {
      font-size: 11px;
      font-weight: 500;
      color: rgba(243, 246, 255, 0.78);
    }

    .zyrox-chip {
      font-size: 10px;
      color: #eff6ff;
      background: rgba(10, 14, 28, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 99px;
      padding: 4px 8px;
      line-height: 1;
    }

    .zyrox-panels {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      overflow-x: auto;
      max-width: min(96vw, 1530px);
      padding-bottom: 2px;
    }

    .zyrox-panels::-webkit-scrollbar {
      height: 8px;
    }

    .zyrox-panels::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 999px;
    }

    .zyrox-panel {
      width: 210px;
      border-radius: var(--zyx-radius-lg);
      border: 1px solid var(--zyx-border);
      background: linear-gradient(180deg, rgba(20, 25, 39, 0.8), rgba(10, 13, 23, 0.78));
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
      background: linear-gradient(90deg, rgba(124, 92, 255, 0.2), rgba(21, 209, 255, 0.12));
    }

    .zyrox-panel-count {
      font-size: 10px;
      color: #dbe8ff;
      background: rgba(6, 10, 18, 0.48);
      border: 1px solid rgba(255, 255, 255, 0.17);
      border-radius: 999px;
      padding: 3px 7px;
      line-height: 1;
    }

    .zyrox-module-list {
      margin: 0;
      padding: 7px;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 5px;
      background: transparent;
    }

    .zyrox-module {
      min-height: 30px;
      display: flex;
      align-items: center;
      padding: 0 10px;
      font-size: 13px;
      font-weight: 500;
      color: var(--zyx-text);
      border: 1px solid transparent;
      border-radius: var(--zyx-radius-md);
      background: rgba(255, 255, 255, 0.02);
      transition: transform 0.11s ease, background 0.11s ease, border-color 0.11s ease, color 0.11s ease;
      cursor: pointer;
      white-space: nowrap;
    }

    .zyrox-module:hover {
      background: var(--zyx-panel-hover);
      border-color: rgba(255, 255, 255, 0.14);
      color: var(--zyx-text-strong);
      transform: translateX(2px);
    }

    .zyrox-module.active {
      color: #ffffff;
      background: linear-gradient(90deg, rgba(124, 92, 255, 0.34), rgba(21, 209, 255, 0.22));
      border-color: rgba(167, 195, 255, 0.35);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
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
    <span class="zyrox-chip">UI ONLY</span>
  `;

  const panelsWrap = document.createElement("div");
  panelsWrap.className = "zyrox-panels";

  const footer = document.createElement("div");
  footer.className = "zyrox-footer";
  footer.innerHTML = `
    <span>Press <b>${CONFIG.toggleKey}</b> to show/hide UI</span>
    <span>Left click toggles visual state only</span>
  `;

  for (const category of CATEGORIES) {
    const panel = document.createElement("section");
    panel.className = "zyrox-panel";

    const header = document.createElement("header");
    header.className = "zyrox-panel-header";

    const title = document.createElement("span");
    title.textContent = category.name;

    const count = document.createElement("span");
    count.className = "zyrox-panel-count";
    count.textContent = `${category.modules.length}`;

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

  shell.appendChild(topbar);
  shell.appendChild(panelsWrap);
  shell.appendChild(footer);

  root.appendChild(shell);

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
