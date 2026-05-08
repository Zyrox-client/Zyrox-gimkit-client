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


  const logMapDiscovery = () => {
    const scene = state.stores?.phaser?.scene;
    const terrain = scene?.worldManager?.terrain;
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
  };


  const collectPointsFromAny = (root, limit = 15000) => {
    const out = [];
    const seen = new Set();
    const stack = [root];
    while (stack.length && out.length < limit) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);

      if (Number.isFinite(cur.x) && Number.isFinite(cur.y)) {
        out.push({ x: Number(cur.x), y: Number(cur.y), w: Number(cur.width || cur.w || 0), h: Number(cur.height || cur.h || 0) });
      }
      if (Number.isFinite(cur.pixelX) && Number.isFinite(cur.pixelY)) {
        out.push({ x: Number(cur.pixelX), y: Number(cur.pixelY), w: Number(cur.width || cur.w || 0), h: Number(cur.height || cur.h || 0) });
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
    return { x: minX - pad, y: minY - pad, width: Math.max(500, maxX - minX + pad * 2), height: Math.max(500, maxY - minY + pad * 2) };
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

    // Draw tilemap layers if present (best minimap approximation of map geometry).
    const maybeLayers = [];
    let drawnTiles = 0;
    const displayList = scene?.children?.list || [];
    for (const obj of displayList) {
      if (obj?.layer?.data && Number.isFinite(obj?.tilemap?.tileWidth) && Number.isFinite(obj?.tilemap?.tileHeight)) maybeLayers.push(obj);
    }

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
          drawnTiles += 1;
        }
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
    console.log('[minimap-test] terrain cache built', { layerCandidates: maybeLayers.length, drawnTiles, drawnTerrainPoints, drawnDevices });
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

    state.ctx.fillStyle = 'rgba(255,255,255,.9)';
    state.ctx.font = '10px monospace';
    state.ctx.fillText(`p:${state.players.size} chars:${getCharacters().length}`, 6, SIZE - 8);

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
