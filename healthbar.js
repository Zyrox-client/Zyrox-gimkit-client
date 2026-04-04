// ==UserScript==
// @name         Zyrox Healthbar Test (gimkit)
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Standalone healthbar overlay test for Gimkit players
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @match        https://www.gimkit.com/play*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const OVERLAY_Z = 10002;
  const TICK_MS = 1000 / 30;

  const state = {
    stores: null,
    storesPromise: null,
    canvas: null,
    ctx: null,
    warnedNoHealth: false,
    healthPath: null,
    maxHealthPath: null,
    noDataFrames: 0,
  };

  function readNumber(source, paths) {
    if (!source) return null;
    for (const path of paths) {
      const parts = path.split(".");
      let node = source;
      for (const part of parts) node = node?.[part];
      const value = Number(node);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function readByPath(source, path) {
    if (!source || !path) return null;
    let node = source;
    for (const part of path.split(".")) node = node?.[part];
    const value = Number(node);
    return Number.isFinite(value) ? value : null;
  }

  function discoverNumericPath(source, matcher, depthLimit = 4) {
    if (!source || typeof source !== "object") return null;
    const queue = [{ node: source, path: "", depth: 0 }];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      const node = current.node;
      if (!node || typeof node !== "object") continue;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        const nextPath = current.path ? `${current.path}.${key}` : key;
        if (matcher(key, value, nextPath)) {
          const n = Number(value);
          if (Number.isFinite(n)) return nextPath;
        }
        if (current.depth + 1 < depthLimit && value && typeof value === "object") {
          queue.push({ node: value, path: nextPath, depth: current.depth + 1 });
        }
      }
    }
    return null;
  }

  function getCharacterPosition(character) {
    const x = Number(character?.x ?? character?.position?.x ?? character?.body?.x);
    const y = Number(character?.y ?? character?.position?.y ?? character?.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function getCharacterEntries(stores) {
    const map = stores?.phaser?.scene?.characterManager?.characters;
    if (!map) return [];
    if (typeof map.entries === "function") return Array.from(map.entries(), ([id, character]) => ({ id, character }));
    if (Array.isArray(map)) return map.map((character, index) => ({ id: character?.id ?? index, character }));
    return Object.entries(map).map(([id, character]) => ({ id, character }));
  }

  function getMainCharacter(stores) {
    const map = stores?.phaser?.scene?.characterManager?.characters;
    const mainId = stores?.phaser?.mainCharacter?.id;
    if (!map) return null;
    if (mainId != null && typeof map.get === "function") return map.get(mainId) || null;
    for (const { character } of getCharacterEntries(stores)) {
      if (character?.id === mainId || character?.characterId === mainId) return character;
    }
    return null;
  }

  function getCharacterTeam(character) {
    return character?.teamId ?? character?.team?.id ?? character?.state?.teamId ?? null;
  }

  function getSerializerCharacterById(id) {
    if (id == null) return null;
    const map = window?.serializer?.state?.characters?.$items;
    if (!map || typeof map.get !== "function") return null;
    return map.get(id) || map.get(String(id)) || null;
  }

  function findSerializerCharacterByPosition(character) {
    const map = window?.serializer?.state?.characters?.$items;
    if (!map || typeof map.values !== "function") return null;
    const x = Number(character?.x ?? character?.position?.x);
    const y = Number(character?.y ?? character?.position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const candidate of map.values()) {
      const cx = Number(candidate?.x ?? candidate?.position?.x);
      const cy = Number(candidate?.y ?? candidate?.position?.y);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      if (Math.abs(cx - x) < 0.5 && Math.abs(cy - y) < 0.5) return candidate;
    }
    return null;
  }

  function getHealth(character, fallbackId) {
    const serializerCharacter = getSerializerCharacterById(character?.id ?? fallbackId) ?? findSerializerCharacterByPosition(character);
    const sources = [character, serializerCharacter];
    let hp = null;
    let maxHp = null;
    for (const source of sources) {
      if (!source) continue;
      if (hp == null) {
        hp = state.healthPath
          ? readByPath(source, state.healthPath)
          : readNumber(source, [
            "health", "hp", "currentHealth", "currentHp", "life", "lives",
            "state.health", "state.hp", "state.currentHealth", "state.life",
            "stats.health", "stats.hp", "data.health", "data.hp",
          ]);
      }
      if (maxHp == null) {
        maxHp = state.maxHealthPath
          ? readByPath(source, state.maxHealthPath)
          : readNumber(source, [
            "maxHealth", "maxHp", "healthMax", "maxLife",
            "state.maxHealth", "state.maxHp", "state.healthMax",
            "stats.maxHealth", "stats.maxHp", "data.maxHealth",
          ]);
      }
      if (hp == null && !state.healthPath) {
        const path = discoverNumericPath(source, (key, value) => {
          const k = key.toLowerCase();
          if (!/(health|hp|life)/.test(k)) return false;
          const n = Number(value);
          return Number.isFinite(n) && n >= 0 && n <= 10000;
        });
        if (path) {
          state.healthPath = path;
          hp = readByPath(source, path);
        }
      }
      if (maxHp == null && !state.maxHealthPath) {
        const path = discoverNumericPath(source, (key, value) => {
          const k = key.toLowerCase();
          if (!/(max.*health|max.*hp|health.*max|max.*life)/.test(k)) return false;
          const n = Number(value);
          return Number.isFinite(n) && n > 0 && n <= 10000;
        });
        if (path) {
          state.maxHealthPath = path;
          maxHp = readByPath(source, path);
        }
      }
    }
    if (hp == null) {
      if (!state.warnedNoHealth) {
        state.warnedNoHealth = true;
        console.info("[Healthbar Test] no remote health fields detected in current match data.", {
          discoveredHealthPath: state.healthPath,
          discoveredMaxPath: state.maxHealthPath,
        });
      }
      return null;
    }
    if (maxHp == null || maxHp <= 0) maxHp = 100;
    return { hp: Math.max(0, hp), maxHp: Math.max(1, maxHp) };
  }

  async function resolveStores() {
    if (state.stores) return state.stores;
    if (!state.storesPromise) {
      state.storesPromise = (async () => {
        while (!document.body) await new Promise((r) => setTimeout(r, 40));
        const moduleScript = document.querySelector("script[src][type='module']");
        if (!moduleScript?.src) throw new Error("Game module script not found");
        const response = await fetch(moduleScript.src);
        const text = await response.text();
        const gameScriptUrl = text.match(/FixSpinePlugin-[^.]+\.js/)?.[0];
        if (!gameScriptUrl) throw new Error("Game script URL not found");
        const gameScript = await import(`/assets/${gameScriptUrl}`);
        const stores = Object.values(gameScript).find((value) => value && value.assignment);
        if (!stores) throw new Error("Stores export not found");
        window.stores = stores;
        state.stores = stores;
        return stores;
      })();
    }
    try {
      return await state.storesPromise;
    } finally {
      state.storesPromise = null;
    }
  }

  function ensureCanvas() {
    if (state.canvas?.parentNode) return;
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:${OVERLAY_Z};`;
    document.body.appendChild(canvas);
    state.canvas = canvas;
    state.ctx = canvas.getContext("2d");
  }

  function resizeCanvas() {
    if (!state.canvas) return;
    state.canvas.width = window.innerWidth;
    state.canvas.height = window.innerHeight;
  }

  function render() {
    const stores = state.stores ?? window.stores;
    const ctx = state.ctx;
    const canvas = state.canvas;
    if (!stores || !ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const camera = stores?.phaser?.scene?.cameras?.cameras?.[0];
    const me = getMainCharacter(stores);
    if (!camera || !me) return;
    const camX = Number(camera?.midPoint?.x);
    const camY = Number(camera?.midPoint?.y);
    const zoom = Number(camera?.zoom ?? 1) || 1;
    if (!Number.isFinite(camX) || !Number.isFinite(camY)) return;
    const myTeam = getCharacterTeam(me);

    let drewAnyBars = false;
    let sawAnyEnemy = false;

    for (const { id, character } of getCharacterEntries(stores)) {
      if (!character || character === me) continue;
      if (myTeam != null && getCharacterTeam(character) === myTeam) continue;
      sawAnyEnemy = true;
      const pos = getCharacterPosition(character);
      if (!pos) continue;
      const sx = (pos.x - camX) * zoom + canvas.width / 2;
      const sy = (pos.y - camY) * zoom + canvas.height / 2;
      if (sx < 0 || sx > canvas.width || sy < 0 || sy > canvas.height) continue;
      const health = getHealth(character, id);
      if (!health) continue;
      drewAnyBars = true;

      const ratio = Math.max(0, Math.min(1, health.hp / health.maxHp));
      const w = 56;
      const h = 6;
      const bx = sx - w / 2;
      const by = sy - 34;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
      ctx.fillStyle = "rgba(255, 70, 70, 0.9)";
      ctx.fillRect(bx, by, w, h);
      const grad = ctx.createLinearGradient(bx, by, bx + w, by);
      grad.addColorStop(0, "#74ff80");
      grad.addColorStop(1, "#2dcf55");
      ctx.fillStyle = grad;
      ctx.fillRect(bx, by, w * ratio, h);
      ctx.font = "11px Verdana";
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${Math.round(health.hp)}/${Math.round(health.maxHp)}`, sx, by - 2);
    }

    if (!drewAnyBars && sawAnyEnemy) {
      state.noDataFrames += 1;
      if (state.noDataFrames > 20) {
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(12, 12, 360, 42);
        ctx.fillStyle = "#ffd1d1";
        ctx.font = "14px Inter, Verdana, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText("Healthbar Test: enemy health is not exposed to this client.", 22, 33);
      }
    } else {
      state.noDataFrames = 0;
    }
  }

  async function boot() {
    await resolveStores();
    while (!document.body) await new Promise((r) => setTimeout(r, 40));
    ensureCanvas();
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    setInterval(render, TICK_MS);
    console.log("[Healthbar Test] active");
  }

  boot().catch((error) => {
    console.error("[Healthbar Test] failed", error);
  });
})();
