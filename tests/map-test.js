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
  REFRESH_MS:      350,   // Redraw interval (ms) while map is open
  TILE_PX:         4,     // Canvas pixels per tile at zoom 1.0×
  MIN_ZOOM:        0.25,
  MAX_ZOOM:        8,
  ZOOM_STEP:       0.25,
  DEFAULT_W:       320,   // Initial panel width (px)
  DEFAULT_H:       340,   // Initial panel height (px)
  LS_POS:          'gk_map_pos',   // localStorage key for window position
  LS_ZOOM:         'gk_map_zoom',  // localStorage key for zoom level
  PLAYER_R:        5,     // Player arrow half-size (px)
  PHASER_TILE_PX:  16,    // Phaser world-pixels per tile (for coord conversion)
  INIT_WAIT_MS:    20_000, // How long to wait for game stores before giving up
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
  'Snowy Grass':     '#b8d6c1',
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
  'Frozen Lake':     '#8fd8f7',
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

/** Return the fill colour for the global map background. */
const backgroundColour = () => TERRAIN_COLOUR[findBackgroundTerrain()] ?? TERRAIN_COLOUR.Snow;

/** Return the fill colour for a tile object. */
const tileColour = (t) => TERRAIN_COLOUR[t.terrain] ?? COLOUR_FALLBACK;

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER POSITION FINDER
// Probes several known Gimkit / Phaser state paths.
// Returns { x, y, rotation } in tile-coordinate space, or null.
// ─────────────────────────────────────────────────────────────────────────────
function findPlayer() {
  // ── Probe 1: world.players Map + local player ID ──────────────────────────
  try {
    const players = safeGet(gameWindow(), ['stores', 'world', 'players']);
    if (players instanceof Map && players.size > 0) {
      const id = safeGet(gameWindow(), ['stores', 'world', 'localPlayerId'])
              ?? safeGet(gameWindow(), ['stores', 'world', 'myPlayerId']);
      const p  = id ? players.get(id) : players.values().next().value;
      if (p?.x != null) return { x: p.x, y: p.y, rotation: p.rotation ?? 0 };
    }
  } catch {}

  // ── Probe 2: direct character / local-character object ────────────────────
  try {
    const c = safeGet(gameWindow(), ['stores', 'world', 'character'])
           ?? safeGet(gameWindow(), ['stores', 'world', 'localCharacter'])
           ?? safeGet(gameWindow(), ['stores', 'world', 'myCharacter']);
    if (c?.x != null) return { x: c.x, y: c.y, rotation: c.rotation ?? 0 };
  } catch {}

  // ── Probe 3: generic entities Map — look for isLocal flag ─────────────────
  try {
    const entities = safeGet(gameWindow(), ['stores', 'world', 'entities']);
    if (entities instanceof Map) {
      for (const e of entities.values()) {
        if ((e.isLocal || e.isLocalPlayer || e.local) && e.x != null)
          return { x: e.x, y: e.y, rotation: e.rotation ?? 0 };
      }
    }
  } catch {}

  // ── Probe 4: Phaser scene player object (world-pixel → tile coords) ────────
  try {
    const scenes = safeGet(gameWindow(), ['game', 'scene', 'scenes'])
                ?? safeGet(gameWindow(), ['_phaserGame', 'scene', 'scenes']);
    if (Array.isArray(scenes)) {
      for (const s of scenes) {
        const p = s.player ?? s.localPlayer ?? s.character;
        if (p?.x != null) {
          const tp = CFG.PHASER_TILE_PX;
          return { x: p.x / tp, y: p.y / tp, rotation: p.rotation ?? 0 };
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
  }

  /**
   * Main entry point — call on every tick.
   * Rebuilds the cache only when the tile set changes.
   */
  render(zoom) {
    const tiles = safeGet(gameWindow(), ['stores', 'world', 'terrain', 'tiles']);
    if (!tiles || tiles.size === 0) { this._drawWaiting(); return; }

    if (tiles.size !== this._knownCount) {
      this._buildCache(tiles);
      this._knownCount = tiles.size;
    }

    this._composite(zoom, findPlayer(), tiles.size);
  }

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
    for (const t of tiles.values()) {
      if (t.x < minX) minX = t.x;  if (t.x > maxX) maxX = t.x;
      if (t.y < minY) minY = t.y;  if (t.y > maxY) maxY = t.y;
    }
    this._bounds = { minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 };

    const ts  = CFG.TILE_PX;
    const off = document.createElement('canvas');
    off.width  = this._bounds.w * ts;
    off.height = this._bounds.h * ts;
    const ctx  = off.getContext('2d');

    // Paint the global terrain first; explicit tiles are drawn over it.
    ctx.fillStyle = backgroundColour();
    ctx.fillRect(0, 0, off.width, off.height);

    // Draw each tile; solid tiles get a translucent red overlay
    for (const t of tiles.values()) {
      const px = (t.x - minX) * ts;
      const py = (t.y - minY) * ts;
      ctx.fillStyle = tileColour(t);
      ctx.fillRect(px, py, ts, ts);
      if (t.collides) {
        ctx.fillStyle = COLOUR_COLLIDE;
        ctx.fillRect(px, py, ts, ts);
      }
    }

    this._cache = off;
    console.debug(`[GimkitMap] Cache rebuilt: ${tiles.size} tiles, ` +
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

    // Tile-space focal point (what we want at the canvas centre)
    const cx = player != null ? (player.x - b.minX) : b.w / 2;
    const cy = player != null ? (player.y - b.minY) : b.h / 2;

    // Top-left corner of the scaled tile image in canvas coordinates
    const ox = Math.round(cw / 2 - cx * ts);
    const oy = Math.round(ch / 2 - cy * ts);

    // Background (visible when zoomed in and map doesn't fill canvas)
    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(0, 0, cw, ch);

    // Tile image scaled to current zoom
    ctx.drawImage(cache, ox, oy, scaledW, scaledH);

    // Player marker (always at canvas centre when player is known)
    if (player != null) {
      this._drawPlayer(ctx, cw / 2, ch / 2, player.rotation);
    }

    // Tile-count badge at the top of the map, then compass in the corner
    this._drawTileCount(ctx, cw / 2, 18, tileCount);
    this._drawCompass(ctx, cw - 24, 24);
  }

  /**
   * Draw a directional arrow at (px, py) rotated to `rotation` radians.
   */
  _drawPlayer(ctx, px, py, rotation) {
    const r = CFG.PLAYER_R;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rotation);
    ctx.shadowColor = '#ff3333';
    ctx.shadowBlur  = 8;
    // Arrow pointing "up" (north) before rotation
    ctx.beginPath();
    ctx.moveTo(0,          -r * 2.2);   // tip
    ctx.lineTo(r  * 1.1,   r * 1.2);
    ctx.lineTo(0,           r * 0.5);   // notch
    ctx.lineTo(-r * 1.1,   r * 1.2);
    ctx.closePath();
    ctx.fillStyle   = '#ff4444';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 1;
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
  _drawWaiting() {
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
    ctx.fillText('Waiting for tile data…', cw / 2, ch / 2 - 10);
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
    this.zoom     = lsGet(CFG.LS_ZOOM, 1);
    this._pos     = lsGet(CFG.LS_POS,  { x: 20, y: 20 });
    this._drag    = null;   // Drag state: { mx, my, left, top } | null
    this._timer   = null;   // setInterval handle for the render loop

    this._buildDOM();
    this._renderer = new TileRenderer(this._canvas);
    this._bindEvents();

    console.log('[GimkitMap] Panel created — press M to open');
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
      resize:       'both',          // User can drag to resize
      overflow:     'hidden',
      minWidth:     '200px',
      minHeight:    '200px',
    });

    /* Title bar (drag handle) */
    this._bar = document.createElement('div');
    Object.assign(this._bar.style, {
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'space-between',
      padding:        '5px 8px',
      background:     '#13132b',
      borderBottom:   '1px solid #2a2a5e',
      cursor:         'grab',
      flexShrink:     '0',
    });

    const titleEl = document.createElement('span');
    titleEl.textContent = '🗺  Live Map';
    Object.assign(titleEl.style, { color: '#7ecfff', fontSize: '12px', fontWeight: 'bold' });

    /* Control buttons */
    const btns = document.createElement('div');
    Object.assign(btns.style, { display: 'flex', gap: '4px', alignItems: 'center' });
    this._btnIn    = mkBtn('+', 'Zoom in   (scroll up)');
    this._btnOut   = mkBtn('−', 'Zoom out  (scroll down)');
    this._btnReset = mkBtn('⊙', 'Reset zoom to 1×');
    this._btnClose = mkBtn('✕', 'Close map  [M]', '#5a1515');
    btns.append(this._btnIn, this._btnOut, this._btnReset, this._btnClose);
    this._bar.append(titleEl, btns);

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
      color:          '#3a4a5a',
      fontSize:       '10px',
      display:        'flex',
      justifyContent: 'space-between',
      flexShrink:     '0',
    });
    this._statusL = document.createElement('span');   // Left: tile count / player coords
    this._statusR = document.createElement('span');   // Right: zoom %
    this._statusR.style.color = '#7ecfff';
    statusBar.append(this._statusL, this._statusR);

    this.el.append(this._bar, wrap, statusBar);
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
    /* ── Drag ── */
    this._bar.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const r = this.el.getBoundingClientRect();
      this._drag = { mx: e.clientX, my: e.clientY, left: r.left, top: r.top };
      this._bar.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', e => {
      if (!this._drag) return;
      const x = Math.max(0, this._drag.left + (e.clientX - this._drag.mx));
      const y = Math.max(0, this._drag.top  + (e.clientY - this._drag.my));
      this.el.style.left = `${x}px`;
      this.el.style.top  = `${y}px`;
      this._pos = { x, y };
    });
    document.addEventListener('mouseup', () => {
      if (!this._drag) return;
      this._drag = null;
      this._bar.style.cursor = 'grab';
      lsSet(CFG.LS_POS, this._pos);   // Persist final position
    });

    /* ── Zoom ── */
    this._btnIn.addEventListener('click',    () => this._adjustZoom(+CFG.ZOOM_STEP));
    this._btnOut.addEventListener('click',   () => this._adjustZoom(-CFG.ZOOM_STEP));
    this._btnReset.addEventListener('click', () => this._adjustZoom(null));

    // Mouse-wheel zoom directly on the canvas
    this._canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this._adjustZoom(e.deltaY < 0 ? +CFG.ZOOM_STEP : -CFG.ZOOM_STEP);
    }, { passive: false });

    /* ── Close ── */
    this._btnClose.addEventListener('click', () => this.hide());
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────

  /**
   * Adjust zoom by `delta` (or reset to 1 if delta is null).
   * Clamps to [MIN_ZOOM, MAX_ZOOM], persists to localStorage, redraws.
   */
  _adjustZoom(delta) {
    this.zoom = delta === null
      ? 1
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
    const tiles  = safeGet(gameWindow(), ['stores', 'world', 'terrain', 'tiles']);
    const player = findPlayer();
    const tileStr  = tiles?.size ? `${tiles.size} tiles` : 'No tile data';
    const playerStr = player
      ? `  ·  player (${Math.round(player.x)}, ${Math.round(player.y)})`
      : '';
    this._statusL.textContent = tileStr + playerStr;
    this._statusR.textContent = `${(this.zoom * 100).toFixed(0)}%`;
  }

  _startLoop() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), CFG.REFRESH_MS);
    this._tick();   // Immediate first draw
    console.log('[GimkitMap] Render loop started');
  }

  _stopLoop() {
    clearInterval(this._timer);
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
