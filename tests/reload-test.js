// ==UserScript==
// @name         Zyrox zero reload test
// @namespace    https://github.com/zyrox
// @version      0.2.0
// @description  Test projectile weapons with client-side reload/cooldown duration fields forced to 0.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  "use strict";

  const LOG = "[ZyroxReloadTest]";
  const SCAN_INTERVAL_MS = 50;
  const DEEP_SCAN_INTERVAL_MS = 750;
  const MAX_SCAN_DEPTH = 9;
  const MAX_NODES_PER_SCAN = 8000;
  const SAMPLE_LIMIT = 12;

  const ZERO_NUMBER_KEY_PATTERN = /(?:^|_|-|\b)(reload|reloadtime|reloadtimer|reloadcooldown|cooldown|cooldowntime|cooldowntimer|firerate|fire_rate|firedelay|fire_delay|shotdelay|shot_delay|shootdelay|shoot_delay|attackdelay|attack_delay|refire|refiredelay|rateoffire|windup|winduptime|chargetime|charge_time|nextfire|nextshot|lastfire|lastshot)(?:$|_|-|\b)/i;
  const FALSE_BOOLEAN_KEY_PATTERN = /(?:^|_|-|\b)(isreloading|reloading|onreload|oncooldown|coolingdown|isincooldown)(?:$|_|-|\b)/i;
  const TRUE_BOOLEAN_KEY_PATTERN = /(?:^|_|-|\b)(canfire|readytofire|can shoot|canshoot|isready|weaponready)(?:$|_|-|\b)/i;
  const FOLLOW_KEY_PATTERN = /weapon|gun|projectile|bullet|combat|attack|character|player|ability|item|inventory|controller|manager|phaser|scene|state|store|config|data|stats|equipment|gadget/i;
  const SKIP_KEY_PATTERN = /^(?:parent|parentContainer|children|displayList|events|textures|cache|anims|sound|renderer|plugins|sys|game|canvas|context|socket|connection|xhr|document|window)$/i;

  if (getUnsafeWindow().__zyroxReloadTest?.destroy) {
    getUnsafeWindow().__zyroxReloadTest.destroy();
  }

  const state = {
    enabled: true,
    shallowIntervalId: null,
    deepIntervalId: null,
    totalWrites: 0,
    scanCount: 0,
    patchedJsonParses: 0,
    patchedAssigns: 0,
    patchedDefineProperties: 0,
    lastScanMs: 0,
    lastError: "",
    patchErrors: [],
    samples: [],
  };

  const original = {
    jsonObject: null,
    objectObject: null,
    jsonParse: null,
    objectAssign: null,
    defineProperty: null,
    defineProperties: null,
    patchedJsonParse: false,
    patchedObjectAssign: false,
    patchedDefineProperty: false,
    patchedDefineProperties: false,
  };

  function getUnsafeWindow() {
    if (typeof unsafeWindow !== "undefined") return unsafeWindow;
    return window.wrappedJSObject || window;
  }

  function displayKey(key) {
    return typeof key === "symbol" ? key.toString() : String(key);
  }

  function compactKey(key) {
    return displayKey(key).replace(/[\s_-]+/g, "").toLowerCase();
  }

  function recordWrite(path, before, after) {
    state.totalWrites += 1;
    if (state.samples.length >= SAMPLE_LIMIT) state.samples.shift();
    state.samples.push(`${path}: ${String(before)} -> ${String(after)}`);
  }

  function wantedValueForKey(key, value) {
    const normalized = compactKey(key);
    if (typeof value === "number" && Number.isFinite(value) && value !== 0 && ZERO_NUMBER_KEY_PATTERN.test(normalized)) return 0;
    if (typeof value === "boolean" && value && FALSE_BOOLEAN_KEY_PATTERN.test(normalized)) return false;
    if (typeof value === "boolean" && !value && TRUE_BOOLEAN_KEY_PATTERN.test(normalized)) return true;
    return undefined;
  }

  function setReloadValue(target, key, nextValue, path) {
    let before;
    try {
      before = target[key];
    } catch (_) {
      return 0;
    }
    if (Object.is(before, nextValue)) return 0;

    try {
      target[key] = nextValue;
      if (Object.is(target[key], nextValue)) {
        recordWrite(path, before, nextValue);
        return 1;
      }
    } catch (_) {
      // Some Phaser/game fields are read-only; ignore them and keep scanning other fields.
    }
    return 0;
  }

  function normalizePropertyDescriptor(prop, descriptor, path) {
    if (!descriptor || !("value" in descriptor)) return descriptor;
    const nextValue = wantedValueForKey(prop, descriptor.value);
    if (nextValue === undefined) return descriptor;

    state.patchedDefineProperties += 1;
    recordWrite(path, descriptor.value, nextValue);
    return { ...descriptor, value: nextValue };
  }

  function getScanRoots(deep) {
    const unsafe = getUnsafeWindow();
    const stores = unsafe.stores;
    const phaser = stores?.phaser;
    const scene = phaser?.scene;
    const roots = [
      [stores, "stores"],
      [phaser, "stores.phaser"],
      [phaser?.mainCharacter, "mainCharacter"],
      [scene, "scene"],
      [scene?.characterManager, "scene.characterManager"],
      [scene?.projectileManager, "scene.projectileManager"],
      [scene?.weaponManager, "scene.weaponManager"],
      [scene?.registry?.values, "scene.registry.values"],
    ];

    if (deep) {
      roots.push(
        [unsafe.__NEXT_DATA__, "__NEXT_DATA__"],
        [unsafe.webpackChunk_N_E, "webpackChunk_N_E"],
        [unsafe.webpackChunkgimkit, "webpackChunkgimkit"],
        [unsafe.__zyroxEspShared, "__zyroxEspShared"],
      );
    }

    return roots.filter(([root]) => root && (typeof root === "object" || typeof root === "function"));
  }

  function shouldFollowKey(key, depth, deep) {
    const name = displayKey(key);
    if (SKIP_KEY_PATTERN.test(name)) return false;
    if (depth < 2) return true;
    if (deep && depth < 4) return true;
    return FOLLOW_KEY_PATTERN.test(name) || ZERO_NUMBER_KEY_PATTERN.test(compactKey(name));
  }

  function normalizeReloadFields(root, label, options = {}) {
    if (!root || (typeof root !== "object" && typeof root !== "function")) return 0;

    const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH;
    const maxNodes = options.maxNodes ?? MAX_NODES_PER_SCAN;
    const deep = Boolean(options.deep);
    const seen = new WeakSet();
    const queue = [{ value: root, path: label, depth: 0 }];
    let changed = 0;
    let visited = 0;

    while (queue.length && visited < maxNodes) {
      const item = queue.shift();
      const value = item.value;
      if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
      seen.add(value);
      visited += 1;

      let keys;
      try {
        keys = Reflect.ownKeys(value);
      } catch (_) {
        continue;
      }

      for (const key of keys) {
        const keyName = displayKey(key);
        const childPath = `${item.path}.${keyName}`;
        let child;
        try {
          child = value[key];
        } catch (_) {
          continue;
        }

        const nextValue = wantedValueForKey(key, child);
        if (nextValue !== undefined) {
          changed += setReloadValue(value, key, nextValue, childPath);
          continue;
        }

        if (item.depth >= maxDepth || !child || (typeof child !== "object" && typeof child !== "function")) continue;
        if (!shouldFollowKey(key, item.depth, deep)) continue;
        queue.push({ value: child, path: childPath, depth: item.depth + 1 });
      }
    }

    return changed;
  }

  function scan(deep = false) {
    if (!state.enabled) return 0;
    const startedAt = performance.now();
    let changed = 0;

    try {
      for (const [root, label] of getScanRoots(deep)) {
        changed += normalizeReloadFields(root, label, {
          deep,
          maxDepth: deep ? MAX_SCAN_DEPTH : 5,
          maxNodes: deep ? MAX_NODES_PER_SCAN : 2500,
        });
      }
      state.scanCount += 1;
      state.lastScanMs = Math.round((performance.now() - startedAt) * 10) / 10;
      updateHud();
    } catch (error) {
      state.lastError = error?.message || String(error);
      console.warn(LOG, "scan failed", error);
      updateHud();
    }

    return changed;
  }

  function recordPatchError(name, error) {
    const message = `${name}: ${error?.message || String(error)}`;
    state.patchErrors.push(message);
    state.lastError = message;
    console.warn(LOG, `could not patch ${name}`, error);
  }

  function patchObjectAPIs() {
    const unsafe = getUnsafeWindow();
    original.jsonObject = unsafe.JSON || JSON;
    original.objectObject = unsafe.Object || Object;
    original.jsonParse = original.jsonObject.parse;
    original.objectAssign = original.objectObject.assign;
    original.defineProperty = original.objectObject.defineProperty;
    original.defineProperties = original.objectObject.defineProperties;

    try {
      original.jsonObject.parse = function zyroxReloadJsonParse(text, reviver) {
        const result = original.jsonParse.apply(this, arguments);
        state.patchedJsonParses += 1;
        normalizeReloadFields(result, "JSON.parse", { maxDepth: 6, maxNodes: 2500, deep: true });
        return result;
      };
      original.patchedJsonParse = original.jsonObject.parse !== original.jsonParse;
    } catch (error) {
      recordPatchError("JSON.parse", error);
    }

    try {
      original.objectObject.assign = function zyroxReloadObjectAssign(target, ...sources) {
        const result = original.objectAssign.call(this, target, ...sources);
        state.patchedAssigns += 1;
        normalizeReloadFields(result, "Object.assign", { maxDepth: 4, maxNodes: 1200, deep: true });
        return result;
      };
      original.patchedObjectAssign = original.objectObject.assign !== original.objectAssign;
    } catch (error) {
      recordPatchError("Object.assign", error);
    }

    try {
      original.objectObject.defineProperty = function zyroxReloadDefineProperty(target, prop, descriptor) {
        return original.defineProperty.call(
          this,
          target,
          prop,
          normalizePropertyDescriptor(prop, descriptor, `Object.defineProperty.${displayKey(prop)}`),
        );
      };
      original.patchedDefineProperty = original.objectObject.defineProperty !== original.defineProperty;
    } catch (error) {
      recordPatchError("Object.defineProperty", error);
    }

    try {
      original.objectObject.defineProperties = function zyroxReloadDefineProperties(target, descriptors) {
        const normalizedDescriptors = {};
        for (const prop of Reflect.ownKeys(descriptors || {})) {
          normalizedDescriptors[prop] = normalizePropertyDescriptor(
            prop,
            descriptors[prop],
            `Object.defineProperties.${displayKey(prop)}`,
          );
        }
        return original.defineProperties.call(this, target, normalizedDescriptors);
      };
      original.patchedDefineProperties = original.objectObject.defineProperties !== original.defineProperties;
    } catch (error) {
      recordPatchError("Object.defineProperties", error);
    }
  }

  function restoreObjectAPIs() {
    try {
      if (original.patchedJsonParse) original.jsonObject.parse = original.jsonParse;
      if (original.patchedObjectAssign) original.objectObject.assign = original.objectAssign;
      if (original.patchedDefineProperty) original.objectObject.defineProperty = original.defineProperty;
      if (original.patchedDefineProperties) original.objectObject.defineProperties = original.defineProperties;
    } catch (error) {
      recordPatchError("restore Object APIs", error);
    }
  }

  function start() {
    if (state.shallowIntervalId || state.deepIntervalId) return;
    state.enabled = true;
    scan(true);
    state.shallowIntervalId = setInterval(() => scan(false), SCAN_INTERVAL_MS);
    state.deepIntervalId = setInterval(() => scan(true), DEEP_SCAN_INTERVAL_MS);
    updateHud();
  }

  function stop() {
    state.enabled = false;
    clearInterval(state.shallowIntervalId);
    clearInterval(state.deepIntervalId);
    state.shallowIntervalId = null;
    state.deepIntervalId = null;
    updateHud();
  }

  function makeHud() {
    const hud = document.createElement("div");
    hud.id = "zyrox-reload-test-hud";
    hud.style.cssText = [
      "position:fixed",
      "top:12px",
      "right:12px",
      "z-index:2147483647",
      "width:280px",
      "padding:10px",
      "border-radius:8px",
      "background:rgba(15,15,18,.92)",
      "color:#fff",
      "font:12px/1.35 Arial,sans-serif",
      "box-shadow:0 4px 16px rgba(0,0,0,.35)",
    ].join(";");
    hud.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">Zero reload test</div>
      <div style="margin-bottom:8px;color:#ddd">Keeps reload/cooldown duration fields at <b>0</b>. It does not send FIRE packets.</div>
      <button data-action="toggle" style="width:100%;margin-bottom:6px">Stop</button>
      <button data-action="scan" style="width:100%;margin-bottom:6px">Deep scan now</button>
      <div data-status style="margin-top:8px;color:#ddd"></div>
      <details style="margin-top:6px"><summary>Recent changes</summary><pre data-samples style="white-space:pre-wrap;max-height:120px;overflow:auto;margin:6px 0 0"></pre></details>
    `;
    hud.addEventListener("click", (event) => {
      const action = event.target?.dataset?.action;
      if (action === "toggle") {
        if (state.enabled) stop();
        else start();
      }
      if (action === "scan") scan(true);
    });
    return hud;
  }

  let hud;
  function updateHud() {
    if (!hud) return;
    const toggle = hud.querySelector('[data-action="toggle"]');
    const status = hud.querySelector("[data-status]");
    const samples = hud.querySelector("[data-samples]");
    if (toggle) toggle.textContent = state.enabled ? "Stop" : "Start";
    if (status) {
      status.innerHTML = [
        `status: ${state.enabled ? "forcing reload time to 0" : "stopped"}`,
        `writes: ${state.totalWrites}`,
        `scans: ${state.scanCount}`,
        `last scan: ${state.lastScanMs}ms`,
        `JSON.parse patches: ${state.patchedJsonParses}`,
        `Object.assign patches: ${state.patchedAssigns}`,
        `API hooks: ${[
          original.patchedJsonParse && "JSON.parse",
          original.patchedObjectAssign && "Object.assign",
          original.patchedDefineProperty && "defineProperty",
          original.patchedDefineProperties && "defineProperties",
        ].filter(Boolean).join(", ") || "unavailable; scanner still active"}`,
        state.lastError ? `last error: ${state.lastError}` : "",
      ].filter(Boolean).join("<br>");
    }
    if (samples) samples.textContent = state.samples.join("\n");
  }

  function installHud() {
    if (!document.body) {
      requestAnimationFrame(installHud);
      return;
    }
    hud = makeHud();
    document.body.appendChild(hud);
    updateHud();
  }

  patchObjectAPIs();
  installHud();
  start();

  const api = {
    state,
    start,
    stop,
    scan,
    zero: () => scan(true),
    destroy() {
      stop();
      restoreObjectAPIs();
      hud?.remove();
      if (getUnsafeWindow().__zyroxReloadTest === this) delete getUnsafeWindow().__zyroxReloadTest;
      if (window.__zyroxReloadTest === this) delete window.__zyroxReloadTest;
    },
  };

  getUnsafeWindow().__zyroxReloadTest = api;
  window.__zyroxReloadTest = api;

  console.log(LOG, "loaded; reload/cooldown duration fields will be kept at 0. Use window.__zyroxReloadTest.stop() to disable.");
})();
