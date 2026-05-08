// ==UserScript==
// @name        Gimkit Minimap Test (No GUI)
// @description Standalone minimap test overlay for Gimkit 2D modes
// @namespace   https://github.com/Zyrox-client
// @match       https://www.gimkit.com/join*
// @match       https://www.gimkit.com/play*
// @run-at      document-start
// @grant       none
// ==/UserScript==

(() => {
  'use strict';

  const SIZE = 200;
  const Z_INDEX = 9999;

  const state = {
    stores: null,
    room: null,
    canvas: null,
    ctx: null,
    terrainCanvas: null,
    worldBounds: { x: 0, y: 0, width: 1, height: 1 },
    players: new Map(),
    rafId: 0,
    pollId: 0,
    roomPollId: 0,
    visible: true,
    domReady: false,
  };

  const waitForBody = () => new Promise((resolve) => {
    if (document.body) return resolve();
    window.addEventListener('DOMContentLoaded', resolve, { once: true });
  });

  const findStoresFromWindow = () => Object.values(window).find((v) => v && typeof v === 'object' && v.phaser && v.me) || null;
  const findRoom = () => Object.values(window).find((v) => v?.state?.players && typeof v.state.players.onAdd === 'function') || null;

  const tryExposeStoresFromBundle = async () => {
    const moduleScript = document.querySelector('script[src][type="module"]');
    if (!moduleScript?.src) return null;

    const response = await fetch(moduleScript.src);
    const text = await response.text();
    const gameScriptUrl = text.match(/FixSpinePlugin-[^.]+\.js/)?.[0];
    if (!gameScriptUrl) return null;

    const gameScript = await import(`/assets/${gameScriptUrl}`);
    return Object.values(gameScript).find((v) => v && typeof v === 'object' && v.phaser && v.me) || null;
  };

  const getWorldBounds = (stores) => {
    const scene = stores?.phaser?.scene;
    const wm = scene?.worldManager;
    const tilemap = wm?.map || wm?.tilemap || scene?.tilemap || scene?.map;
    if (tilemap?.widthInPixels && tilemap?.heightInPixels) return { x: 0, y: 0, width: tilemap.widthInPixels, height: tilemap.heightInPixels };

    const bounds = scene?.cameras?.main?.getBounds?.();
    if (bounds?.width && bounds?.height) return { x: bounds.x || 0, y: bounds.y || 0, width: bounds.width, height: bounds.height };

    const worldView = scene?.cameras?.main?.worldView;
    if (worldView?.width && worldView?.height) return { x: worldView.x || 0, y: worldView.y || 0, width: worldView.width, height: worldView.height };

    return { x: 0, y: 0, width: 5000, height: 5000 };
  };

  const worldToMap = (x, y) => ({
    x: ((x - state.worldBounds.x) / Math.max(1, state.worldBounds.width)) * SIZE,
    y: ((y - state.worldBounds.y) / Math.max(1, state.worldBounds.height)) * SIZE,
  });

  const buildTerrainCache = () => {
    const cache = document.createElement('canvas');
    cache.width = SIZE;
    cache.height = SIZE;
    const ctx = cache.getContext('2d');
    ctx.fillStyle = 'rgba(8,12,18,.9)';
    ctx.fillRect(0, 0, SIZE, SIZE);

    const devices = state.stores?.phaser?.scene?.worldManager?.devices?.allDevices;
    const list = Array.isArray(devices) ? devices : (devices ? Object.values(devices) : []);

    ctx.fillStyle = 'rgba(120,170,255,.45)';
    for (const device of list) {
      const dx = Number(device?.x);
      const dy = Number(device?.y);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      const p = worldToMap(dx, dy);
      ctx.fillRect(p.x - 1, p.y - 1, 3, 3);
    }

    state.terrainCanvas = cache;
  };

  const getCharacters = () => {
    const map = state.stores?.phaser?.scene?.characterManager?.characters;
    if (!map) return [];
    if (typeof map.values === 'function') return Array.from(map.values());
    if (Array.isArray(map)) return map;
    return Object.values(map);
  };

  const getCharPos = (char) => {
    const x = char?.x ?? char?.position?.x ?? char?.body?.x;
    const y = char?.y ?? char?.position?.y ?? char?.body?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  };

  const draw = () => {
    if (!state.ctx) return;

    state.ctx.clearRect(0, 0, SIZE, SIZE);
    if (state.terrainCanvas) {
      state.ctx.drawImage(state.terrainCanvas, 0, 0);
    } else {
      state.ctx.fillStyle = 'rgba(8,12,18,.9)';
      state.ctx.fillRect(0, 0, SIZE, SIZE);
    }

    if (state.visible) {
      for (const pData of state.players.values()) {
        if (!Number.isFinite(pData.x) || !Number.isFinite(pData.y)) continue;
        const p = worldToMap(pData.x, pData.y);
        const sameTeam = pData.teamId != null && state.stores?.me?.teamId != null && pData.teamId === state.stores.me.teamId;
        state.ctx.fillStyle = sameTeam ? '#57a6ff' : '#ff5566';
        state.ctx.beginPath();
        state.ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        state.ctx.fill();
      }

      // Fallback player draw path in case Colyseus room is not discoverable.
      for (const char of getCharacters()) {
        const pos = getCharPos(char);
        if (!pos) continue;
        const p = worldToMap(pos.x, pos.y);
        state.ctx.fillStyle = '#f6c04f';
        state.ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      }

      const meX = state.stores?.phaser?.mainCharacter?.body?.x;
      const meY = state.stores?.phaser?.mainCharacter?.body?.y;
      if (Number.isFinite(meX) && Number.isFinite(meY)) {
        const me = worldToMap(meX, meY);
        state.ctx.fillStyle = '#71ff68';
        state.ctx.beginPath();
        state.ctx.arc(me.x, me.y, 4, 0, Math.PI * 2);
        state.ctx.fill();
      }
    }

    state.rafId = requestAnimationFrame(draw);
  };

  const createDom = async () => {
    if (state.domReady) return;
    await waitForBody();

    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    Object.assign(canvas.style, {
      position: 'fixed', top: '12px', right: '12px', width: `${SIZE}px`, height: `${SIZE}px`,
      zIndex: String(Z_INDEX), background: 'rgba(8,10,16,.62)', border: '1px solid rgba(255,255,255,.25)',
      borderRadius: '8px', cursor: 'move',
    });
    document.body.appendChild(canvas);
    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');

    const toggle = document.createElement('button');
    toggle.textContent = 'Minimap';
    Object.assign(toggle.style, { position: 'fixed', top: '220px', right: '12px', zIndex: String(Z_INDEX + 1) });
    toggle.addEventListener('click', () => {
      state.visible = !state.visible;
      canvas.style.opacity = state.visible ? '1' : '0.35';
    });
    document.body.appendChild(toggle);

    window.addEventListener('keydown', (e) => {
      if (e.key?.toLowerCase() === 'm') toggle.click();
    }, true);

    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      drag = { sx: e.clientX, sy: e.clientY, left: canvas.offsetLeft, top: canvas.offsetTop };
      canvas.style.right = 'auto';
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      canvas.style.left = `${drag.left + (e.clientX - drag.sx)}px`;
      canvas.style.top = `${drag.top + (e.clientY - drag.sy)}px`;
    });
    canvas.addEventListener('pointerup', () => { drag = null; });

    state.domReady = true;
    if (!state.rafId) state.rafId = requestAnimationFrame(draw);
  };

  const attachRoomTracking = (room) => {
    if (!room?.state?.players) return;
    room.state.players.onAdd((player, key) => {
      const entry = { x: Number(player?.x) || 0, y: Number(player?.y) || 0, teamId: player?.teamId ?? null };
      state.players.set(key, entry);
      player.listen?.('x', (v) => {
        const curr = state.players.get(key);
        if (curr) curr.x = Number(v) || 0;
      });
      player.listen?.('y', (v) => {
        const curr = state.players.get(key);
        if (curr) curr.y = Number(v) || 0;
      });
    });
    room.state.players.onRemove((_, key) => state.players.delete(key));
  };

  const start = async () => {
    await createDom();

    state.pollId = window.setInterval(async () => {
      if (!state.stores) {
        state.stores = findStoresFromWindow();
        if (!state.stores) {
          try { state.stores = await tryExposeStoresFromBundle(); } catch (_) {}
        }
        if (state.stores) {
          state.worldBounds = getWorldBounds(state.stores);
          buildTerrainCache();
          console.log('[minimap-test] stores found');
        }
      }

      if (state.stores && !state.room) {
        state.room = findRoom();
        if (state.room) {
          attachRoomTracking(state.room);
          console.log('[minimap-test] room found');
        }
      }
    }, 300);
  };

  start().catch((err) => console.error('[minimap-test] failed', err));
})();
