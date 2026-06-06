// ==UserScript==
// @name         Gimkit Live Map Overlay
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Live interactive minimap overlay for Gimkit game modes. Press M to toggle.
// @author       You
// @match        https://www.gimkit.com/*
// @match        https://gimkit.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG  — tweak these to change behaviour
// ─────────────────────────────────────────────────────────────────────────────
const CFG = {
  TOGGLE_KEY:      'm',   // Key that opens/closes the map
  REFRESH_MS:      25,    // Redraw interval (ms) while map is open
  TILE_PX:         5,     // Canvas pixels per tile at zoom 1.0×
  DEFAULT_ZOOM:    4,     // Minimap starts close-up and follows the player
  MIN_ZOOM:        0.5,
  MAX_ZOOM:        12,
  ZOOM_STEP:       0.5,
  DEFAULT_W:       320,   // Fixed minimap panel width (px)
  DEFAULT_H:       280,   // Fixed minimap panel height (px)
  LS_POS:          'gk_map_pos',   // localStorage key for window position
  LS_ZOOM:         'gk_map_zoom_v2',  // localStorage key for zoom level
  PLAYER_R:        4,     // Player dot radius (px)
  OTHER_PLAYER_R:  3.5,   // Other player dot radius (px)
  DEVICE_R:        3,     // Device/object marker radius (px)
  DEVICE_ICON_PX:  14,    // Device texture thumbnail size (px)
  DEVICE_LIMIT:    450,   // Safety cap for drawing map objects each frame
  PHASER_TILE_PX:  50,    // Phaser world-pixels per terrain tile (fallback)
  INIT_WAIT_MS:    20_000, // How long to wait for game stores before giving up
  SMOOTH_MS:       140,   // Camera smoothing time constant for player-follow
};

// ─────────────────────────────────────────────────────────────────────────────
// TERRAIN COLOUR TABLE
// Maps terrain name (from tile.terrain) → CSS hex fill colour.
// Unknown terrains fall back to COLOUR_FALLBACK.
// ─────────────────────────────────────────────────────────────────────────────
const TERRAIN_COLOUR = {
  // Grass family
  'Grass':           '#4a7c3f',
  'Dark Grass':      '#2d5a27',
  'Light Grass':     '#6ab04c',
  'Dry Grass':       '#a9944a',
  'Snowy Grass':     '#abcbd8',
  // Ground / paths
  'Dirt':            '#8b6340',
  'Sand':            '#d4b483',
  'Gravel':          '#8a8a8a',
  'Stone':           '#7a7a7a',
  'Stone Path':      '#9e9e9e',
  'Path':            '#b5a080',
  'Cobblestone':     '#6e6e6e',
  // Water / frozen
  'Water':           '#2a6db5',
  'Deep Water':      '#1a4d8a',
  'Ice':             '#aee3f5',
  'Frozen Lake':     '#73d8ff',
  'Snow':            '#eef7ff',
  // Hot / space
  'Lava':            '#e85c1a',
  'Void':            '#111111',
  'Space':           '#0a0a1e',
  // Wood / planks
  'Wood':            '#7c5c34',
  'Planks':          '#a07840',
  'Dark Wood':       '#5a3e22',
  // Wall / solid
  'Wall':            '#3a3a3a',
  'Brick':           '#8b3a2a',
  'Stone Wall':      '#5a5a5a',
  'Metal':           '#6a7a8a',
  'Steel':           '#7a8a9a',
  'Default':         '#556b2f',
};
const COLOUR_FALLBACK = '#4e5566';           // Used when terrain name is unknown
const COLOUR_COLLIDE  = 'rgba(255,65,65,0.38)'; // Tinted overlay for solid tiles

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/** Promise-based sleep. */
const delay = (ms) => new Promise(r => setTimeout(r, ms));

/** Return the real page window when userscript managers expose one. */
const gameWindow = () => (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

let storesPromise = null;

/**
 * Gimkit does not expose `stores` on the page window by default. Mirror the
 * loader used by the Zyrox client: find the game module, import the
 * FixSpinePlugin bundle, then publish the export that contains `assignment`.
 */
async function exposeStores() {
  const root = gameWindow();
  if (root.stores) return root.stores;
  if (storesPromise) return storesPromise;

  storesPromise = (async () => {
    if (!document.body) {
      await new Promise((resolve) => window.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }

    const moduleScript = document.querySelector("script[src][type='module']");
    if (!moduleScript?.src) throw new Error('Failed to find game module script');

    const response = await fetch(moduleScript.src);
    const text = await response.text();
    const gameScriptPath =
      text.match(/["'](\/assets\/FixSpinePlugin-[^"']+\.js(?:\?[^"']*)?)["']/)?.[1]
      ?? text.match(/FixSpinePlugin-[^.]+\.js(?:\?\S+)?/)?.[0];
    if (!gameScriptPath) throw new Error('Failed to find game script URL');

    const gameAssetUrl = gameScriptPath.startsWith('http')
      ? gameScriptPath
      : new URL(gameScriptPath.startsWith('/') ? gameScriptPath : `/assets/${gameScriptPath}`, moduleScript.src).href;
    const gameScript = await import(/* webpackIgnore: true */ gameAssetUrl);
    const stores = Object.values(gameScript).find((value) => value && value.assignment);
    if (!stores) throw new Error('Failed to resolve stores export');

    root.stores = stores;
    console.log('[GimkitMap] stores exposed via module import');
    return stores;
  })();

  try {
    return await storesPromise;
  } catch (error) {
    storesPromise = null;
    throw error;
  }
}

/**
 * Read a deeply-nested property without throwing.
 * E.g. safeGet(gameWindow(), ['stores','world','terrain','tiles'])
 */
function safeGet(root, path) {
  try { return path.reduce((o, k) => (o == null ? undefined : o[k]), root); }
  catch { return undefined; }
}

/** localStorage helpers — silently swallow quota / parse errors. */
const lsGet = (k, fb) => {
  try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : fb; }
  catch { return fb; }
};
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };


/** Parse the map-options payload and return its configured background terrain. */
function backgroundTerrainFromOptions(options) {
  if (!options) return null;
  try {
    const parsed = typeof options === 'string' ? JSON.parse(options) : options;
    return typeof parsed?.backgroundTerrain === 'string' ? parsed.backgroundTerrain : null;
  } catch {
    return null;
  }
}

/**
 * Locate Gimkit's mapOptionsJSON payload, then read backgroundTerrain from it.
 * The Snow map exposes this as { "backgroundTerrain": "Snow" }.
 */
function findBackgroundTerrain() {
  const candidates = [
    safeGet(gameWindow(), ['mapOptionsJSON']),
    safeGet(gameWindow(), ['stores', 'world', 'mapOptionsJSON']),
    safeGet(gameWindow(), ['stores', 'world', 'map', 'mapOptionsJSON']),
    safeGet(gameWindow(), ['stores', 'world', 'map', 'options']),
    safeGet(gameWindow(), ['stores', 'world', 'mapOptions']),
  ];

  for (const candidate of candidates) {
    const terrain = backgroundTerrainFromOptions(candidate);
    if (terrain) return terrain;
    if (typeof candidate?.backgroundTerrain === 'string') return candidate.backgroundTerrain;
  }

  return 'Snow';
}

/** Match terrain names even if the game changes capitalization slightly. */
function terrainKey(name) {
  if (typeof name !== 'string') return null;
  if (TERRAIN_COLOUR[name]) return name;
  const lower = name.toLowerCase();
  return Object.keys(TERRAIN_COLOUR).find((key) => key.toLowerCase() === lower) ?? null;
}

