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
    terrainRects: [],
    viewSpan: 2800,
    worldBounds: { x: 0, y: 0, width: 1, height: 1 },
    players: new Map(),
    rafId: 0,
    pollId: 0,
    roomPollId: 0,
    domReady: false,
  };

  const waitForBody = () => new Promise((resolve) => {
    if (document.body) return resolve();
    window.addEventListener('DOMContentLoaded', resolve, { once: true });
  });

  const findStoresFromWindow = () => Object.values(window).find((v) => v && typeof v === 'object' && v.phaser && v.me) || null;
  const findRoom = () => Object.values(window).find((v) => v?.state?.players && typeof v.state.players.onAdd === 'function') || null;


  const isPlayableSceneReady = (stores) => {
    const scene = stores?.phaser?.scene;
    if (!scene) return false;
    const hasCamera = !!scene?.cameras?.main;
    const displayCount = Array.isArray(scene?.children?.list) ? scene.children.list.length : 0;
    const hasMainCharacterBody = !!stores?.phaser?.mainCharacter?.body;
    // Require a meaningful scene to avoid booting on join/lobby placeholders.
    return hasCamera && (displayCount > 0 || hasMainCharacterBody);
  };

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



  const safeNumber = (obj, key) => {
    try {
      const v = obj?.[key];
      return Number.isFinite(v) ? Number(v) : null;
    } catch (_) {
      return null;
    }
  };

  const worldToMapCentered = (x, y, cx, cy, span = 1800) => ({
    x: ((x - (cx - span / 2)) / span) * SIZE,
    y: ((y - (cy - span / 2)) / span) * SIZE,
  });


  const safePreview = (value, depth = 2, seen = new WeakSet()) => {
    if (value == null) return value;
    if (depth <= 0) return typeof value;
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 12).map((v) => safePreview(v, depth - 1, seen));
    const out = {};
    for (const key of Object.keys(value).slice(0, 30)) {
      try {
        out[key] = safePreview(value[key], depth - 1, seen);
      } catch (err) {
        out[key] = `[getter-err:${err?.message || 'unknown'}]`;
      }
    }
    return out;
  };

  const logMapContentDeep = () => {
    const scene = state.stores?.phaser?.scene;
    const wm = scene?.worldManager;
    const terrain = wm?.terrain;
    const devices = wm?.devices?.allDevices;
    const deviceList = Array.isArray(devices) ? devices : (devices ? Object.values(devices) : []);

    const display = scene?.children?.list || [];
    const displaySummary = display.slice(0, 80).map((obj, idx) => ({
      i: idx,
      type: obj?.type,
      name: obj?.name,
      hasTilemap: !!obj?.tilemap,
      hasLayerData: !!obj?.layer?.data,
      keys: Object.keys(obj || {}).slice(0, 12),
    }));

    const terrainPoints = collectPointsFromAny(terrain, 3000);

    console.groupCollapsed('[minimap-test] MAP DATA DUMP');
    console.log('worldManager keys', Object.keys(wm || {}));
    console.log('terrain keys', Object.keys(terrain || {}));
    console.log('terrain preview', safePreview(terrain, 3));
    console.log('devices count', deviceList.length);
    console.log('devices sample', safePreview(deviceList.slice(0, 20), 2));
    console.log('terrain points sample', terrainPoints.slice(0, 60));
    console.table(displaySummary);
    console.log('scene texture keys', Object.keys(scene?.textures?.list || {}));
    console.groupEnd();
  };

  const logMapDiscovery = () => {
    const scene = state.stores?.phaser?.scene;
    const terrain = scene?.worldManager?.terrain;
    const terrainRects = [];
    const wm = scene?.worldManager;
    const candidates = {
      sceneTilemap: !!scene?.tilemap,
      sceneMap: !!scene?.map,
      worldManagerMap: !!wm?.map,
      worldManagerTilemap: !!wm?.tilemap,
      worldManagerTerrain: !!wm?.terrain,
      worldManagerDevices: !!wm?.devices,
      displayListCount: Array.isArray(scene?.children?.list) ? scene.children.list.length : 0,
    };
    console.log('[minimap-test] map candidates', candidates);

    const display = scene?.children?.list || [];
    const tileLike = [];
    for (const obj of display) {
      const isTileLayer = !!obj?.layer?.data;
      const hasTilemap = !!obj?.tilemap;
      if (!isTileLayer && !hasTilemap) continue;
      tileLike.push({
        type: obj?.type,
        name: obj?.name,
        hasLayerData: !!obj?.layer?.data,
        layerRows: Array.isArray(obj?.layer?.data) ? obj.layer.data.length : 0,
        tileW: obj?.tilemap?.tileWidth,
        tileH: obj?.tilemap?.tileHeight,
        widthPx: obj?.tilemap?.widthInPixels,
        heightPx: obj?.tilemap?.heightInPixels,
      });
    }
    console.log('[minimap-test] tile-like display objects', tileLike);
    const textureKeys = Object.keys(scene?.textures?.list || {}).slice(0, 60);
    console.log('[minimap-test] texture keys sample', textureKeys);
  };


  const collectPointsFromAny = (root, limit = 15000) => {
    const out = [];
    const seen = new Set();
    const stack = [root];
    while (stack.length && out.length < limit) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);

      const x = safeNumber(cur, 'x');
      const y = safeNumber(cur, 'y');
      if (x != null && y != null) {
        out.push({ x, y, w: Number(cur.width || cur.w || 0), h: Number(cur.height || cur.h || 0) });
      }
      const px = safeNumber(cur, 'pixelX');
      const py = safeNumber(cur, 'pixelY');
      if (px != null && py != null) {
        out.push({ x: px, y: py, w: Number(cur.width || cur.w || 0), h: Number(cur.height || cur.h || 0) });
      }

      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
      } else {
        for (const v of Object.values(cur)) stack.push(v);
      }
    }
    return out;
  };

  const deriveDynamicBounds = () => {
    const points = [];
    const meX = state.stores?.phaser?.mainCharacter?.body?.x;
    const meY = state.stores?.phaser?.mainCharacter?.body?.y;
    if (Number.isFinite(meX) && Number.isFinite(meY)) points.push({ x: meX, y: meY });

    for (const c of getCharacters()) {
      const pos = getCharPos(c);
      if (pos) points.push(pos);
    }

    const devices = state.stores?.phaser?.scene?.worldManager?.devices?.allDevices;
    const list = Array.isArray(devices) ? devices : (devices ? Object.values(devices) : []);
    for (const d of list) {
      if (Number.isFinite(d?.x) && Number.isFinite(d?.y)) points.push({ x: Number(d.x), y: Number(d.y) });
    }

    const terrain = state.stores?.phaser?.scene?.worldManager?.terrain;
    for (const p of collectPointsFromAny(terrain, 5000)) points.push({ x: p.x, y: p.y });

    if (points.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const pad = 120;
    const width = Math.max(500, maxX - minX + pad * 2);
    const height = Math.max(500, maxY - minY + pad * 2);
    const maxDim = Math.max(width, height);
    state.viewSpan = Math.max(1400, Math.min(5200, maxDim * 0.42));
    return { x: minX - pad, y: minY - pad, width, height };
  };

  const buildTerrainCache = () => {
    const cache = document.createElement('canvas');
    cache.width = SIZE;
    cache.height = SIZE;
    const ctx = cache.getContext('2d');
    ctx.fillStyle = 'rgba(8,12,18,.9)';
    ctx.fillRect(0, 0, SIZE, SIZE);

    const scene = state.stores?.phaser?.scene;
    const terrain = scene?.worldManager?.terrain;
    const terrainRects = [];

    // Draw tilemap layers if present (best minimap approximation of map geometry).
    const maybeLayers = [];
    let drawnTiles = 0;
    const displayList = scene?.children?.list || [];
    for (const obj of displayList) {
      if (obj?.layer?.data && Number.isFinite(obj?.tilemap?.tileWidth) && Number.isFinite(obj?.tilemap?.tileHeight)) maybeLayers.push(obj);
    }

    // Probe custom Gimkit tilemap objects that do not expose layer.data.
    const customTileObjects = displayList.filter((obj) => {
      const t = String(obj?.type || '');
      return t.includes('CustomWallsTilemapGameObject') || t.includes('CustomTilemapGameObject');
    });

    for (const layerObj of maybeLayers) {
      const layer = layerObj.layer;
      const tileW = Number(layerObj.tilemap?.tileWidth) || 32;
      const tileH = Number(layerObj.tilemap?.tileHeight) || 32;
      const rows = Array.isArray(layer?.data) ? layer.data : [];

      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        for (const tile of row) {
          if (!tile) continue;
          const hasTile = tile.index !== -1 || tile.visible || tile.collides;
          if (!hasTile) continue;
          const tx = Number(tile.pixelX ?? tile.x * tileW);
          const ty = Number(tile.pixelY ?? tile.y * tileH);
          if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
          const p = worldToMap(tx, ty);
          const p2 = worldToMap(tx + tileW, ty + tileH);
          const w = Math.max(1, p2.x - p.x);
          const h = Math.max(1, p2.y - p.y);
          ctx.fillStyle = tile.collides ? 'rgba(225,235,255,.48)' : 'rgba(120,150,185,.35)';
          ctx.fillRect(p.x, p.y, w, h);
          terrainRects.push({ x: tx, y: ty, w: tileW, h: tileH, c: tile.collides ? 'rgba(225,235,255,.48)' : 'rgba(120,150,185,.35)' });
          drawnTiles += 1;
        }
      }
    }

    // Draw approximated geometry from custom tilemap objects.
    let drawnCustomObjectPoints = 0;
    for (const obj of customTileObjects) {
      const baseX = safeNumber(obj, 'x') || 0;
      const baseY = safeNumber(obj, 'y') || 0;
      const pts = collectPointsFromAny(obj, 1200);
      for (const point of pts) {
        const wx = Number.isFinite(point.x) ? point.x : baseX;
        const wy = Number.isFinite(point.y) ? point.y : baseY;
        const ww = Number.isFinite(point.w) && point.w > 0 ? Math.min(point.w, 48) : 6;
        const hh = Number.isFinite(point.h) && point.h > 0 ? Math.min(point.h, 48) : 6;
        const p = worldToMap(wx, wy);
        const w = Math.max(1, ww / Math.max(1, state.worldBounds.width) * SIZE);
        const h = Math.max(1, hh / Math.max(1, state.worldBounds.height) * SIZE);
        ctx.fillStyle = 'rgba(175,205,255,.45)';
        ctx.fillRect(p.x, p.y, w, h);
        terrainRects.push({ x: wx, y: wy, w: ww, h: hh, c: 'rgba(175,205,255,.65)' });
        drawnCustomObjectPoints += 1;
      }

      const dw = safeNumber(obj, 'displayWidth');
      const dh = safeNumber(obj, 'displayHeight');
      if (dw && dh && dw > 8 && dh > 8) {
        terrainRects.push({ x: baseX, y: baseY, w: Math.min(dw, 256), h: Math.min(dh, 256), c: 'rgba(210,230,255,.3)' });
      }
    }

    // Fallback terrain draw for custom map containers (e.g. CustomWallsTilemapGameObject + worldManager.terrain).
    let drawnTerrainPoints = 0;
    for (const point of collectPointsFromAny(terrain)) {
      const p = worldToMap(point.x, point.y);
      const w = Math.max(1, (point.w || 32) / Math.max(1, state.worldBounds.width) * SIZE);
      const h = Math.max(1, (point.h || 32) / Math.max(1, state.worldBounds.height) * SIZE);
      ctx.fillStyle = 'rgba(150,170,210,.32)';
      ctx.fillRect(p.x, p.y, w, h);
      terrainRects.push({ x: point.x, y: point.y, w: (Number.isFinite(point.w) && point.w > 0 ? Math.min(point.w, 20) : 4), h: (Number.isFinite(point.h) && point.h > 0 ? Math.min(point.h, 20) : 4), c: 'rgba(110,150,220,.55)' });
      drawnTerrainPoints += 1;
    }

    // Draw device landmarks over terrain.
    const devices = scene?.worldManager?.devices?.allDevices;
    const list = Array.isArray(devices) ? devices : (devices ? Object.values(devices) : []);
    ctx.fillStyle = 'rgba(255,210,92,.88)';
    let drawnDevices = 0;
    for (const device of list) {
      const dx = Number(device?.x);
      const dy = Number(device?.y);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      const p = worldToMap(dx, dy);
      ctx.fillRect(p.x - 1, p.y - 1, 3, 3);
      drawnDevices += 1;
    }

    state.terrainCanvas = cache;
    state.terrainRects = terrainRects;
    console.log('[minimap-test] terrain cache built', { layerCandidates: maybeLayers.length, customTileObjects: customTileObjects.length, drawnCustomObjectPoints, drawnTiles, drawnTerrainPoints, drawnDevices });
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
    const meX = state.stores?.phaser?.mainCharacter?.body?.x;
    const meY = state.stores?.phaser?.mainCharacter?.body?.y;
    const centerX = Number.isFinite(meX) ? meX : (state.worldBounds.x + state.worldBounds.width / 2);
    const centerY = Number.isFinite(meY) ? meY : (state.worldBounds.y + state.worldBounds.height / 2);

    if (Array.isArray(state.terrainRects) && state.terrainRects.length) {
      for (const r of state.terrainRects) {
        const p = worldToMapCentered(r.x, r.y, centerX, centerY, state.viewSpan);
        const p2 = worldToMapCentered(r.x + (r.w || 32), r.y + (r.h || 32), centerX, centerY, state.viewSpan);
        state.ctx.fillStyle = r.c || 'rgba(120,150,185,.35)';
        state.ctx.fillRect(p.x, p.y, Math.max(2, p2.x - p.x), Math.max(2, p2.y - p.y));
      }
    } else if (state.terrainCanvas) {
      state.ctx.globalAlpha = 0.75;
      state.ctx.drawImage(state.terrainCanvas, 0, 0);
      state.ctx.globalAlpha = 1;
    } else {
      state.ctx.fillStyle = 'rgba(8,12,18,.9)';
      state.ctx.fillRect(0, 0, SIZE, SIZE);
      state.ctx.strokeStyle = 'rgba(255,255,255,.08)';
      state.ctx.lineWidth = 1;
      for (let i = 0; i <= 10; i += 1) {
        const p = (SIZE / 10) * i;
        state.ctx.beginPath();
        state.ctx.moveTo(p, 0);
        state.ctx.lineTo(p, SIZE);
        state.ctx.stroke();
        state.ctx.beginPath();
        state.ctx.moveTo(0, p);
        state.ctx.lineTo(SIZE, p);
        state.ctx.stroke();
      }
    }

      for (const pData of state.players.values()) {
        if (!Number.isFinite(pData.x) || !Number.isFinite(pData.y)) continue;
        const p = worldToMapCentered(pData.x, pData.y, centerX, centerY, state.viewSpan);
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
        const p = worldToMapCentered(pos.x, pos.y, centerX, centerY, state.viewSpan);
        state.ctx.fillStyle = '#ff3b3b';
        state.ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      }

      if (Number.isFinite(meX) && Number.isFinite(meY)) {
        const me = worldToMapCentered(meX, meY, centerX, centerY, state.viewSpan);
        state.ctx.fillStyle = '#71ff68';
        state.ctx.beginPath();
        state.ctx.arc(me.x, me.y, 4, 0, Math.PI * 2);
        state.ctx.fill();
      }

    state.ctx.fillStyle = 'rgba(255,255,255,.9)';
    state.ctx.font = '10px monospace';
    state.ctx.fillText(`p:${state.players.size} chars:${getCharacters().length} span:${Math.round(state.viewSpan)}`, 6, SIZE - 8);

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
    window.__minimapDump = () => {
      try {
        logMapDiscovery();
        logMapContentDeep();
      } catch (err) {
        console.error('[minimap-test] __minimapDump error', err);
      }
    };
    console.log('[minimap-test] debug helper available: window.__minimapDump()');

    state.pollId = window.setInterval(async () => {
      // Always re-check stores until we have a real playable scene.
      const candidateStores = findStoresFromWindow() || (() => { try { return null; } catch (_) { return null; } })();
      if (!state.stores && candidateStores && !isPlayableSceneReady(candidateStores)) {
        console.log('[minimap-test] ignoring early stores (scene not ready yet)');
      }

      if (!state.stores || !isPlayableSceneReady(state.stores)) {
        state.stores = candidateStores || state.stores;
        if ((!state.stores || !isPlayableSceneReady(state.stores))) {
          try {
            const imported = await tryExposeStoresFromBundle();
            if (imported) state.stores = imported;
          } catch (_) {}
        }

        if (state.stores && isPlayableSceneReady(state.stores)) {
          state.worldBounds = deriveDynamicBounds() || getWorldBounds(state.stores);
          console.log('[minimap-test] stores found (playable scene)', { worldBounds: state.worldBounds });
          logMapDiscovery();
          logMapContentDeep();
          buildTerrainCache();
        }
      }

      if (state.stores && isPlayableSceneReady(state.stores) && !state.terrainCanvas) {
        state.worldBounds = deriveDynamicBounds() || state.worldBounds;
        buildTerrainCache();
      }

      if (state.stores && isPlayableSceneReady(state.stores) && !state.room) {
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
