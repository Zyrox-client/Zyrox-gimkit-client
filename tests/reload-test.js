// ==UserScript==
// @name         Zyrox reload/projectile test
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Test whether projectile weapons can fire continuously by zeroing reload-like fields and spamming FIRE packets.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG = "[ZyroxReloadTest]";
  const ROOM_DATA = 13;
  const DEFAULT_INTERVAL_MS = 25;
  const ZERO_RELOAD_INTERVAL_MS = 100;
  const MAX_SCAN_DEPTH = 6;
  const RELOAD_KEY_PATTERN = /(reload|cooldown|fireRate|fireDelay|shotDelay|shootDelay|attackDelay|lastFire|lastShot|nextFire|nextShot|chargeTime|windup|ammo|magazine)/i;
  const ZERO_KEYS_PATTERN = /(reload|cooldown|delay|fireRate|lastFire|lastShot|nextFire|nextShot|chargeTime|windup)/i;

  if (window.__zyroxReloadTest?.destroy) {
    window.__zyroxReloadTest.destroy();
  }

  const state = {
    enabled: false,
    zeroReload: true,
    fireWhileMouseDownOnly: true,
    intervalMs: DEFAULT_INTERVAL_MS,
    socket: null,
    fireTimer: null,
    zeroTimer: null,
    packetsSent: 0,
    zeroedFields: 0,
    lastError: "",
    lastFireAt: 0,
  };

  function utf8ByteLength(input) {
    let len = 0;
    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i);
      if (code < 0x80) len += 1;
      else if (code < 0x800) len += 2;
      else if (code < 0xd800 || code > 0xdfff) len += 3;
      else {
        i += 1;
        len += 4;
      }
    }
    return len;
  }

  function writeUtf8(target, input, offset) {
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
  }

  function msgpackEncode(value) {
    const bytes = [];
    const deferred = [];

    const write = (input) => {
      const type = typeof input;
      if (input == null) {
        bytes.push(0xc0);
        return;
      }
      if (type === "boolean") {
        bytes.push(input ? 0xc3 : 0xc2);
        return;
      }
      if (type === "number") {
        if (Number.isInteger(input) && input >= 0 && input < 0x80) {
          bytes.push(input);
          return;
        }
        if (Number.isInteger(input) && input >= 0 && input < 0x100) {
          bytes.push(0xcc, input);
          return;
        }
        if (Number.isInteger(input) && input >= 0 && input < 0x10000) {
          bytes.push(0xcd, input >> 8, input & 0xff);
          return;
        }
        if (Number.isInteger(input) && input >= -0x20 && input < 0) {
          bytes.push(0x100 + input);
          return;
        }
        bytes.push(0xcb);
        deferred.push({ type: "float64", value: input, offset: bytes.length });
        bytes.length += 8;
        return;
      }
      if (type === "string") {
        const len = utf8ByteLength(input);
        if (len < 32) bytes.push(0xa0 | len);
        else if (len < 0x100) bytes.push(0xd9, len);
        else bytes.push(0xda, len >> 8, len & 0xff);
        deferred.push({ type: "string", value: input, offset: bytes.length });
        bytes.length += len;
        return;
      }
      if (Array.isArray(input)) {
        if (input.length < 16) bytes.push(0x90 | input.length);
        else bytes.push(0xdc, input.length >> 8, input.length & 0xff);
        input.forEach(write);
        return;
      }
      const keys = Object.keys(input).filter((key) => typeof input[key] !== "function");
      if (keys.length < 16) bytes.push(0x80 | keys.length);
      else bytes.push(0xde, keys.length >> 8, keys.length & 0xff);
      keys.forEach((key) => {
        write(key);
        write(input[key]);
      });
    };

    write(value);
    const output = new Uint8Array(bytes.length);
    bytes.forEach((byte, index) => {
      output[index] = byte || 0;
    });
    deferred.forEach((part) => {
      if (part.type === "float64") {
        new DataView(output.buffer).setFloat64(part.offset, part.value);
      } else {
        writeUtf8(output, part.value, part.offset);
      }
    });
    return output;
  }

  function encodeRoomData(channel, data) {
    const channelBytes = msgpackEncode(channel);
    const dataBytes = msgpackEncode(data);
    const packet = new Uint8Array(1 + channelBytes.byteLength + dataBytes.byteLength);
    packet[0] = ROOM_DATA;
    packet.set(channelBytes, 1);
    packet.set(dataBytes, 1 + channelBytes.byteLength);
    return packet;
  }

  function getMainCharacterBody() {
    const unsafe = window.wrappedJSObject || window;
    return unsafe.stores?.phaser?.mainCharacter?.body || null;
  }

  function getPointer() {
    const unsafe = window.wrappedJSObject || window;
    return unsafe.stores?.phaser?.scene?.input?.mousePointer || null;
  }

  function getFirePayload() {
    const body = getMainCharacterBody();
    const pointer = getPointer();
    const x = Number.isFinite(body?.x) ? body.x : 0;
    const y = Number.isFinite(body?.y) ? body.y : 0;
    const worldX = Number.isFinite(pointer?.worldX) ? pointer.worldX : x + 1;
    const worldY = Number.isFinite(pointer?.worldY) ? pointer.worldY : y;
    return {
      angle: Math.atan2(worldY - (y - 3), worldX - x),
      x,
      y,
    };
  }

  function sendFire() {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
    const pointer = getPointer();
    if (state.fireWhileMouseDownOnly && !pointer?.isDown) return false;

    try {
      state.socket.send(encodeRoomData("FIRE", getFirePayload()));
      state.packetsSent += 1;
      state.lastFireAt = Date.now();
      updateHud();
      return true;
    } catch (error) {
      state.lastError = error?.message || String(error);
      console.warn(LOG, "FIRE send failed", error);
      updateHud();
      return false;
    }
  }

  function shouldTryZero(key, value) {
    return typeof key === "string"
      && typeof value === "number"
      && Number.isFinite(value)
      && value !== 0
      && RELOAD_KEY_PATTERN.test(key)
      && ZERO_KEYS_PATTERN.test(key);
  }

  function zeroReloadFields(root, label) {
    if (!root || (typeof root !== "object" && typeof root !== "function")) return 0;

    const seen = new WeakSet();
    const queue = [{ value: root, path: label, depth: 0 }];
    let changed = 0;

    while (queue.length) {
      const item = queue.shift();
      const value = item.value;
      if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
      seen.add(value);

      let keys;
      try {
        keys = Object.keys(value);
      } catch (_) {
        continue;
      }

      for (const key of keys) {
        let child;
        try {
          child = value[key];
        } catch (_) {
          continue;
        }

        if (shouldTryZero(key, child)) {
          try {
            value[key] = 0;
            changed += 1;
          } catch (_) {
            // Read-only fields are expected on some game objects.
          }
          continue;
        }

        if (item.depth < MAX_SCAN_DEPTH && child && (typeof child === "object" || typeof child === "function")) {
          const childKey = String(key);
          if (RELOAD_KEY_PATTERN.test(childKey) || /weapon|gun|projectile|character|player|ability|item|stores|state|phaser/i.test(childKey)) {
            queue.push({ value: child, path: `${item.path}.${childKey}`, depth: item.depth + 1 });
          }
        }
      }
    }

    return changed;
  }

  function zeroLikelyReloadState() {
    if (!state.zeroReload) return;
    const unsafe = window.wrappedJSObject || window;
    const roots = [
      [unsafe.stores, "stores"],
      [unsafe.stores?.phaser, "stores.phaser"],
      [unsafe.stores?.phaser?.mainCharacter, "mainCharacter"],
      [unsafe.stores?.phaser?.scene, "scene"],
    ];
    const changed = roots.reduce((total, [root, label]) => total + zeroReloadFields(root, label), 0);
    if (changed) {
      state.zeroedFields += changed;
      updateHud();
    }
  }

  function startTimers() {
    stopTimers();
    state.fireTimer = setInterval(sendFire, Math.max(1, Number(state.intervalMs) || DEFAULT_INTERVAL_MS));
    state.zeroTimer = setInterval(zeroLikelyReloadState, ZERO_RELOAD_INTERVAL_MS);
  }

  function stopTimers() {
    clearInterval(state.fireTimer);
    clearInterval(state.zeroTimer);
    state.fireTimer = null;
    state.zeroTimer = null;
  }

  function setEnabled(enabled) {
    state.enabled = Boolean(enabled);
    if (state.enabled) startTimers();
    else stopTimers();
    updateHud();
  }

  function patchWebSocket() {
    const NativeWebSocket = window.WebSocket;
    class ReloadTestWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        if (!state.socket) {
          state.socket = this;
          console.log(LOG, "captured WebSocket", url);
          updateHud();
        }
      }
    }

    Object.setPrototypeOf(ReloadTestWebSocket, NativeWebSocket);
    window.WebSocket = ReloadTestWebSocket;

    return () => {
      if (window.WebSocket === ReloadTestWebSocket) window.WebSocket = NativeWebSocket;
    };
  }

  function makeHud() {
    const hud = document.createElement("div");
    hud.id = "zyrox-reload-test-hud";
    hud.style.cssText = [
      "position:fixed",
      "top:12px",
      "right:12px",
      "z-index:2147483647",
      "width:260px",
      "padding:10px",
      "border-radius:8px",
      "background:rgba(15,15,18,.92)",
      "color:#fff",
      "font:12px/1.35 Arial,sans-serif",
      "box-shadow:0 4px 16px rgba(0,0,0,.35)",
    ].join(";");
    hud.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px">Reload / projectile test</div>
      <button data-action="toggle" style="width:100%;margin-bottom:6px">Start</button>
      <label style="display:block;margin:4px 0"><input data-action="zero" type="checkbox" checked> zero reload-like fields</label>
      <label style="display:block;margin:4px 0"><input data-action="mouse" type="checkbox" checked> only fire while mouse is down</label>
      <label style="display:block;margin:6px 0">interval ms <input data-action="interval" type="number" min="1" value="${DEFAULT_INTERVAL_MS}" style="width:70px"></label>
      <button data-action="single" style="width:100%;margin:4px 0">Send one FIRE</button>
      <div data-status style="margin-top:8px;color:#ddd"></div>
    `;
    hud.addEventListener("click", (event) => {
      const action = event.target?.dataset?.action;
      if (action === "toggle") setEnabled(!state.enabled);
      if (action === "single") sendFire();
    });
    hud.addEventListener("change", (event) => {
      const target = event.target;
      const action = target?.dataset?.action;
      if (action === "zero") state.zeroReload = target.checked;
      if (action === "mouse") state.fireWhileMouseDownOnly = target.checked;
      if (action === "interval") {
        state.intervalMs = Math.max(1, Number(target.value) || DEFAULT_INTERVAL_MS);
        if (state.enabled) startTimers();
      }
      updateHud();
    });
    return hud;
  }

  let hud;
  function updateHud() {
    if (!hud) return;
    const toggle = hud.querySelector('[data-action="toggle"]');
    const status = hud.querySelector("[data-status]");
    if (toggle) toggle.textContent = state.enabled ? "Stop" : "Start";
    if (status) {
      status.innerHTML = [
        `socket: ${state.socket?.readyState === WebSocket.OPEN ? "open" : state.socket ? "captured" : "waiting"}`,
        `sent: ${state.packetsSent}`,
        `zeroed writes: ${state.zeroedFields}`,
        state.lastFireAt ? `last fire: ${new Date(state.lastFireAt).toLocaleTimeString()}` : "last fire: never",
        state.lastError ? `last error: ${state.lastError}` : "",
      ].filter(Boolean).join("<br>");
    }
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

  const restoreWebSocket = patchWebSocket();
  installHud();

  window.__zyroxReloadTest = {
    state,
    start: () => setEnabled(true),
    stop: () => setEnabled(false),
    fire: sendFire,
    zero: zeroLikelyReloadState,
    destroy() {
      setEnabled(false);
      restoreWebSocket();
      hud?.remove();
      if (window.__zyroxReloadTest === this) delete window.__zyroxReloadTest;
    },
  };

  console.log(LOG, "loaded. Use the HUD or window.__zyroxReloadTest.start().");
})();