/** Return the fill colour for the global map background. */
const backgroundColour = () => TERRAIN_COLOUR[terrainKey(findBackgroundTerrain())] ?? TERRAIN_COLOUR.Snow;

/** Return the first finite number from a list of possible values. */
function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

/** Pull a useful terrain name out of Gimkit terrain schemas/objects. */
function terrainName(tile) {
  const terrain = tile?.terrain ?? tile?.type ?? tile?.name ?? tile?.terrainName ?? tile?.tileType;
  if (typeof terrain === 'string') return terrain;
  if (typeof terrain?.name === 'string') return terrain.name;
  if (typeof terrain?.id === 'string') return terrain.id;
  if (typeof terrain?.key === 'string') return terrain.key;
  return null;
}

/** Return the fill colour for a tile object. */
const tileColour = (t) => TERRAIN_COLOUR[terrainKey(terrainName(t))] ?? COLOUR_FALLBACK;

/** Keep frozen water blue even when Gimkit marks it as collidable. */
const shouldDrawCollision = (t) => Boolean(t?.collides ?? t?.collision ?? t?.solid) && terrainKey(terrainName(t)) !== 'Frozen Lake';

/** Read object-space coordinates directly from a tile-like object. */
function objectTileCoords(tile) {
  const x = firstFiniteNumber(tile?.x, tile?.tileX, tile?.gridX, tile?.col, tile?.column, tile?.position?.x, tile?.pos?.x);
  const y = firstFiniteNumber(tile?.y, tile?.tileY, tile?.gridY, tile?.row, tile?.position?.y, tile?.pos?.y);
  return x != null && y != null ? { x, y } : null;
}

/** Read authoritative grid coordinates from common keyed terrain maps. */
function keyTileCoords(key) {
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (!trimmed || !/[,:|;_\s]/.test(trimmed)) return null;
  const match = trimmed.match(/-?\d+(?:\.\d+)?/g);
  if (match?.length !== 2) return null;
  const x = Number(match[0]);
  const y = Number(match[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Read tile coordinates from the collection key first, then the tile schema. */
function tileCoords(tile, key) {
  return keyTileCoords(key) ?? objectTileCoords(tile);
}

/** Unwrap MobX ObservableValue wrappers used inside ObservableMap.data_. */
function unwrapObservableValue(value) {
  if (value?.value_ && (value.name_ || value.observers_ || value.enhancer || value.equals)) return value.value_;
  return value;
}

/** Iterate normal Maps, MobX ObservableMaps, Colyseus MapSchemas, arrays, and plain keyed objects. */
function tileEntries(tiles) {
  if (!tiles) return [];
  const source = tiles.$items instanceof Map
    ? tiles.$items
    : (tiles.data_ instanceof Map ? tiles.data_ : tiles);
  const normalize = ([key, value]) => [key, unwrapObservableValue(value)];
  if (source instanceof Map || typeof source?.entries === 'function') return Array.from(source.entries(), normalize);
  if (Array.isArray(source)) return source.map((tile, index) => [index, unwrapObservableValue(tile)]);
  if (typeof source === 'object') return Object.entries(source).map(normalize);
  return [];
}

/** Normalize Gimkit's terrain collection into renderable tile records. */
function normalizeTiles(tiles) {
  const normalized = [];
  for (const [key, tile] of tileEntries(tiles)) {
    const coords = tileCoords(tile, key);
    if (!coords) continue;
    const objectCoords = objectTileCoords(tile);
    normalized.push({
      ...tile,
      x: coords.x,
      y: coords.y,
      __rawX: objectCoords?.x,
      __rawY: objectCoords?.y,
      __usedKeyCoords: keyTileCoords(key) != null,
    });
  }
  return normalized;
}

/** Estimate how Phaser/world pixels map onto rendered terrain tile coordinates. */
function inferWorldToMapTransform(tiles) {
  const keyed = tiles.filter((tile) => tile.__usedKeyCoords
    && Number.isFinite(tile.__rawX)
    && Number.isFinite(tile.__rawY)
    && (Math.abs(tile.__rawX - tile.x) > 1 || Math.abs(tile.__rawY - tile.y) > 1));
  if (keyed.length < 2) return { scale: CFG.PHASER_TILE_PX, scaleX: CFG.PHASER_TILE_PX, scaleY: CFG.PHASER_TILE_PX, offsetX: 0, offsetY: 0 };

  // Fit raw = scale * map + intercept using the actual paired coordinates.
  // This is more reliable than min/max when maps use negative tile positions or
  // when the world origin is not near the map origin.
  const fitAxis = (mapKey, rawKey) => {
    const points = keyed
      .map((tile) => ({ map: Number(tile[mapKey]), raw: Number(tile[rawKey]) }))
      .filter((point) => Number.isFinite(point.map) && Number.isFinite(point.raw));
    const n = points.length;
    if (n < 2) return null;
    const meanMap = points.reduce((sum, point) => sum + point.map, 0) / n;
    const meanRaw = points.reduce((sum, point) => sum + point.raw, 0) / n;
    const variance = points.reduce((sum, point) => sum + (point.map - meanMap) ** 2, 0);
    if (variance <= 0) return null;
    const covariance = points.reduce((sum, point) => sum + (point.map - meanMap) * (point.raw - meanRaw), 0);
    const scale = covariance / variance;
    if (!Number.isFinite(scale) || Math.abs(scale) <= 1) return null;
    const intercept = meanRaw - scale * meanMap;
    return { scale, offset: -intercept / scale };
  };

  const xFit = fitAxis('x', '__rawX');
  const yFit = fitAxis('y', '__rawY');
  const usableScales = [xFit?.scale, yFit?.scale].filter((scale) => Number.isFinite(scale) && Math.abs(scale) > 1);
  const scale = usableScales.length
    ? usableScales.reduce((sum, value) => sum + Math.abs(value), 0) / usableScales.length
    : CFG.PHASER_TILE_PX;
  const scaleX = xFit?.scale ?? scale;
  const scaleY = yFit?.scale ?? scale;
  return {
    scale,
    scaleX,
    scaleY,
    offsetX: xFit?.offset ?? 0,
    offsetY: yFit?.offset ?? 0,
  };
}

/** Return raw Phaser/world-space coordinates for a point/body. */
function phaserPointToWorld(point, rotation = 0) {
  if (point?.x == null || point?.y == null) return null;
  const w = point.width ?? point.w ?? 0;
  const h = point.height ?? point.h ?? 0;
  return { x: point.x + w / 2, y: point.y + h / 2, rotation, worldSpace: true };
}

/** Return Phaser body origin coordinates; character markers use these in Gimkit's renderer. */
function phaserBodyOrigin(body, rotation = 0) {
  if (body?.x == null || body?.y == null) return null;
  return { x: Number(body.x), y: Number(body.y), rotation, worldSpace: true };
}


/** Return useful character coordinates from Phaser/Gimkit objects. */
function characterPosition(character) {
  const point = character?.body?.center ?? character?.body?.position ?? character?.position ?? character?.body ?? character;
  const raw = phaserPointToWorld(point, character?.rotation ?? character?.body?.rotation ?? ((character?.angle ?? 0) * Math.PI / 180));
  return raw ? { ...raw, worldSpace: true } : null;
}

/** Return a stable ID from the common player/character schemas. */
function characterId(character, fallback = null) {
  return character?.id ?? character?.characterId ?? character?.playerId ?? character?.entityId ?? fallback;
}

/** Return a display name from common player/character schemas. */
function characterName(character, fallback = '') {
  return character?.nametag?.name
    ?? character?.name
    ?? character?.nickname
    ?? character?.displayName
    ?? character?.username
    ?? character?.state?.name
    ?? fallback;
}

/** Return a team identifier when Gimkit exposes one. */
function characterTeam(character) {
  return character?.teamId ?? character?.team?.id ?? character?.state?.teamId ?? character?.data?.teamId ?? null;
}

/** Iterate Phaser's character manager as [{ id, character }]. */
function characterEntries() {
  const stores = safeGet(gameWindow(), ['stores']);
  const manager = stores?.phaser?.scene?.characterManager;
  const map = manager?.characters;
  if (!map) return [];
  if (typeof map.entries === 'function') return Array.from(map.entries(), ([id, character]) => ({ id, character }));
  if (Array.isArray(map)) return map.map((character, index) => ({ id: characterId(character, index), character }));
  if (typeof map === 'object') return Object.entries(map).map(([id, character]) => ({ id, character }));
  return [];
}

/** Return the local player/character ID when Gimkit exposes it. */
function localPlayerId() {
  const stores = safeGet(gameWindow(), ['stores']);
  return stores?.phaser?.mainCharacter?.id
    ?? stores?.world?.localPlayerId
    ?? stores?.world?.myPlayerId
    ?? stores?.me?.id
    ?? stores?.me?.playerId
    ?? null;
}

/** Return the local player's team when available. */
function localPlayerTeam() {
  const stores = safeGet(gameWindow(), ['stores']);
  const mainId = localPlayerId();
  if (mainId != null) {
    const match = characterEntries().find(({ id, character }) => String(id ?? characterId(character)) === String(mainId));
    const team = characterTeam(match?.character);
    if (team != null) return team;
  }
  return characterTeam(stores?.phaser?.mainCharacter) ?? characterTeam(stores?.me);
}

/** Collect non-local players to render on the minimap. */
function findOtherPlayers() {
  const localId = localPlayerId();
  const players = [];
  const seen = new Set();
  const directPosition = (source) => (source?.x != null && source?.y != null
    ? { x: Number(source.x), y: Number(source.y), rotation: source.rotation ?? 0 }
    : null);
  const phaserBodyPosition = (source) => (source?.body?.x != null && source?.body?.y != null
    ? { x: Number(source.body.x), y: Number(source.body.y), rotation: source.rotation ?? source.body.rotation ?? 0, worldSpace: true }
    : null);
  const add = (id, source, fallbackName = '', preferPhaser = true) => {
    // Match the working player-position logic from tests/example.js: iterate
    // phaser.scene.characterManager.characters and use each player's body.x/y.
    const pos = preferPhaser
      ? (phaserBodyPosition(source) ?? characterPosition(source) ?? directPosition(source))
      : (directPosition(source) ?? phaserBodyPosition(source) ?? characterPosition(source));
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    const resolvedId = characterId(source, id);
    const key = String(resolvedId ?? `${pos.x}:${pos.y}`);
    if (localId != null && key === String(localId)) return;
    if (seen.has(key)) return;
    seen.add(key);
    players.push({ ...pos, id: resolvedId, name: characterName(source, fallbackName), teamId: characterTeam(source) });
  };

  for (const { id, character } of characterEntries()) add(id, character, String(id ?? ''));

  const worldPlayers = safeGet(gameWindow(), ['stores', 'world', 'players']);
  for (const [id, player] of tileEntries(worldPlayers)) add(id, player, String(id ?? ''), false);

  return players;
}

/** Pull raw coordinates out of device/object-like records. */
function devicePosition(device) {
  const candidates = [
    device?.body?.center,
    device?.body?.position,
    device?.physicsBody?.center,
    device?.physicsBody?.position,
    device?.position,
    device?.pos,
    device?.transform,
    device?.state,
    device?.body,
    device?.physicsBody,
    device?.sprite,
    device?.displayObject,
    device?.container,
    device,
  ];
  for (const candidate of candidates) {
    const point = phaserPointToWorld(candidate, device?.rotation ?? device?.body?.rotation ?? 0);
    if (point) return { ...point, worldSpace: true };
  }
  return null;
}

/** Return device/object collections from likely Gimkit state paths. */
function deviceCollections() {
  const root = gameWindow();
  return [
    safeGet(root, ['stores', 'phaser', 'scene', 'worldManager', 'devices', 'allDevices']),
    safeGet(root, ['stores', 'phaser', 'scene', 'worldManager', 'devices', 'devices']),
    safeGet(root, ['stores', 'world', 'devices']),
    safeGet(root, ['stores', 'world', 'devices', 'devices']),
    safeGet(root, ['stores', 'world', 'devices', 'devices', 'data_']),
    safeGet(root, ['stores', 'world', 'objects']),
    safeGet(root, ['serializer', 'state', 'devices', '$items']),
    safeGet(root, ['serializer', 'state', 'objects', '$items']),
  ].filter(Boolean);
}


/** Return a useful device/object type label from world.devices device schemas. */
function deviceKind(device) {
  return device?.options?.propId
    ?? device?.deviceOption?.id
    ?? device?.type
    ?? device?.kind
    ?? device?.key
    ?? device?.options?.type
    ?? device?.options?.group
    ?? 'device';
}

/** Return a display label for a device/object marker. */
function deviceName(device) {
  return device?.name
    ?? device?.label
    ?? device?.options?.name
    ?? device?.options?.label
    ?? device?.options?.propId
    ?? device?.deviceOption?.id
    ?? '';
}


/** Return raw device entries from every known device collection for debugging. */
function rawDeviceEntries() {
  const entries = [];
  const seen = new Set();
  for (const collection of deviceCollections()) {
    for (const [id, device] of tileEntries(collection)) {
      if (!device) continue;
      const resolvedId = device?.id ?? device?.deviceId ?? id ?? entries.length;
      const key = String(resolvedId);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ id: resolvedId, device });
    }
  }
  return entries;
}

/** Return Phaser's texture manager when the active scene exposes one. */
function phaserTextureManager() {
  return safeGet(gameWindow(), ['stores', 'phaser', 'scene', 'textures'])
    ?? safeGet(gameWindow(), ['stores', 'phaser', 'scene', 'sys', 'textures'])
    ?? safeGet(gameWindow(), ['stores', 'phaser', 'scene', 'game', 'textures'])
    ?? safeGet(gameWindow(), ['game', 'textures'])
    ?? safeGet(gameWindow(), ['_phaserGame', 'textures'])
    ?? null;
}

/** Extract all known texture keys from Phaser's texture manager. */
function phaserTextureKeys(filter = '') {
  const textures = phaserTextureManager();
  const lower = String(filter ?? '').toLowerCase();
  let keys = [];
  if (textures?.list && typeof textures.list === 'object') keys = Object.keys(textures.list);
  else if (textures?.keys && typeof textures.keys === 'object') keys = Object.keys(textures.keys);
  else if (typeof textures?.getTextureKeys === 'function') keys = textures.getTextureKeys();
  else if (typeof textures?.each === 'function') {
    textures.each((texture) => { if (texture?.key) keys.push(texture.key); });
  }
  return [...new Set(keys)].filter((key) => !lower || String(key).toLowerCase().includes(lower)).sort();
}

/** Read a probable image/source URL from a Phaser texture object. */
function textureSourceUrl(texture) {
  const sources = [
    texture?.source?.[0]?.image,
    texture?.source?.image,
    texture?.dataSource?.[0]?.image,
    texture?.dataSource?.image,
    texture?.frames?.__BASE?.source?.image,
  ];
  for (const image of sources) {
    const url = image?.currentSrc ?? image?.src ?? image?.dataset?.src;
    if (url) return url;
  }
  return null;
}

/** Inspect a Phaser texture key and return source/frame information. */
function inspectTexture(key) {
  const textures = phaserTextureManager();
  const texture = typeof textures?.get === 'function' ? textures.get(key) : textures?.list?.[key] ?? textures?.keys?.[key];
  if (!texture) return null;
  return {
    key,
    source: textureSourceUrl(texture),
    frameNames: texture?.frames ? Object.keys(texture.frames).slice(0, 50) : [],
    raw: texture,
  };
}

/** Walk likely render objects on a device and collect texture/frame references. */
function deviceTextureRefs(device, maxDepth = 4) {
  const refs = [];
  const seen = new Set();
  const visit = (value, path, depth) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || depth > maxDepth || seen.has(value)) return;
    seen.add(value);

    const textureKey = value?.texture?.key ?? value?.textureKey ?? value?.key;
    const frameName = value?.frame?.name ?? value?.frame?.key ?? value?.frameKey;
    if (textureKey && (value?.texture || value?.frame || /sprite|image|texture|frame/i.test(path))) {
      refs.push({ path, textureKey, frameName, object: value });
    }

    const childCollections = [value.list, value.children?.entries, value.children?.list, value.sprites, value.images];
    for (const collection of childCollections) {
      if (Array.isArray(collection)) collection.forEach((child, index) => visit(child, `${path}.children[${index}]`, depth + 1));
    }

    for (const key of ['sprite', 'image', 'body', 'container', 'displayObject', 'gameObject', 'object', 'view', 'renderer']) {
      if (value[key]) visit(value[key], `${path}.${key}`, depth + 1);
    }
  };
  visit(device, 'device', 0);
  return refs;
}


/** Return a concrete image/crop asset for a Phaser texture/frame pair. */
function textureAsset(texture, frameName = null) {
  if (!texture) return null;
  const frames = texture.frames ?? {};
  const frame = frameName != null && frames[frameName]
    ? frames[frameName]
    : (texture?.firstFrame && frames[texture.firstFrame] ? frames[texture.firstFrame] : frames.__BASE);
  const image = frame?.source?.image
    ?? texture?.source?.[frame?.sourceIndex ?? 0]?.image
    ?? texture?.source?.[0]?.image
    ?? texture?.source?.image
    ?? texture?.dataSource?.[0]?.image
    ?? texture?.dataSource?.image
    ?? null;
  if (!image) return null;
  const sw = Number(frame?.cutWidth ?? frame?.width ?? image.naturalWidth ?? image.width);
  const sh = Number(frame?.cutHeight ?? frame?.height ?? image.naturalHeight ?? image.height);
  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) return null;
  return {
    image,
    sx: Number(frame?.cutX ?? frame?.x ?? 0) || 0,
    sy: Number(frame?.cutY ?? frame?.y ?? 0) || 0,
    sw,
    sh,
    textureKey: texture.key ?? null,
    frameName: frame?.name ?? frameName ?? null,
  };
}

/** Return a concrete image/crop asset from a Phaser Sprite/Image-like object. */
function textureAssetFromObject(value) {
  if (!value || typeof value !== 'object') return null;
  const texture = value.texture
    ?? (value.textureKey ? (typeof phaserTextureManager()?.get === 'function' ? phaserTextureManager().get(value.textureKey) : null) : null);
  const frameName = value.frame?.name ?? value.frame?.key ?? value.frameKey ?? null;
  const direct = textureAsset(texture, frameName);
  if (direct) return direct;
  const image = value.image ?? value.canvas ?? value.source?.image ?? value.source?.[0]?.image ?? null;
  if (!image) return null;
  const sw = Number(image.naturalWidth ?? image.width);
  const sh = Number(image.naturalHeight ?? image.height);
  return Number.isFinite(sw) && Number.isFinite(sh) && sw > 0 && sh > 0
    ? { image, sx: 0, sy: 0, sw, sh, textureKey: value.key ?? null, frameName: null }
    : null;
}

/** Search Phaser textures by possible device/prop labels as a fallback. */
function findTextureAssetByDeviceName(device) {
  const textures = phaserTextureManager();
  if (!textures) return null;
  const labels = [
    device?.options?.propId,
    device?.deviceOption?.id,
    device?.name,
    device?.label,
    device?.options?.name,
    device?.options?.label,
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  if (!labels.length) return null;

  for (const key of phaserTextureKeys()) {
    const lowerKey = String(key).toLowerCase();
    if (!labels.some((label) => lowerKey.includes(label) || label.includes(lowerKey))) continue;
    const texture = typeof textures.get === 'function' ? textures.get(key) : textures.list?.[key] ?? textures.keys?.[key];
    const asset = textureAsset(texture);
    if (asset) return asset;
  }
  return null;
}

const deviceTextureAssetCache = new WeakMap();

/** Find the image/crop that Phaser is using to render a device, if available. */
function deviceTextureAsset(device) {
  if (device && typeof device === 'object' && deviceTextureAssetCache.has(device)) return deviceTextureAssetCache.get(device);
  for (const ref of deviceTextureRefs(device, 5)) {
    const direct = textureAssetFromObject(ref.object);
    if (direct) {
      if (device && typeof device === 'object') deviceTextureAssetCache.set(device, direct);
      return direct;
    }
    const inspected = inspectTexture(ref.textureKey)?.raw;
    const fromKey = textureAsset(inspected, ref.frameName);
    if (fromKey) {
      if (device && typeof device === 'object') deviceTextureAssetCache.set(device, fromKey);
      return fromKey;
    }
  }
  const asset = textureAssetFromObject(device)
    ?? textureAssetFromObject(device?.sprite)
    ?? textureAssetFromObject(device?.image)
    ?? textureAssetFromObject(device?.displayObject)
    ?? textureAssetFromObject(device?.container)
    ?? findTextureAssetByDeviceName(device);
  if (asset && device && typeof device === 'object') deviceTextureAssetCache.set(device, asset);
  return asset;
}

/** Build a concise device→texture report for console debugging. */
function deviceTextureReport(filter = '', limit = 25) {
  const lower = String(filter ?? '').toLowerCase();
  const rows = [];
  for (const { id, device } of rawDeviceEntries()) {
    const kind = deviceKind(device);
    const name = deviceName(device);
    const searchable = `${id} ${kind} ${name}`.toLowerCase();
    if (lower && !searchable.includes(lower)) continue;
    rows.push({
      id,
      kind,
      name,
      propId: device?.options?.propId ?? null,
      deviceOptionId: device?.deviceOption?.id ?? null,
      textureAsset: (() => {
        const asset = deviceTextureAsset(device);
        return asset ? { textureKey: asset.textureKey, frameName: asset.frameName, source: asset.image?.currentSrc ?? asset.image?.src ?? null } : null;
      })(),
      textures: deviceTextureRefs(device).map((ref) => ({
        path: ref.path,
        textureKey: ref.textureKey,
        frameName: ref.frameName,
        source: inspectTexture(ref.textureKey)?.source ?? null,
      })),
      raw: device,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** Expose console helpers for investigating device texture links in DevTools. */
function installDebugHelpers() {
  const root = gameWindow();
  root.GimkitMapDebug = {
    stores: () => safeGet(root, ['stores']),
    rawDeviceEntries,
    devices: findDevices,
    deviceTextureRefs,
    deviceTextureAsset,
    deviceTextureReport,
    textureKeys: phaserTextureKeys,
    inspectTexture,
    textureManager: phaserTextureManager,
  };
  console.log('[GimkitMap] Debug helpers installed on window.GimkitMapDebug');
  console.log('[GimkitMap] Try: GimkitMapDebug.deviceTextureReport("snow", 10)');
  console.log('[GimkitMap] Try: GimkitMapDebug.textureKeys("snow").map(GimkitMapDebug.inspectTexture)');
}

/** Collect map objects/devices such as trees, stations, barriers, and pickups. */
function findDevices() {
  const devices = [];
  const seen = new Set();
  for (const collection of deviceCollections()) {
    for (const [id, device] of tileEntries(collection)) {
      if (!device) continue;
      const pos = devicePosition(device);
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      const resolvedId = device?.id ?? device?.deviceId ?? id ?? `${pos.x}:${pos.y}`;
      const key = String(resolvedId);
      if (seen.has(key)) continue;
      seen.add(key);
      devices.push({
        ...pos,
        id: resolvedId,
        kind: deviceKind(device),
        name: deviceName(device),
        textureAsset: deviceTextureAsset(device),
      });
      if (devices.length >= CFG.DEVICE_LIMIT) return devices;
    }
  }
  return devices;
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER POSITION FINDER
// Probes several known Gimkit / Phaser state paths.
// Returns { x, y, rotation } in the source coordinate space, or null.
// ─────────────────────────────────────────────────────────────────────────────
function findPlayer() {
  // ── Probe 0: exposed Zyrox/Gimkit Phaser main character ───────────────────
  try {
    const main = safeGet(gameWindow(), ['stores', 'phaser', 'mainCharacter']);
    const rotation = main?.rotation ?? main?.body?.rotation ?? ((main?.angle ?? 0) * Math.PI / 180);
    const player = phaserBodyOrigin(main?.body, rotation)
      ?? phaserPointToWorld(main?.body?.center ?? main?.body?.position ?? main?.body ?? main, rotation);
    if (player) return player;
  } catch {}

  // ── Probe 1: Phaser character manager body for the local character ─────────
  try {
    const stores = safeGet(gameWindow(), ['stores']);
    const phaser = stores?.phaser;
    const mainId = phaser?.mainCharacter?.id;
    const characters = phaser?.scene?.characterManager?.characters;
    const managed = mainId != null && typeof characters?.get === 'function'
      ? characters.get(mainId)
      : null;
    const body = managed?.body ?? managed ?? phaser?.mainCharacter?.body;
    const rotation = managed?.rotation ?? body?.rotation ?? phaser?.mainCharacter?.rotation ?? ((managed?.angle ?? phaser?.mainCharacter?.angle ?? 0) * Math.PI / 180);
    const player = phaserBodyOrigin(body, rotation)
      ?? phaserPointToWorld(body?.center ?? body?.position ?? body, rotation);
    if (player) return player;
  } catch {}

  // ── Probe 2: stores.me / local user model ─────────────────────────────────
  try {
    const me = safeGet(gameWindow(), ['stores', 'me']);
    if (me?.x != null || me?.position?.x != null || me?.body?.x != null) {
      const player = phaserBodyOrigin(me?.body, me?.rotation ?? 0)
        ?? phaserPointToWorld(me?.body ?? me?.position ?? me, me?.rotation ?? 0);
      if (player) return player;
    }
  } catch {}

  // ── Probe 3: world.players Map + local player ID ──────────────────────────
  try {
    const players = safeGet(gameWindow(), ['stores', 'world', 'players']);
    if (players instanceof Map && players.size > 0) {
      const id = safeGet(gameWindow(), ['stores', 'world', 'localPlayerId'])
              ?? safeGet(gameWindow(), ['stores', 'world', 'myPlayerId']);
      const p  = id ? players.get(id) : players.values().next().value;
      if (p?.x != null) return { x: p.x, y: p.y, rotation: p.rotation ?? 0 };
    }
  } catch {}

  // ── Probe 4: direct character / local-character object ────────────────────
  try {
    const c = safeGet(gameWindow(), ['stores', 'world', 'character'])
           ?? safeGet(gameWindow(), ['stores', 'world', 'localCharacter'])
           ?? safeGet(gameWindow(), ['stores', 'world', 'myCharacter']);
    if (c?.x != null) return { x: c.x, y: c.y, rotation: c.rotation ?? 0 };
  } catch {}

  // ── Probe 5: generic entities Map — look for isLocal flag ─────────────────
  try {
    const entities = safeGet(gameWindow(), ['stores', 'world', 'entities']);
    if (entities instanceof Map) {
      for (const e of entities.values()) {
        if ((e.isLocal || e.isLocalPlayer || e.local) && e.x != null)
          return { x: e.x, y: e.y, rotation: e.rotation ?? 0 };
      }
    }
  } catch {}

  // ── Probe 6: Phaser scene player object (world-pixel → tile coords) ────────
  try {
    const scenes = safeGet(gameWindow(), ['game', 'scene', 'scenes'])
                ?? safeGet(gameWindow(), ['_phaserGame', 'scene', 'scenes']);
    if (Array.isArray(scenes)) {
      for (const s of scenes) {
        const p = s.player ?? s.localPlayer ?? s.character;
        if (p?.x != null) {
          return { x: p.x, y: p.y, rotation: p.rotation ?? 0, worldSpace: true };
        }
      }
    }
  } catch {}

  return null; // Player not found — marker will simply not be drawn
}

// ─────────────────────────────────────────────────────────────────────────────
// TILE RENDERER
// Maintains a single offscreen canvas ("tile cache") with every tile drawn at
// zoom 1×, then composites it onto the visible canvas scaled to the current
// zoom level.  The cache is only rebuilt when the tile count changes.
// ─────────────────────────────────────────────────────────────────────────────
class TileRenderer {
  /**
   * @param {HTMLCanvasElement} canvas — the visible canvas inside the panel
   */
  constructor(canvas) {
    this._cv         = canvas;
    this._ctx        = canvas.getContext('2d');
    this._cache      = null;   // Offscreen canvas (1× zoom, all tiles)
    this._bounds     = null;   // { minX, minY, w, h } in tile coords
    this._knownCount = -1;     // Tile count when cache was last built
    this._smoothedFocus = null; // Last drawn player/camera focus in map coords
    this._lastFocus  = null;   // Last resolved unsmoothed player focus
    this._lastFrameT = 0;      // Timestamp used for frame-rate independent smoothing
    this._lastStats  = { tiles: 0, players: 0, devices: 0, playerPosition: null };
  }

  /**
   * Main entry point — call on every tick.
   * Rebuilds the cache only when the tile set changes.
   */
  render(zoom) {
    const tiles = safeGet(gameWindow(), ['stores', 'world', 'terrain', 'tiles']);
    const tileCount = tiles?.size ?? tiles?.$items?.size ?? tileEntries(tiles).length;
    if (!tiles || tileCount === 0) {
      this._lastStats = { tiles: 0, players: 0, devices: 0, playerPosition: null };
      this._drawWaiting();
      return;
    }

    const renderTiles = normalizeTiles(tiles);
    if (renderTiles.length === 0) {
      this._lastStats = { tiles: tileCount, players: 0, devices: 0, playerPosition: null };
      this._drawWaiting('Tile data found, but coordinates were unreadable…');
      return;
    }

    if (renderTiles.length !== this._knownCount) {
      this._buildCache(renderTiles);
      this._knownCount = renderTiles.length;
    }

    this._composite(zoom, findPlayer(), renderTiles.length);
  }

  /** Return the latest minimap discovery counts for the status bar. */
  stats() { return { ...this._lastStats }; }

  /**
   * Force a full cache rebuild on the next render call.
   * Use this after zoom changes or panel resizes.
   */
  invalidate() { this._knownCount = -1; }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Paint every tile onto an offscreen canvas at CFG.TILE_PX pixels per tile.
   * Computes map bounds in tile-coordinate space at the same time.
   */
  _buildCache(tiles) {
    // Compute bounding box
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const t of tiles) {
      if (t.x < minX) minX = t.x;  if (t.x > maxX) maxX = t.x;
      if (t.y < minY) minY = t.y;  if (t.y > maxY) maxY = t.y;
    }
    this._bounds = { minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    this._worldToMap = inferWorldToMapTransform(tiles);

    const ts  = CFG.TILE_PX;
    const off = document.createElement('canvas');
    off.width  = this._bounds.w * ts;
    off.height = this._bounds.h * ts;
    const ctx  = off.getContext('2d');

    // Paint the global terrain first; explicit tiles are drawn over it.
    ctx.fillStyle = backgroundColour();
    ctx.fillRect(0, 0, off.width, off.height);

    // Draw each tile; solid tiles get a translucent red overlay
    for (const t of tiles) {
      const px = (t.x - minX) * ts;
      const py = (t.y - minY) * ts;
      ctx.fillStyle = tileColour(t);
      ctx.fillRect(px, py, ts, ts);
      if (shouldDrawCollision(t)) {
        ctx.fillStyle = COLOUR_COLLIDE;
        ctx.fillRect(px, py, ts, ts);
      }
    }

    this._cache = off;
    console.debug(`[GimkitMap] Cache rebuilt: ${tiles.length} tiles, ` +
                  `bounds ${this._bounds.w}×${this._bounds.h} tiles`);
  }

  /**
   * Draw the cached tile image + player marker onto the visible canvas.
   * The view is centred on the player (or the map centre if player is unknown).
   */
  _composite(zoom, player, tileCount) {
    const { _cv: cv, _ctx: ctx, _cache: cache, _bounds: b } = this;
    if (!cache || !b) return;

    // Keep the canvas pixel buffer in sync with its CSS display size
    const cw = cv.parentElement?.clientWidth  || CFG.DEFAULT_W;
    const ch = cv.parentElement?.clientHeight || CFG.DEFAULT_H - 60;
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }

    const ts      = CFG.TILE_PX * zoom;          // Pixels per tile at current zoom
    const scaledW = cache.width  * zoom;
    const scaledH = cache.height * zoom;

    const targetFocus = player != null
      ? this._playerFocus(player, b, this._worldToMap)
      : this._lastFocus;
    const focusedPlayer = this._smoothFocus(targetFocus);

    // Tile-space focal point (what we want at the canvas centre). This is the
    // key minimap behavior: when the player is known, keep the fixed center
    // marker on the player's map position and slide the terrain underneath it.
    const cx = focusedPlayer != null ? (focusedPlayer.x - b.minX) : b.w / 2;
    const cy = focusedPlayer != null ? (focusedPlayer.y - b.minY) : b.h / 2;

    // Top-left corner of the scaled tile image in canvas coordinates
    const ox = cw / 2 - cx * ts;
    const oy = ch / 2 - cy * ts;

    // Background terrain fills the minimap even when explicit tiles do not
    // cover the whole viewport around the player.
    ctx.fillStyle = backgroundColour();
    ctx.fillRect(0, 0, cw, ch);

    // Tile image scaled to current zoom
    ctx.drawImage(cache, ox, oy, scaledW, scaledH);

    const devices = findDevices();
    const otherPlayers = findOtherPlayers();
    this._lastStats = {
      tiles: tileCount,
      players: otherPlayers.length,
      devices: devices.length,
      playerPosition: focusedPlayer ? { x: focusedPlayer.x, y: focusedPlayer.y } : null,
    };

    if (focusedPlayer != null) {
      const toCanvas = (point) => ({
        x: ox + (point.x - b.minX) * ts,
        y: oy + (point.y - b.minY) * ts,
      });

      // Devices/objects are drawn under players so dots stay readable.
      for (const device of devices) {
        const point = this._mapPoint(device, b, this._worldToMap);
        if (!point) continue;
        const screen = toCanvas(point);
        if (!this._isVisible(screen, cw, ch, 24)) continue;
        this._drawDevice(ctx, screen.x, screen.y, device);
      }

      const localTeam = localPlayerTeam();
      for (const other of otherPlayers) {
        const point = this._mapPoint(other, b, this._worldToMap);
        if (!point) continue;
        const screen = toCanvas(point);
        if (!this._isVisible(screen, cw, ch, 18)) continue;
        this._drawOtherPlayer(ctx, screen.x, screen.y, other, localTeam);
      }

      // Player marker is fixed in the minimap center; the map moves underneath.
      this._drawPlayer(ctx, cw / 2, ch / 2);
    }

    // Compass stays in the corner; tile count lives in the bottom status bar.
    this._drawCompass(ctx, cw - 24, 24);
  }


  /**
   * Return the best tile-space player position for minimap centering. Gimkit
   * may expose character coordinates in either tile units or Phaser pixels, so
   * prefer the representation that overlaps (or is closest to) known terrain.
   */
  _playerFocus(player, bounds, transform = { scale: CFG.PHASER_TILE_PX, offsetX: 0, offsetY: 0 }) {
    if (!player) return null;
    const best = this._mapPoint(player, bounds, transform, true);
    if (best) this._lastFocus = best;
    return best;
  }

  /** Convert raw tile/world coordinates into minimap tile coordinates. */
  _mapPoint(source, bounds, transform = { scale: CFG.PHASER_TILE_PX, offsetX: 0, offsetY: 0 }, preferPrevious = false) {
    if (!source || !Number.isFinite(Number(source.x)) || !Number.isFinite(Number(source.y))) return null;

    const margin = 3;
    const inBounds = (point) => point.x >= bounds.minX - margin
      && point.x <= bounds.minX + bounds.w + margin
      && point.y >= bounds.minY - margin
      && point.y <= bounds.minY + bounds.h + margin;

    const rotation = source.rotation ?? 0;
    const previous = preferPrevious ? (this._lastFocus ?? this._smoothedFocus) : null;
    const transforms = [];
    const addCandidate = (scaleX, offsetX = 0, offsetY = 0, label = 'scale', scaleY = scaleX) => {
      if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || Math.abs(scaleX) <= 0 || Math.abs(scaleY) <= 0) return;
      const roundedScaleX = Math.round(scaleX * 1000) / 1000;
      const roundedScaleY = Math.round(scaleY * 1000) / 1000;
      const roundedScale = Math.round(((Math.abs(scaleX) + Math.abs(scaleY)) / 2) * 1000) / 1000;
      const roundedOffsetX = Math.round(offsetX * 1000) / 1000;
      const roundedOffsetY = Math.round(offsetY * 1000) / 1000;
      const key = `${roundedScaleX}:${roundedScaleY}:${roundedOffsetX}:${roundedOffsetY}`;
      if (transforms.some((item) => item.key === key)) return;
      transforms.push({
        key,
        scale: roundedScale,
        scaleX: roundedScaleX,
        scaleY: roundedScaleY,
        offsetX: roundedOffsetX,
        offsetY: roundedOffsetY,
        label,
      });
    };

    addCandidate(transform.scaleX ?? transform.scale, transform.offsetX, transform.offsetY, 'inferred', transform.scaleY ?? transform.scale);
    addCandidate(previous?.scaleX ?? previous?.scale, previous?.offsetX ?? 0, previous?.offsetY ?? 0, 'previous', previous?.scaleY ?? previous?.scale);
    if (!source.worldSpace) addCandidate(1, 0, 0, 'tile');
    for (const scale of [CFG.PHASER_TILE_PX, 100, 64, 50, 32, 16, 1]) addCandidate(scale, 0, 0, 'fallback');

    const centerX = bounds.minX + bounds.w / 2;
    const centerY = bounds.minY + bounds.h / 2;
    const mapDistance = (point) => Math.hypot(point.x - centerX, point.y - centerY);
    const previousDistance = (point) => previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0;
    const candidates = transforms.map(({ scale, scaleX, scaleY, offsetX, offsetY, label }) => {
      const point = { x: Number(source.x) / scaleX + offsetX, y: Number(source.y) / scaleY + offsetY, rotation, scale, scaleX, scaleY, offsetX, offsetY, label };
      point.onMap = inBounds(point);
      point.score = mapDistance(point)
        + (previous ? previousDistance(point) * 2 : 0)
        + (point.onMap ? 0 : Math.max(bounds.w, bounds.h) * 2)
        + (label === 'inferred' ? -10 : 0)
        + (!source.worldSpace && label === 'tile' ? -1 : 0);
      return point;
    });

    return candidates.reduce((winner, point) => point.score < winner.score ? point : winner);
  }

  /** Check whether a screen-space marker is inside or near the minimap viewport. */
  _isVisible(point, width, height, margin = 0) {
    return point.x >= -margin && point.x <= width + margin
      && point.y >= -margin && point.y <= height + margin;
  }

  /** Ease the minimap camera toward the latest player focus to avoid snapping. */
  _smoothFocus(target) {
    if (!target) return this._smoothedFocus;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dt = this._lastFrameT ? Math.max(0, now - this._lastFrameT) : CFG.REFRESH_MS;
    this._lastFrameT = now;

    if (!this._smoothedFocus) {
      this._smoothedFocus = { ...target };
      return this._smoothedFocus;
    }

    const alpha = Math.min(1, 1 - Math.exp(-dt / CFG.SMOOTH_MS));
    this._smoothedFocus = {
      x: this._smoothedFocus.x + (target.x - this._smoothedFocus.x) * alpha,
      y: this._smoothedFocus.y + (target.y - this._smoothedFocus.y) * alpha,
      rotation: target.rotation ?? this._smoothedFocus.rotation ?? 0,
      scale: target.scale ?? this._smoothedFocus.scale,
      scaleX: target.scaleX ?? target.scale ?? this._smoothedFocus.scaleX ?? this._smoothedFocus.scale,
      scaleY: target.scaleY ?? target.scale ?? this._smoothedFocus.scaleY ?? this._smoothedFocus.scale,
      offsetX: target.offsetX ?? this._smoothedFocus.offsetX ?? 0,
      offsetY: target.offsetY ?? this._smoothedFocus.offsetY ?? 0,
    };
    return this._smoothedFocus;
  }

  /** Draw a small fixed local-player dot at the minimap center. */
  _drawPlayer(ctx, px, py) {
    this._drawDot(ctx, px, py, CFG.PLAYER_R, '#ff4444', '#ffffff', '#ff3333');
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, CFG.PLAYER_R + 4, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.stroke();
    ctx.restore();
  }

  /** Draw a green friendly/unknown or red enemy non-local player marker. */
  _drawOtherPlayer(ctx, px, py, player = {}, localTeam = null) {
    const isEnemy = localTeam != null && player.teamId != null && String(player.teamId) !== String(localTeam);
    this._drawDot(
      ctx,
      px,
      py,
      CFG.OTHER_PLAYER_R,
      isEnemy ? '#ff3b3b' : '#37e66f',
      isEnemy ? '#4b0909' : '#073b17',
      isEnemy ? '#ff3b3b' : '#37e66f',
    );
  }

  /** Draw a map object/device marker, preferring its actual Phaser texture. */
  _drawDevice(ctx, px, py, device = {}) {
    const kind = device.kind ?? device;
    const asset = device.textureAsset;
    if (asset?.image && asset.image.complete !== false) {
      const size = CFG.DEVICE_ICON_PX;
      const x = px - size / 2;
      const y = py - size / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(126,207,255,0.85)';
      ctx.shadowBlur = 5;
      ctx.fillStyle = 'rgba(7, 19, 31, 0.72)';
      ctx.strokeStyle = 'rgba(126,207,255,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x - 1, y - 1, size + 2, size + 2, 3);
      else ctx.rect(x - 1, y - 1, size + 2, size + 2);
      ctx.fill();
      ctx.stroke();
      try {
        ctx.drawImage(asset.image, asset.sx, asset.sy, asset.sw, asset.sh, x, y, size, size);
        ctx.restore();
        return;
      } catch (error) {
        ctx.restore();
        console.debug('[GimkitMap] Device texture draw failed; falling back to marker', asset, error);
      }
    }

    const text = String(kind ?? '').toLowerCase();
    const isTree = text.includes('tree') || text.includes('plant') || text.includes('bush');
    const r = CFG.DEVICE_R;
    ctx.save();
    ctx.shadowColor = isTree ? '#1b8f3a' : '#7ecfff';
    ctx.shadowBlur = 5;
    ctx.beginPath();
    if (isTree) {
      ctx.moveTo(px, py - r - 2);
      ctx.lineTo(px - r - 2, py + r + 1);
      ctx.lineTo(px + r + 2, py + r + 1);
      ctx.closePath();
      ctx.fillStyle = '#1fa447';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#0f4f22';
      ctx.stroke();
      ctx.fillStyle = '#8b5a2b';
      ctx.fillRect(px - 1, py + r, 2, 3);
    } else {
      ctx.rect(px - r, py - r, r * 2, r * 2);
      ctx.fillStyle = '#62d8ff';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#09354a';
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Shared circular marker renderer. */
  _drawDot(ctx, px, py, r, fill, stroke, glow) {
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur  = 8;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle   = fill;
    ctx.fill();
    ctx.lineWidth   = 2;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.restore();
  }


  /**
   * Draw the number of discovered explicit tiles at the top of the map.
   */
  _drawTileCount(ctx, cx, cy, tileCount) {
    const label = `${tileCount.toLocaleString()} tiles found`;
    ctx.save();
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(label);
    const padX = 8;
    const w = metrics.width + padX * 2;
    const h = 18;
    ctx.fillStyle = 'rgba(10, 22, 38, 0.78)';
    ctx.strokeStyle = 'rgba(126, 207, 255, 0.75)';
    ctx.lineWidth = 1;
    const x = cx - w / 2;
    const y = cy - h / 2;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, 6);
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e9f8ff';
    ctx.fillText(label, cx, cy + 0.5);
    ctx.restore();
  }

  /**
   * Draw a minimal N/S/E/W compass rose in a corner.
   */
  _drawCompass(ctx, cx, cy) {
    const r = 10;
    ctx.save();
    ctx.globalAlpha  = 0.45;
    ctx.strokeStyle  = '#7ecfff';
    ctx.lineWidth    = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle    = '#7ecfff';
    ctx.font         = 'bold 7px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx,       cy - r + 4);
    ctx.fillText('S', cx,       cy + r - 4);
    ctx.fillText('E', cx + r - 3, cy);
    ctx.fillText('W', cx - r + 3, cy);
    ctx.restore();
  }

  /**
   * Shown when window.stores.world.terrain.tiles is absent or empty.
   */
  _drawWaiting(message = 'Waiting for tile data…') {
    const cv  = this._cv;
    const ctx = this._ctx;
    const cw  = cv.parentElement?.clientWidth  || CFG.DEFAULT_W;
    const ch  = cv.parentElement?.clientHeight || CFG.DEFAULT_H - 60;
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle    = '#556677';
    ctx.font         = '13px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, cw / 2, ch / 2 - 10);
    ctx.font      = '10px monospace';
    ctx.fillStyle = '#334455';
    ctx.fillText('(Join a game and wait a moment)', cw / 2, ch / 2 + 10);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUTTON FACTORY  (hoisted so MapPanel can reference it)
// ─────────────────────────────────────────────────────────────────────────────
function mkBtn(label, title, bg = '#1e1e40') {
  const b = document.createElement('button');
  b.textContent = label;
  b.title       = title;
  Object.assign(b.style, {
    background: bg, color: '#ccd', border: '1px solid #3a3a6a',
    borderRadius: '4px', width: '22px', height: '22px',
    cursor: 'pointer', fontSize: '13px', padding: '0',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: '0',
  });
  b.addEventListener('mouseenter', () => { b.style.filter = 'brightness(1.45)'; });
  b.addEventListener('mouseleave', () => { b.style.filter = ''; });
  return b;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAP PANEL  — the draggable / resizable overlay window
// ─────────────────────────────────────────────────────────────────────────────
class MapPanel {
  constructor() {
    this.visible  = false;
    this.zoom     = lsGet(CFG.LS_ZOOM, CFG.DEFAULT_ZOOM);
    this._pos     = lsGet(CFG.LS_POS,  { x: 20, y: 20 });
    this._drag    = null;   // Drag state: { mx, my, left, top } | null
    this._timer   = null;   // setInterval handle for the render loop

    this._buildDOM();
    this._renderer = new TileRenderer(this._canvas);
    this._bindEvents();

    console.log('[GimkitMap] Minimap created — press M to open');
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    /* Root container */
    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position:     'fixed',
      left:         `${this._pos.x}px`,
      top:          `${this._pos.y}px`,
      width:        `${CFG.DEFAULT_W}px`,
      height:       `${CFG.DEFAULT_H}px`,
      background:   '#1a1a2e',
      border:       '1.5px solid #2a2a5e',
      borderRadius: '9px',
      boxShadow:    '0 6px 32px rgba(0,0,0,0.75)',
      zIndex:       '999999',
      display:      'none',          // Hidden by default; show() sets 'flex'
      flexDirection:'column',
      fontFamily:   '"Courier New", monospace',
      userSelect:   'none',
      resize:       'none',
      overflow:     'hidden',
    });

    /* Canvas wrapper — fills remaining vertical space */
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      flex:       '1',
      minHeight:  '0',     // Required for flex child to shrink below content size
      overflow:   'hidden',
      background: '#0d0d1a',
      position:   'relative',
    });

    this._canvas = document.createElement('canvas');
    Object.assign(this._canvas.style, {
      display:        'block',
      width:          '100%',
      height:         '100%',
      imageRendering: 'pixelated',   // Keeps tile pixels crisp when zoomed in
    });
    wrap.appendChild(this._canvas);

    /* Status bar */
    const statusBar = document.createElement('div');
    Object.assign(statusBar.style, {
      padding:        '3px 8px',
      background:     '#13132b',
      borderTop:      '1px solid #2a2a5e',
      color:          '#b9d8e8',
      fontSize:       '11px',
      fontWeight:     '600',
      display:        'flex',
      justifyContent: 'space-between',
      gap:            '8px',
      flexShrink:     '0',
    });
    this._statusL = document.createElement('span');   // Left: tile/player/device counts
    this._statusR = document.createElement('span');   // Right: zoom %
    this._statusL.style.whiteSpace = 'nowrap';
    this._statusR.style.color = '#bfefff';
    statusBar.append(this._statusL, this._statusR);

    this.el.append(wrap, statusBar);
    document.body.appendChild(this.el);

    /* Invalidate renderer whenever the panel is resized via the CSS handle */
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (this.visible) { this._renderer.invalidate(); this._tick(); }
      }).observe(this.el);
    }
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  _bindEvents() {
    // Mouse-wheel zoom directly on the canvas
    this._canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this._adjustZoom(e.deltaY < 0 ? +CFG.ZOOM_STEP : -CFG.ZOOM_STEP);
    }, { passive: false });
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────

  /**
   * Adjust zoom by `delta` (or reset to the minimap default if delta is null).
   * Clamps to [MIN_ZOOM, MAX_ZOOM], persists to localStorage, redraws.
   */
  _adjustZoom(delta) {
    this.zoom = delta === null
      ? CFG.DEFAULT_ZOOM
      : Math.min(CFG.MAX_ZOOM, Math.max(CFG.MIN_ZOOM,
          Math.round((this.zoom + delta) * 100) / 100));
    lsSet(CFG.LS_ZOOM, this.zoom);
    this._renderer.invalidate();
    this._tick();
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  /** One render tick: draw the map and refresh the status bar text. */
  _tick() {
    this._renderer.render(this.zoom);
    const stats = this._renderer.stats();
    const tileStr = stats.tiles ? `${stats.tiles} tiles` : 'No tile data';
    const playerStr = stats.playerPosition
      ? `pos ${stats.playerPosition.x.toFixed(1)}, ${stats.playerPosition.y.toFixed(1)}`
      : 'pos ?';
    this._statusL.textContent = `${tileStr} • ${stats.players} players • ${stats.devices} devices • ${playerStr}`;
    this._statusR.textContent = `${(this.zoom * 100).toFixed(0)}%`;
  }

  _startLoop() {
    if (this._timer) return;
    const raf = gameWindow().requestAnimationFrame?.bind(gameWindow());
    if (!raf) {
      this._timer = setInterval(() => this._tick(), CFG.REFRESH_MS);
      this._tick();
      console.log('[GimkitMap] Render loop started');
      return;
    }

    let lastTick = 0;
    const loop = (now = 0) => {
      if (!this.visible) return;
      if (!lastTick || now - lastTick >= CFG.REFRESH_MS) {
        lastTick = now;
        this._tick();
      }
      this._timer = raf(loop);
    };
    this._timer = raf(loop);
    this._tick();   // Immediate first draw
    console.log('[GimkitMap] Render loop started');
  }

  _stopLoop() {
    const cancelRaf = gameWindow().cancelAnimationFrame?.bind(gameWindow());
    if (cancelRaf && typeof this._timer === 'number') cancelRaf(this._timer);
    else clearInterval(this._timer);
    this._timer = null;
    console.log('[GimkitMap] Render loop stopped');
  }

  // ── Show / hide / toggle ──────────────────────────────────────────────────

  show()   { this.el.style.display = 'flex'; this.visible = true;  this._startLoop(); }
  hide()   { this.el.style.display = 'none'; this.visible = false; this._stopLoop();  }
  toggle() { this.visible ? this.hide() : this.show(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT  — wait for Gimkit game stores, then mount the panel
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
  console.log('[GimkitMap] Waiting for Gimkit game stores…');
  installDebugHelpers();
  exposeStores().catch((error) => console.warn('[GimkitMap] Initial stores resolve failed; retrying while waiting', error));

  let waited = 0;
  while (waited < CFG.INIT_WAIT_MS) {
    if (safeGet(gameWindow(), ['stores']) !== undefined) {
      console.log('[GimkitMap] stores detected after', waited, 'ms');
      break;
    }

    if (!storesPromise) {
      exposeStores().catch((error) => console.warn('[GimkitMap] stores resolve failed; retrying', error));
    }

    await delay(500);
    waited += 500;
  }

  if (waited >= CFG.INIT_WAIT_MS) {
    // Launch anyway — the renderer shows "Waiting for tile data…" until they appear
    console.warn('[GimkitMap] stores not found after', CFG.INIT_WAIT_MS, 'ms — launching anyway');
  }

  const panel = new MapPanel();

  // Keyboard toggle — ignore key presses while the user is typing in an input
  document.addEventListener('keydown', e => {
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key.toLowerCase() === CFG.TOGGLE_KEY) {
      e.preventDefault();
      panel.toggle();
    }
  });

  console.log(`[GimkitMap] Ready! Press "${CFG.TOGGLE_KEY.toUpperCase()}" to open / close the minimap.`);
}

init();
