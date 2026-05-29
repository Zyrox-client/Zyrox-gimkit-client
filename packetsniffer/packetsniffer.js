// ==UserScript==
// @name         Zyrox packet sniffer
// @namespace    https://github.com/zyrox
// @version      2.0.0
// @description  WebSocket packet inspector with split-pane UI, binary decoding, sparkline stats, and keyboard nav.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @license      MIT
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  // ═══════════════════════════════════════════════════════════
  //  Config
  // ═══════════════════════════════════════════════════════════
  const VERSION          = "2.0.0";
  const MAX_PACKETS      = 1000;
  const DEFAULT_WIDTH    = 900;
  const MIN_WIDTH        = 340;
  const COLYSEUS_MSG     = 13;
  const SPARKLINE_SLOTS  = 30;
  const SLOT_MS          = 2000;
  const FILTER_DEBOUNCE  = 120;

  const ENGINE_TYPES = { "0":"OPEN","1":"CLOSE","2":"PING","3":"PONG","4":"MESSAGE","5":"UPGRADE","6":"NOOP" };
  const SOCKET_TYPES = { "0":"CONNECT","1":"DISCONNECT","2":"EVENT","3":"ACK","4":"ERROR","5":"BINARY_EVENT","6":"BINARY_ACK" };

  // ═══════════════════════════════════════════════════════════
  //  State
  // ═══════════════════════════════════════════════════════════
  let packets = [], packetId = 0, pendingPackets = [];
  let selectedId = null, selectedForDiffId = null;
  let sidebarOpen = true, decodeEnabled = true;
  let isPaused = false, autoScroll = true, showTimestamps = true;
  let initialized = false, wsHooksInstalled = false;
  let hooksGen = 0;
  let currentWidth = DEFAULT_WIDTH;
  let viewerWidthPx = Math.round(DEFAULT_WIDTH * 0.62);
  let renderScheduled = false;
  let filterDebounceTimer = null;
  let inCount = 0, outCount = 0;
  let firstPacketTs = null;

  // Sparkline: ring-buffer of per-slot packet counts + byte counts
  const sparklinePkt  = new Array(SPARKLINE_SLOTS).fill(0);
  const sparklineB    = new Array(SPARKLINE_SLOTS).fill(0);
  let slotIdx = 0, lastSlotTs = Date.now();

  const pinnedIds  = new Set();
  const flaggedIds = new Set();
  const wsMap      = new Map();  // ws → { id, url }
  const resendLogQueue = new WeakMap(); // ws → [{ sourceId }] for sends triggered by Resend
  let wsSeq = 0;

  const filter = { query: "", direction: "ALL", type: "", flaggedOnly: false, isRegex: false, re: null };

  // Cached DOM refs
  let sidebar, listEl, countEl, filterInput, viewerPanel, bodyEl, dividerEl;
  let statsLineEl, statusEl, pauseBtnEl, autoscrollBtnEl;
  let clearConfirmEl, resetConfirmEl, sparklineSvgEl, connBadgeEl, contextMenuEl;

  // ═══════════════════════════════════════════════════════════
  //  Utilities
  // ═══════════════════════════════════════════════════════════

  const esc  = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const pad  = (n, w = 2) => String(n).padStart(w, "0");

  function fmtTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  function fmtRel(ts) {
    const ms = ts - (firstPacketTs ?? ts);
    const s  = Math.floor(ms / 1000);
    const m  = Math.floor(s / 60);
    return m > 0 ? `+${m}m${pad(s % 60)}s` : `+${s}.${pad(ms % 1000, 3)}s`;
  }

  function fmtBytes(n) {
    if (n < 1024)    return `${n}B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1048576).toFixed(1)}MB`;
  }

  function tryJson(s) {
    if (typeof s !== "string") return null;
    try { return JSON.parse(s); } catch { return null; }
  }

  // Proper xxd-style hex dump: offset | hex (8+8) | ASCII
  function hexDump(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (!b.length) return "(empty)";
    const lines = [];
    for (let i = 0; i < b.length; i += 16) {
      const row  = b.slice(i, i + 16);
      const off  = i.toString(16).padStart(5, "0");
      const hex  = Array.from(row).map((x, j) => (j === 8 ? " " : "") + x.toString(16).padStart(2, "0")).join(" ");
      const asc  = Array.from(row).map(x => (x >= 32 && x < 127) ? String.fromCharCode(x) : ".").join("");
      lines.push(`${off}  ${hex.padEnd(50)}  ${esc(asc)}`);
    }
    return lines.join("\n");
  }

  // ─── ArrayBuffer coercion ───────────────────────────────────
  function toAB(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input))
      return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    return null;
  }

  function msgpackEncode(value) {
    const bytes = [];
    const deferred = [];
    const write = (input) => {
      const type = typeof input;
      if (type === "string") {
        let len = 0;
        for (let i = 0; i < input.length; i++) {
          const code = input.charCodeAt(i);
          if (code < 128) len++;
          else if (code < 2048) len += 2;
          else if (code < 55296 || code > 57343) len += 3;
          else { i++; len += 4; }
        }
        if (len < 32) bytes.push(160 | len);
        else if (len < 256) bytes.push(217, len);
        else if (len < 65536) bytes.push(218, len >> 8, len & 255);
        else bytes.push(219, len >> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255);
        deferred.push({ type: "string", value: input, offset: bytes.length });
        bytes.length += len;
        return;
      }
      if (type === "number") {
        if (Number.isInteger(input) && Number.isFinite(input)) {
          if (input >= 0) {
            if (input < 128) bytes.push(input);
            else if (input < 256) bytes.push(204, input);
            else if (input < 65536) bytes.push(205, input >> 8, input & 255);
            else if (input < 4294967296) bytes.push(206, input >> 24, (input >> 16) & 255, (input >> 8) & 255, input & 255);
            else {
              const hi = Math.floor(input / Math.pow(2, 32));
              const lo = input >>> 0;
              bytes.push(207, hi >> 24, (hi >> 16) & 255, (hi >> 8) & 255, hi & 255, lo >> 24, (lo >> 16) & 255, (lo >> 8) & 255, lo & 255);
            }
          } else if (input >= -32) bytes.push(input);
          else if (input >= -128) bytes.push(208, input & 255);
          else if (input >= -32768) bytes.push(209, (input >> 8) & 255, input & 255);
          else if (input >= -2147483648) bytes.push(210, (input >> 24) & 255, (input >> 16) & 255, (input >> 8) & 255, input & 255);
          else {
            const hi = Math.floor(input / Math.pow(2, 32));
            const lo = input >>> 0;
            bytes.push(211, hi >> 24, (hi >> 16) & 255, (hi >> 8) & 255, hi & 255, lo >> 24, (lo >> 16) & 255, (lo >> 8) & 255, lo & 255);
          }
          return;
        }
        bytes.push(203);
        deferred.push({ type: "float64", value: input, offset: bytes.length });
        bytes.length += 8;
        return;
      }
      if (type === "boolean") { bytes.push(input ? 195 : 194); return; }
      if (input == null) { bytes.push(192); return; }
      if (Array.isArray(input)) {
        const len = input.length;
        if (len < 16) bytes.push(144 | len);
        else if (len < 65536) bytes.push(220, len >> 8, len & 255);
        else bytes.push(221, len >> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255);
        for (const item of input) write(item);
        return;
      }
      if (type === "object") {
        const keys = Object.keys(input).filter((k) => typeof input[k] !== "function");
        const len = keys.length;
        if (len < 16) bytes.push(128 | len);
        else if (len < 65536) bytes.push(222, len >> 8, len & 255);
        else bytes.push(223, len >> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255);
        for (const key of keys) { write(key); write(input[key]); }
        return;
      }
      write(null);
    };

    write(value);
    const view = new DataView(new ArrayBuffer(bytes.length));
    for (let i = 0; i < bytes.length; i++) view.setUint8(i, bytes[i] & 255);

    for (const part of deferred) {
      if (part.type === "float64") { view.setFloat64(part.offset, part.value); continue; }
      let offset = part.offset;
      const value = part.value;
      for (let i = 0; i < value.length; i++) {
        let code = value.charCodeAt(i);
        if (code < 128) view.setUint8(offset++, code);
        else if (code < 2048) {
          view.setUint8(offset++, 192 | (code >> 6));
          view.setUint8(offset++, 128 | (code & 63));
        } else if (code < 55296 || code > 57343) {
          view.setUint8(offset++, 224 | (code >> 12));
          view.setUint8(offset++, 128 | ((code >> 6) & 63));
          view.setUint8(offset++, 128 | (code & 63));
        } else {
          i++;
          code = 65536 + (((code & 1023) << 10) | (value.charCodeAt(i) & 1023));
          view.setUint8(offset++, 240 | (code >> 18));
          view.setUint8(offset++, 128 | ((code >> 12) & 63));
          view.setUint8(offset++, 128 | ((code >> 6) & 63));
          view.setUint8(offset++, 128 | (code & 63));
        }
      }
    }
    return view.buffer;
  }

  // ─── MsgPack decoder ────────────────────────────────────────
  // Always takes a plain ArrayBuffer.
  function msgpackDecode(ab, startOffset = 0) {
    if (!(ab instanceof ArrayBuffer)) return null;
    const v = new DataView(ab);
    let o = startOffset;

    const rStr = n => {
      let s = "", end = o + n;
      while (o < end) {
        const b = v.getUint8(o++);
        if (b < 0x80) {
          s += String.fromCharCode(b);
        } else if (b < 0xe0) {
          s += String.fromCharCode(((b & 0x1f) << 6) | (v.getUint8(o++) & 0x3f));
        } else if (b < 0xf0) {
          s += String.fromCharCode(((b & 0x0f) << 12) | ((v.getUint8(o++) & 0x3f) << 6) | (v.getUint8(o++) & 0x3f));
        } else {
          const cp = ((b & 7) << 18) | ((v.getUint8(o++) & 0x3f) << 12) | ((v.getUint8(o++) & 0x3f) << 6) | (v.getUint8(o++) & 0x3f);
          const hi = cp - 0x10000;
          s += String.fromCharCode((hi >> 10) + 0xd800, (hi & 0x3ff) + 0xdc00);
        }
      }
      return s;
    };

    const rBin = n => { const b = ab.slice(o, o + n); o += n; return b; };

    const read = () => {
      const t = v.getUint8(o++);
      if (t <= 0x7f) return t;
      if (t <= 0x8f) { const n = t & 0xf, m = {}; for (let i = 0; i < n; i++) m[read()] = read(); return m; }
      if (t <= 0x9f) { const n = t & 0xf, a = []; for (let i = 0; i < n; i++) a.push(read()); return a; }
      if (t <= 0xbf) return rStr(t & 0x1f);
      if (t >= 0xe0) return t - 256;
      switch (t) {
        case 0xc0: return null; case 0xc2: return false; case 0xc3: return true;
        case 0xc4: return rBin(v.getUint8(o++));
        case 0xc5: { const n = v.getUint16(o); o += 2; return rBin(n); }
        case 0xc6: { const n = v.getUint32(o); o += 4; return rBin(n); }
        case 0xca: { const r = v.getFloat32(o); o += 4; return r; }
        case 0xcb: { const r = v.getFloat64(o); o += 8; return r; }
        case 0xcc: return v.getUint8(o++);
        case 0xcd: { const r = v.getUint16(o); o += 2; return r; }
        case 0xce: { const r = v.getUint32(o); o += 4; return r; }
        case 0xd0: return v.getInt8(o++);
        case 0xd1: { const r = v.getInt16(o); o += 2; return r; }
        case 0xd2: { const r = v.getInt32(o); o += 4; return r; }
        case 0xd9: return rStr(v.getUint8(o++));
        case 0xda: { const n = v.getUint16(o); o += 2; return rStr(n); }
        case 0xdb: { const n = v.getUint32(o); o += 4; return rStr(n); }
        case 0xdc: { const n = v.getUint16(o); o += 2; const a = []; for (let i = 0; i < n; i++) a.push(read()); return a; }
        case 0xdd: { const n = v.getUint32(o); o += 4; const a = []; for (let i = 0; i < n; i++) a.push(read()); return a; }
        case 0xde: { const n = v.getUint16(o); o += 2; const m = {}; for (let i = 0; i < n; i++) m[read()] = read(); return m; }
        case 0xdf: { const n = v.getUint32(o); o += 4; const m = {}; for (let i = 0; i < n; i++) m[read()] = read(); return m; }
        default: return `<ext:0x${t.toString(16)}>`;
      }
    };

    try { return { value: read(), offset: o }; } catch { return null; }
  }

  // ─── Protocol detection ────────────────────────────────────
  function decodeStructuredBinary(input) {
    const ab = toAB(input);
    if (!ab) return null;
    const b = new Uint8Array(ab);
    if (!b.length) return null;

    if (b[0] === COLYSEUS_MSG) {
      const ch = msgpackDecode(ab, 1);
      if (!ch) return null;
      const body = (b.byteLength > ch.offset) ? msgpackDecode(ab, ch.offset)?.value ?? null : null;
      return { transport: "colyseus", channel: ch.value, body };
    }

    if (b[0] === 4) {
      const dec = msgpackDecode(ab.slice(1), 0)?.value;
      if (!dec || typeof dec !== "object") return null;
      const d = dec.data;
      return {
        transport: "blueboat",
        eventName: Array.isArray(d) ? d[0] : null,
        payload:   Array.isArray(d) ? d[1] : d,
        _raw: dec,
      };
    }

    return null;
  }

  // ─── Packet parsers ─────────────────────────────────────────
  function parseText(text) {
    if (typeof text !== "string") return { raw: text };
    const et = text[0];
    const en = ENGINE_TYPES[et] ?? "UNKNOWN";
    const payload = text.slice(1);
    if (et !== "4") return { engineType: et, engineName: en, payload, raw: text };
    const st = payload[0];
    const sn = SOCKET_TYPES[st] ?? "UNKNOWN";
    const body = payload.slice(1);
    return { engineType: et, engineName: en, socketType: st, socketName: sn, body, json: tryJson(body), raw: text };
  }

  function parseBinary(value) {
    // Blob: decode asynchronously, return a mutable meta object
    if (value instanceof Blob) {
      const meta = { kind: "Blob", bytes: value.size, text: null, json: null, hex: null, _loading: true };
      value.arrayBuffer().then(ab => {
        const u8 = new Uint8Array(ab);
        meta.hex = hexDump(u8);
        if (decodeEnabled) {
          const d = decodeStructuredBinary(ab);
          if (d) { meta.transport = d.transport; meta.json = d; meta.text = JSON.stringify(d); }
        }
        if (!meta.text) { try { meta.text = new TextDecoder("utf-8", { fatal: true }).decode(u8); } catch {} }
        if (!meta.json && meta.text) meta.json = tryJson(meta.text);
        meta._loading = false;
        const p = packets.find(x => x.parsed === meta);
        if (p) { if (p.id === selectedId) openViewer(p); scheduleRender(); }
      }).catch(() => { meta._loading = false; });
      return meta;
    }

    const ab = toAB(value);
    if (!ab) return { kind: typeof value, bytes: 0, hex: null, text: null, json: null };

    const u8 = new Uint8Array(ab);
    const hex = hexDump(u8);
    let text = null, json = null, transport = null;

    if (decodeEnabled) {
      const d = decodeStructuredBinary(ab);
      if (d) { transport = d.transport; json = d; text = JSON.stringify(d); }
    }
    if (!text) { try { text = new TextDecoder("utf-8", { fatal: true }).decode(u8); } catch {} }
    if (!json && text) json = tryJson(text);

    return { kind: "Binary", bytes: u8.length, text, json, hex, transport };
  }

  // ─── Type tag ───────────────────────────────────────────────
  function typeTag(parsed) {
    if (parsed._tag) return parsed._tag;
    let t;
    const tr = parsed.transport;
    if      (tr === "colyseus") t = `colyseus/${String(parsed.channel ?? "?")}`;
    else if (tr === "blueboat") t = parsed.eventName ? `blueboat/${parsed.eventName}` : "blueboat";
    else if (parsed.socketName && parsed.socketName !== "UNKNOWN") t = parsed.socketName;
    else if (parsed.engineName && parsed.engineName !== "UNKNOWN") t = parsed.engineName;
    else if (parsed.kind)  t = `${parsed.kind}:${parsed.bytes ?? "?"}B`;
    else t = "RAW";
    return (parsed._tag = t);
  }

  function fullBody(parsed) {
    if (parsed.json) { try { return JSON.stringify(parsed.json, null, 2); } catch {} }
    if (parsed.text)         return parsed.text;
    if (parsed.raw != null)  return String(parsed.raw);
    if (parsed.hex)          return parsed.hex;
    return JSON.stringify(parsed, null, 2);
  }

  function payloadSize(parsed) {
    if (parsed._sz != null)  return parsed._sz;
    if (parsed.bytes != null) return (parsed._sz = parsed.bytes);
    return (parsed._sz = fullBody(parsed).length);
  }

  // Deterministic hue from type name — djb2 variant, skips 0-30° (red)
  function hueForType(type) {
    let h = 5381;
    for (let i = 0; i < type.length; i++) h = ((h << 5) ^ h ^ type.charCodeAt(i)) >>> 0;
    return (h % 300 + 30) % 360;
  }

  // ─── Filter ─────────────────────────────────────────────────
  function parseFilter(raw) {
    filter.query = ""; filter.type = ""; filter.flaggedOnly = false;
    filter.isRegex = false; filter.re = null;

    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    const free = [];
    for (const t of tokens) {
      if (t.startsWith("dir:")) {
        const v = t.slice(4).toUpperCase();
        if ("ALL IN OUT".includes(v)) filter.direction = v;
      } else if (t.startsWith("type:")) {
        filter.type = t.slice(5).toLowerCase();
      } else if (t === "flagged" || t === "flagged:true") {
        filter.flaggedOnly = true;
      } else {
        free.push(t);
      }
    }

    const q = free.join(" ");
    if (q.startsWith("/") && q.length > 1) {
      const li = q.lastIndexOf("/");
      const [pat, flags] = li > 0 ? [q.slice(1, li), q.slice(li + 1)] : [q.slice(1), "i"];
      try { filter.re = new RegExp(pat, flags); filter.isRegex = true; filter.query = q; }
      catch  { filter.query = q.toLowerCase(); }
    } else {
      filter.query = q.toLowerCase();
    }
  }

  function matchesFilter(p) {
    if (filter.direction !== "ALL" && p.direction !== filter.direction) return false;
    if (filter.flaggedOnly && !flaggedIds.has(p.id)) return false;
    const tag = typeTag(p.parsed).toLowerCase();
    if (filter.type && !tag.includes(filter.type)) return false;
    if (filter.query) {
      const hay = `${tag} ${fullBody(p.parsed)}`;
      return filter.isRegex ? filter.re.test(hay) : hay.toLowerCase().includes(filter.query);
    }
    return true;
  }

  const filteredPackets = () => packets.filter(matchesFilter);

  // ═══════════════════════════════════════════════════════════
  //  Stats & Sparkline
  // ═══════════════════════════════════════════════════════════

  function advanceSlot() {
    const now = Date.now();
    const n = Math.min(SPARKLINE_SLOTS, Math.floor((now - lastSlotTs) / SLOT_MS));
    for (let i = 0; i < n; i++) {
      slotIdx = (slotIdx + 1) % SPARKLINE_SLOTS;
      sparklinePkt[slotIdx] = 0;
      sparklineB[slotIdx]   = 0;
    }
    if (n > 0) lastSlotTs = now - (now - lastSlotTs) % SLOT_MS;
  }

  function recordInSlot(bytes) {
    advanceSlot();
    sparklinePkt[slotIdx]++;
    sparklineB[slotIdx] += bytes;
  }

  function recentPPS() {
    advanceSlot();
    let t = 0;
    for (let i = 0; i < 5; i++) t += sparklinePkt[(slotIdx - i + SPARKLINE_SLOTS) % SPARKLINE_SLOTS];
    return (t / (5 * SLOT_MS / 1000)).toFixed(1);
  }

  function recentBPS() {
    advanceSlot();
    let t = 0;
    for (let i = 0; i < 5; i++) t += sparklineB[(slotIdx - i + SPARKLINE_SLOTS) % SPARKLINE_SLOTS];
    return t / (5 * SLOT_MS / 1000);
  }

  function sparklineData() {
    advanceSlot();
    const d = [];
    for (let i = 1; i <= SPARKLINE_SLOTS; i++) d.push(sparklinePkt[(slotIdx + i) % SPARKLINE_SLOTS]);
    return d;
  }

  function renderSparkline() {
    if (!sparklineSvgEl) return;
    const d = sparklineData();
    const max = Math.max(...d, 1);
    const W = 90, H = 20, bw = W / SPARKLINE_SLOTS;
    sparklineSvgEl.innerHTML = d.map((v, i) => {
      const h = Math.max(1, (v / max) * H);
      const a = (0.2 + (v / max) * 0.8).toFixed(2);
      return `<rect x="${(i * bw).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 0.5).toFixed(1)}" height="${h.toFixed(1)}" rx="0.5" fill="var(--acc)" opacity="${a}"/>`;
    }).join("");
  }

  function updateStats() {
    if (!statsLineEl) return;
    const open = [...wsMap.keys()].filter(ws => ws.readyState === 1).length;
    statsLineEl.textContent = `${packets.length} packets  ·  ${recentPPS()} pkt/s  ·  ${fmtBytes(recentBPS())}/s  ·  ↓${inCount}  ↑${outCount}`;
    if (connBadgeEl) {
      connBadgeEl.textContent = `${open} conn`;
      connBadgeEl.style.color = open ? "var(--grn)" : "var(--txt2)";
    }
    renderSparkline();
  }

  // ═══════════════════════════════════════════════════════════
  //  Styles
  // ═══════════════════════════════════════════════════════════

  function injectStyles() {
    const s = document.createElement("style");
    s.textContent = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');

#zs {
  --bg:    #111215;
  --bg1:   #16181d;
  --bg2:   #1c1e25;
  --bg3:   #23252e;
  --bdr:   #252830;
  --bdr2:  #30333f;
  --txt:   #bfc2cc;
  --txt2:  #676c7a;
  --txt3:  #383c47;
  --acc:   #6a8fff;
  --acc-b: rgba(106,143,255,.28);
  --acc-g: rgba(106,143,255,.07);
  --in:    #42baff;
  --in-b:  rgba(66,186,255,.22);
  --in-g:  rgba(66,186,255,.07);
  --out:   #ff9f4a;
  --out-b: rgba(255,159,74,.22);
  --out-g: rgba(255,159,74,.07);
  --grn:   #50d48a;
  --red:   #f06060;
  --yel:   #ffc94a;
  --r:     4px;
  --font:  'JetBrains Mono','Cascadia Code',ui-monospace,monospace;
}
#zs *, #zs *::before, #zs *::after { box-sizing:border-box; margin:0; padding:0; }
#zs {
  position:fixed; top:0; right:0; width:${DEFAULT_WIDTH}px; height:100vh;
  z-index:999999; display:flex; flex-direction:column;
  font-family:var(--font); font-size:12px;
  background:var(--bg); border-left:1px solid var(--bdr2);
  box-shadow:-6px 0 28px rgba(0,0,0,.55);
  transform:translateX(0); transition:transform .2s ease;
  user-select:none; color:var(--txt);
}
#zs.hidden { transform:translateX(100%); }

/* resize handle */
#zs-rh { position:absolute; left:0; top:0; width:4px; height:100%; cursor:ew-resize; z-index:10; }
#zs-rh:hover, #zs-rh.drag { background:var(--acc-b); }

/* header */
#zs-hdr {
  display:flex; align-items:center; gap:5px; flex-wrap:nowrap;
  padding:9px 12px; background:var(--bg1);
  border-bottom:1px solid var(--bdr); flex-shrink:0;
}
#zs-logo { color:var(--acc); font-weight:700; font-size:13px; letter-spacing:.04em; flex-shrink:0; margin-right:2px; }
#zs-spark { flex-shrink:0; display:block; opacity:.85; }
#zs-sp { flex:1; }
#zs-conn { font-size:10px; color:var(--txt2); border:1px solid var(--bdr2); border-radius:var(--r); padding:2px 6px; flex-shrink:0; }

/* generic button */
.zb {
  background:transparent; border:1px solid var(--bdr2); color:var(--txt2);
  border-radius:var(--r); cursor:pointer; font-family:var(--font); font-size:11px;
  padding:3px 7px; white-space:nowrap; flex-shrink:0;
  transition:color .1s, border-color .1s, background .1s;
}
.zb:hover { color:var(--txt); }
.zb.on { color:var(--acc); border-color:var(--acc-b); background:var(--acc-g); }
.zb.warn { color:var(--red); border-color:rgba(240,96,96,.25); }
.zb.warn:hover { background:rgba(240,96,96,.07); }

/* controls bar */
#zs-ctl {
  display:flex; gap:5px; padding:7px 10px; align-items:center;
  border-bottom:1px solid var(--bdr); background:var(--bg1); flex-shrink:0;
}
#zs-fi {
  flex:1; min-width:0;
  background:var(--bg2); border:1px solid var(--bdr2); border-radius:var(--r);
  color:var(--txt); font-family:var(--font); font-size:12px; padding:4px 8px; outline:none;
}
#zs-fi:focus { border-color:var(--acc-b); background:var(--bg3); }
#zs-fi.rx { border-color:rgba(255,201,74,.35); color:var(--yel); }
#zs-fi::placeholder { color:var(--txt3); }

/* stats bar */
#zs-st { padding:5px 10px; font-size:11px; color:var(--txt2); border-bottom:1px solid var(--bdr); flex-shrink:0; }

/* confirm banners */
.zs-cfm { display:none; padding:5px 10px; font-size:11px; border-bottom:1px solid var(--bdr); flex-shrink:0; }
#zs-clr-cfm { color:var(--red); background:rgba(240,96,96,.04); }
#zs-rst-cfm { color:var(--yel); background:rgba(255,201,74,.04); }
.zy { color:var(--txt); cursor:pointer; margin-left:6px; text-decoration:underline; }
.zn { color:var(--txt2); cursor:pointer; margin-left:5px; text-decoration:underline; }

/* body */
#zs-body { flex:1; display:flex; min-height:0; overflow:hidden; }
#zs-lp { flex:1; display:flex; flex-direction:column; min-width:200px; overflow:hidden; }
#zs-lm {
  display:flex; justify-content:space-between; align-items:center;
  padding:4px 10px; font-size:10px; color:var(--txt2);
  border-bottom:1px solid var(--bdr); background:var(--bg1); flex-shrink:0;
}
#zs-list { flex:1; overflow-y:auto; overflow-x:hidden; }

/* section label */
.zs-sec {
  padding:3px 10px; font-size:9px; color:var(--txt3);
  letter-spacing:.1em; text-transform:uppercase;
  border-bottom:1px solid var(--bdr); background:var(--bg1);
}

/* packet row — 5-column grid: id | dir | (type+time) | size | actions */
.zr {
  display:grid;
  grid-template-columns:38px 26px 1fr auto 72px;
  gap:0 6px; align-items:start;
  padding:5px 10px 5px 14px;
  border-bottom:1px solid var(--bdr);
  cursor:pointer; min-width:0; position:relative;
}
.zr::before { content:''; position:absolute; left:0; top:0; bottom:0; width:2px; }
.zr.zin::before  { background:var(--in);  opacity:.4; }
.zr.zout::before { background:var(--out); opacity:.4; }
.zr:hover         { background:var(--bg2); }
.zr:hover::before { opacity:1; }
.zr.sel           { background:var(--bg2); }
.zr.sel::before   { opacity:1; }

.zr-id  { font-size:10px; color:var(--txt3); text-align:right; padding-top:2px; }
.zr-dir { font-size:9px; font-weight:700; padding:2px 3px; border-radius:2px; text-align:center; margin-top:2px; }
.zr-dir.zin  { color:var(--in);  background:var(--in-g);  }
.zr-dir.zout { color:var(--out); background:var(--out-g); }
.zr-cell { min-width:0; }
.zr-type { font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.zr-ts   { font-size:9px; color:var(--txt3); margin-top:2px; display:none; }
#zs-list.tson .zr-ts { display:block; }
.zr-sz  { font-size:10px; color:var(--txt3); text-align:right; padding-top:2px; white-space:nowrap; }
.zr-act { display:flex; align-items:center; justify-content:flex-end; gap:3px; padding-top:1px; opacity:0; }
.zr:hover .zr-act   { opacity:1; }
.zr.has-flag .zr-act { opacity:1; }
.zr-flag { background:none; border:none; cursor:pointer; color:var(--txt3); font-size:13px; line-height:1; padding:0 1px; }
.zr-flag:hover, .zr-flag.on { color:var(--yel); }
.zr-resent { font-size:9px; color:var(--yel); border:1px solid rgba(255,201,74,.3); border-radius:2px; padding:1px 3px; }

/* divider */
#zs-dvd { width:4px; flex-shrink:0; cursor:col-resize; display:none; background:var(--bdr); }
#zs-dvd.vis { display:block; }
#zs-dvd:hover, #zs-dvd.drag { background:var(--acc-b); }

/* viewer panel */
#zs-vwr { display:none; flex-direction:column; min-width:240px; overflow:hidden; }
#zs-vwr.vis { display:flex; }
#zs-vhdr {
  display:flex; gap:5px; align-items:flex-start;
  padding:8px 10px; border-bottom:1px solid var(--bdr); background:var(--bg1); flex-shrink:0;
}
.zs-vdir { font-size:9px; font-weight:700; padding:2px 5px; border-radius:2px; flex-shrink:0; margin-top:2px; }
.zs-vdir.zin  { color:var(--in);  background:var(--in-g);  border:1px solid var(--in-b);  }
.zs-vdir.zout { color:var(--out); background:var(--out-g); border:1px solid var(--out-b); }
#zs-vmeta { flex:1; min-width:0; }
#zs-vtype { color:var(--txt); font-size:12px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#zs-vinfo { color:var(--txt2); font-size:10px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.zvb {
  background:transparent; border:1px solid var(--bdr2); color:var(--txt2);
  border-radius:var(--r); cursor:pointer; font-family:var(--font); font-size:11px;
  padding:2px 7px; flex-shrink:0;
}
.zvb:hover { color:var(--txt); }

/* viewer tabs */
#zs-tabs {
  display:flex; align-items:stretch; gap:10px; padding:0 10px;
  border-bottom:1px solid var(--bdr); background:var(--bg1); flex-shrink:0;
}
.zt-sep { flex:1; min-width:18px; }
.zt {
  background:none; border:none; border-bottom:2px solid transparent;
  color:var(--txt2); font-family:var(--font); font-size:11px;
  padding:6px 16px; cursor:pointer; margin-bottom:-1px; white-space:nowrap;
}
.zt:hover { color:var(--txt); }
.zt.on { color:var(--acc); border-bottom-color:var(--acc); }

/* viewer panes */
#zs-vbody { flex:1; position:relative; min-height:0; }
.zp { position:absolute; inset:0; overflow:auto; display:none; padding:10px; user-select:text; }
.zp.on { display:block; }

/* JSON tree */
.zjn  { font-size:12px; line-height:1.65; }
.zjr  { white-space:pre; }
.zjt  { display:inline-block; width:12px; cursor:pointer; color:var(--txt3); }
.zjt:hover { color:var(--txt2); }
.zjk  { color:#7eb3f5; }
.zjs  { color:#92c97a; }
.zjn2 { color:#d09e5a; }
.zjb  { color:#d06060; }
.zjz  { color:var(--txt3); }
.zjch { margin-left:16px; }
.zjhide { display:none; }
.zjsm { cursor:pointer; color:var(--txt3); font-size:10px; }
.zjsm:hover { color:var(--txt2); text-decoration:underline; }

/* raw / hex panes */
#zs-raw, #zs-hex { white-space:pre; font-size:11px; color:var(--txt); line-height:1.7; font-family:var(--font); }

/* diff pane */
#zs-diff { white-space:pre-wrap; font-size:11px; line-height:1.7; font-family:var(--font); }
.da { color:var(--grn); background:rgba(80,212,138,.06); display:block; }
.dd { color:var(--red); background:rgba(240,96,96,.06); display:block; }
.ds { color:var(--txt2); display:block; }

/* resend pane */
#zs-re-ed {
  width:100%; background:var(--bg2); color:var(--txt);
  border:1px solid var(--bdr2); border-radius:var(--r);
  font-family:var(--font); font-size:12px; padding:8px; outline:none;
  resize:none; flex:1; min-height:0;
}
#zs-re-ed:focus { border-color:var(--acc-b); }
#zs-re-ft { display:flex; align-items:center; gap:8px; flex-shrink:0; margin-top:6px; }
#zs-re-err { font-size:11px; color:var(--red); flex:1; }
#zs-resend-p.on { display:flex !important; flex-direction:column; }

/* context menu */
#zs-ctx {
  position:fixed; display:none;
  background:var(--bg2); border:1px solid var(--bdr2);
  z-index:1000001; padding:3px; border-radius:var(--r);
  box-shadow:0 6px 24px rgba(0,0,0,.55); min-width:170px;
}
.zci { padding:5px 10px; color:var(--txt2); cursor:pointer; font-size:12px; border-radius:2px; }
.zci:hover { background:var(--bg3); color:var(--txt); }
.zcs { height:1px; background:var(--bdr); margin:3px 6px; }

/* footer */
#zs-ftr {
  padding:4px 10px; font-size:10px; color:var(--txt3);
  border-top:1px solid var(--bdr); display:flex; justify-content:space-between;
  background:var(--bg1); flex-shrink:0;
}

/* scrollbars */
#zs-list, .zp, #zs-re-ed { scrollbar-width:thin; scrollbar-color:var(--bdr2) transparent; }
#zs-list::-webkit-scrollbar, .zp::-webkit-scrollbar, #zs-re-ed::-webkit-scrollbar { width:5px; height:5px; }
#zs-list::-webkit-scrollbar-thumb, .zp::-webkit-scrollbar-thumb, #zs-re-ed::-webkit-scrollbar-thumb {
  background:var(--bdr2); border-radius:3px;
}
#zs-list::-webkit-scrollbar-thumb:hover, .zp::-webkit-scrollbar-thumb:hover { background:var(--txt3); }
    `.trim();
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════
  //  Build sidebar DOM
  // ═══════════════════════════════════════════════════════════

  function buildSidebar() {
    sidebar = document.createElement("div");
    sidebar.id = "zs";
    sidebar.innerHTML = `
<div id="zs-rh"></div>
<div id="zs-hdr">
  <span id="zs-logo">PacketSniff</span>
  <svg id="zs-spark" width="90" height="20" viewBox="0 0 90 20"></svg>
  <div id="zs-sp"></div>
  <span id="zs-conn">0 conn</span>
  <button id="zs-pause" class="zb">Pause</button>
  <button id="zs-as"    class="zb on" title="Auto-scroll">↓</button>
  <button id="zs-ts"    class="zb on" title="Timestamps">⏱</button>
  <button id="zs-dec"   class="zb on" title="Decode binary">Decode</button>
  <button id="zs-exp"   class="zb">Export</button>
  <button id="zs-rst"   class="zb">Reset</button>
  <button id="zs-tog"   class="zb">Hide [K]</button>
</div>
<div id="zs-ctl">
  <input id="zs-fi" type="text"
    placeholder="filter…  dir:in  type:event  /regex/  flagged"
    autocomplete="off" spellcheck="false" />
  <button class="zb zd on" data-dir="ALL">All</button>
  <button class="zb zd"    data-dir="IN">In</button>
  <button class="zb zd"    data-dir="OUT">Out</button>
  <button id="zs-ff"  class="zb" title="Flagged only">★</button>
  <button id="zs-clr" class="zb warn">Clear</button>
</div>
<div id="zs-st"><span id="zs-stl">ready</span></div>
<div id="zs-clr-cfm" class="zs-cfm"></div>
<div id="zs-rst-cfm" class="zs-cfm"></div>
<div id="zs-body">
  <div id="zs-lp">
    <div id="zs-lm">
      <span id="zs-cnt">0 / 0</span>
      <span id="zs-pn"></span>
    </div>
    <div id="zs-list"></div>
  </div>
  <div id="zs-dvd"></div>
  <div id="zs-vwr">
    <div id="zs-vhdr">
      <span id="zs-vd" class="zs-vdir zin">IN</span>
      <div id="zs-vmeta">
        <div id="zs-vtype">—</div>
        <div id="zs-vinfo">—</div>
      </div>
      <button id="zs-cpj" class="zvb">Copy JSON</button>
      <button id="zs-cpc" class="zvb">Copy Code</button>
      <button id="zs-edt" class="zvb">Edit + Send</button>
      <button id="zs-vcl" class="zvb">✕</button>
    </div>
    <div id="zs-tabs">
      <button class="zt on" data-tab="json">JSON</button>
      <button class="zt"    data-tab="raw">Raw</button>
      <button class="zt"    data-tab="hex">Hex</button>
      <div class="zt-sep"></div>
      <button class="zt"    data-tab="diff">Diff</button>
      <button class="zt"    data-tab="resend">Resend</button>
    </div>
    <div id="zs-vbody">
      <div class="zp on" id="zs-json-p"><div id="zs-jtree"></div></div>
      <div class="zp"    id="zs-raw-p"><pre id="zs-raw"></pre></div>
      <div class="zp"    id="zs-hex-p"><pre id="zs-hex"></pre></div>
      <div class="zp"    id="zs-diff-p">
        <pre id="zs-diff">Right-click a packet → "Pin for diff", right-click another → "Diff with pinned".</pre>
      </div>
      <div class="zp"    id="zs-resend-p">
        <textarea id="zs-re-ed" spellcheck="false"></textarea>
        <div id="zs-re-ft">
          <button id="zs-send" class="zvb">Send</button>
          <span   id="zs-re-err"></span>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="zs-ftr">
  <span id="zs-status">ready</span>
  <span>v${VERSION} · [K] toggle · [/] filter · [↑↓] navigate · [Esc] close</span>
</div>`;
    document.body.appendChild(sidebar);

    // Cache refs
    listEl          = sidebar.querySelector("#zs-list");
    countEl         = sidebar.querySelector("#zs-cnt");
    filterInput     = sidebar.querySelector("#zs-fi");
    viewerPanel     = sidebar.querySelector("#zs-vwr");
    bodyEl          = sidebar.querySelector("#zs-body");
    dividerEl       = sidebar.querySelector("#zs-dvd");
    statsLineEl     = sidebar.querySelector("#zs-stl");
    statusEl        = sidebar.querySelector("#zs-status");
    pauseBtnEl      = sidebar.querySelector("#zs-pause");
    autoscrollBtnEl = sidebar.querySelector("#zs-as");
    clearConfirmEl  = sidebar.querySelector("#zs-clr-cfm");
    resetConfirmEl  = sidebar.querySelector("#zs-rst-cfm");
    sparklineSvgEl  = sidebar.querySelector("#zs-spark");
    connBadgeEl     = sidebar.querySelector("#zs-conn");

    // Context menu (appended to body so it can overflow the sidebar)
    contextMenuEl = document.createElement("div");
    contextMenuEl.id = "zs-ctx";
    contextMenuEl.innerHTML = `
<div class="zci" data-a="pin">📌  Pin for diff</div>
<div class="zci" data-a="pin-top">⬆  Toggle pin to top</div>
<div class="zci" data-a="diff">⬛  Diff with pinned</div>
<div class="zcs"></div>
<div class="zci" data-a="flag">★  Toggle flag</div>
<div class="zci" data-a="copy">⎘  Copy JSON</div>
<div class="zci" data-a="code">⌗  Copy as code</div>`;
    document.body.appendChild(contextMenuEl);

    // Start with timestamps enabled
    listEl.classList.add("tson");

    wireEvents();
    applyMargin();
    setInterval(updateStats, 800);
  }

  // ═══════════════════════════════════════════════════════════
  //  Wire events
  // ═══════════════════════════════════════════════════════════

  function wireEvents() {
    // ── Header ──────────────────────────────────────────────
    sidebar.querySelector("#zs-tog").addEventListener("click", toggleSidebar);
    pauseBtnEl.addEventListener("click", togglePause);
    autoscrollBtnEl.addEventListener("click", () => setAS(!autoScroll, true));

    sidebar.querySelector("#zs-ts").addEventListener("click", e => {
      showTimestamps = !showTimestamps;
      e.currentTarget.classList.toggle("on", showTimestamps);
      listEl.classList.toggle("tson", showTimestamps);
    });

    sidebar.querySelector("#zs-dec").addEventListener("click", e => {
      decodeEnabled = !decodeEnabled;
      e.currentTarget.classList.toggle("on", decodeEnabled);
    });

    sidebar.querySelector("#zs-exp").addEventListener("click", exportPackets);

    sidebar.querySelector("#zs-rst").addEventListener("click", () => {
      clearConfirmEl.style.display = "none";
      resetConfirmEl.style.display = "block";
      resetConfirmEl.innerHTML = `Reset session? <span class="zy" data-r="yes">Yes</span><span class="zn" data-r="no">No</span>`;
    });

    // ── Controls ────────────────────────────────────────────
    filterInput.addEventListener("input", () => {
      clearTimeout(filterDebounceTimer);
      filterDebounceTimer = setTimeout(() => {
        parseFilter(filterInput.value);
        filterInput.classList.toggle("rx", filter.isRegex);
        scheduleRender();
      }, FILTER_DEBOUNCE);
    });

    sidebar.querySelectorAll(".zd").forEach(b => b.addEventListener("click", () => {
      filter.direction = b.dataset.dir;
      sidebar.querySelectorAll(".zd").forEach(x => x.classList.toggle("on", x.dataset.dir === filter.direction));
      scheduleRender();
    }));

    sidebar.querySelector("#zs-ff").addEventListener("click", e => {
      filter.flaggedOnly = !filter.flaggedOnly;
      e.currentTarget.classList.toggle("on", filter.flaggedOnly);
      scheduleRender();
    });

    sidebar.querySelector("#zs-clr").addEventListener("click", () => {
      resetConfirmEl.style.display = "none";
      clearConfirmEl.style.display = "block";
      clearConfirmEl.innerHTML = `Clear ${packets.length} packets? <span class="zy" data-c="yes">Yes</span><span class="zn" data-c="no">No</span>`;
    });

    clearConfirmEl.addEventListener("click", e => {
      const c = e.target.dataset.c;
      if (!c) return;
      clearConfirmEl.style.display = "none";
      if (c === "yes") clearPackets();
    });

    resetConfirmEl.addEventListener("click", e => {
      const r = e.target.dataset.r;
      if (!r) return;
      resetConfirmEl.style.display = "none";
      if (r === "yes") resetSession();
    });

    // Detect manual scroll to disable auto-scroll
    listEl.addEventListener("scroll", () => {
      if (!autoScroll) return;
      if (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight > 40) setAS(false, false);
    });

    // ── Viewer ──────────────────────────────────────────────
    sidebar.querySelector("#zs-vcl").addEventListener("click", closeViewer);

    sidebar.querySelectorAll(".zt").forEach(t =>
      t.addEventListener("click", () => setTab(t.dataset.tab)));

    sidebar.querySelector("#zs-cpj").addEventListener("click", async () => {
      const p = packets.find(x => x.id === selectedId);
      if (p) { await navigator.clipboard.writeText(JSON.stringify(p.parsed.json ?? p.parsed, null, 2)); setStatus("Copied to clipboard"); }
    });

    sidebar.querySelector("#zs-cpc").addEventListener("click", () => {
      const p = packets.find(x => x.id === selectedId);
      if (p) copyAsCode(p);
    });

    sidebar.querySelector("#zs-edt").addEventListener("click", () => {
      setTab("resend");
      const p = packets.find(x => x.id === selectedId);
      if (!p) return;
      sidebar.querySelector("#zs-re-ed").value = getEditableResendBody(p);
      sidebar.querySelector("#zs-re-err").textContent = "";
    });

    sidebar.querySelector("#zs-send").addEventListener("click", doResend);

    // ── Context menu ────────────────────────────────────────
    contextMenuEl.addEventListener("click", async e => {
      const a  = e.target.closest("[data-a]")?.dataset.a;
      const id = Number(contextMenuEl.dataset.id);
      const p  = packets.find(x => x.id === id);
      contextMenuEl.style.display = "none";
      if (!p || !a) return;
      if      (a === "pin")     { selectedForDiffId = p.id; setStatus(`Pinned #${p.id} for diff`); }
      else if (a === "pin-top") { pinnedIds.has(p.id) ? pinnedIds.delete(p.id) : pinnedIds.add(p.id); scheduleRender(); }
      else if (a === "diff")    { showDiff(selectedForDiffId, p.id); }
      else if (a === "flag")    { toggleFlag(p); }
      else if (a === "copy")    { await navigator.clipboard.writeText(JSON.stringify(p.parsed.json ?? p.parsed, null, 2)); setStatus("Copied"); }
      else if (a === "code")    { copyAsCode(p); }
    });

    document.addEventListener("click", e => {
      if (!contextMenuEl.contains(e.target)) contextMenuEl.style.display = "none";
    });

    // ── Keyboard shortcuts ──────────────────────────────────
    document.addEventListener("keydown", e => {
      const inInput = ["INPUT","TEXTAREA"].includes(document.activeElement?.tagName);

      // [K] – toggle sidebar (always)
      if (e.key === "k" && !inInput && !e.ctrlKey && !e.metaKey) { toggleSidebar(); return; }

      if (!sidebarOpen) return;

      // [/] – focus filter
      if (e.key === "/" && !inInput) { filterInput.focus(); e.preventDefault(); return; }

      if (inInput) return;

      // [Esc] – close viewer
      if (e.key === "Escape") { closeViewer(); return; }

      // [↑] / [↓] – navigate packets
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const vis  = filteredPackets();
        const i    = vis.findIndex(p => p.id === selectedId);
        const next = e.key === "ArrowDown"
          ? (vis[i + 1] ?? (selectedId == null ? vis[0] : null))
          : vis[i - 1];
        if (next) {
          openViewer(next);
          listEl.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
        }
        e.preventDefault();
      }
    });

    // ── Sidebar resize ──────────────────────────────────────
    const rh = sidebar.querySelector("#zs-rh");
    let rsDrag = false, rsX = 0, rsW = 0;
    rh.addEventListener("mousedown", e => {
      rsDrag = true; rsX = e.clientX; rsW = sidebar.offsetWidth;
      rh.classList.add("drag");
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", e => {
      if (!rsDrag) return;
      const w = Math.max(MIN_WIDTH, Math.min(rsW + rsX - e.clientX, window.innerWidth * 0.95));
      currentWidth = w; sidebar.style.width = `${w}px`;
      if (sidebarOpen) document.body.style.marginRight = `${w}px`;
    });
    document.addEventListener("mouseup", () => {
      if (!rsDrag) return;
      rsDrag = false; rh.classList.remove("drag");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });

    // ── Viewer split drag ───────────────────────────────────
    let vDrag = false;
    dividerEl.addEventListener("mousedown", e => {
      if (!viewerPanel.classList.contains("vis")) return;
      vDrag = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", e => {
      if (!vDrag) return;
      const r = bodyEl.getBoundingClientRect();
      const w = Math.max(240, Math.min(r.width - 200, r.right - e.clientX));
      viewerWidthPx = w; viewerPanel.style.width = `${w}px`;
    });
    document.addEventListener("mouseup", () => {
      if (!vDrag) return;
      vDrag = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Rendering — rAF-batched to avoid multi-rebuild per frame
  // ═══════════════════════════════════════════════════════════

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => { renderScheduled = false; rerenderList(); });
  }

  function createRow(p) {
    const el  = document.createElement("div");
    const dir = p.direction === "IN" ? "zin" : "zout";
    const tag = typeTag(p.parsed);
    const hue = hueForType(tag);
    const fl  = flaggedIds.has(p.id);

    el.className = `zr ${dir}${selectedId === p.id ? " sel" : ""}${fl ? " has-flag" : ""}`;
    el.dataset.id = p.id;
    el.innerHTML = `
<span class="zr-id">#${p.id}</span>
<span class="zr-dir ${dir}">${p.direction}</span>
<div class="zr-cell">
  <div class="zr-type" style="color:hsl(${hue},52%,62%)" title="${esc(tag)}">${esc(tag)}</div>
  <div class="zr-ts">${fmtRel(p.timestamp)}</div>
</div>
<span class="zr-sz">${fmtBytes(payloadSize(p.parsed))}</span>
<div class="zr-act">
  ${p.resent ? '<span class="zr-resent">RESEND</span>' : ''}
  <button class="zr-flag${fl ? " on" : ""}" title="Flag (F)">★</button>
</div>`;

    el.querySelector(".zr-flag").addEventListener("click", e => { e.stopPropagation(); toggleFlag(p); });

    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      contextMenuEl.dataset.id = p.id;
      const x = Math.min(e.clientX, window.innerWidth  - 190);
      const y = Math.min(e.clientY, window.innerHeight - 180);
      contextMenuEl.style.left    = `${x}px`;
      contextMenuEl.style.top     = `${y}px`;
      contextMenuEl.style.display = "block";
      e.stopPropagation();
    });

    el.addEventListener("click", () => selectedId === p.id ? closeViewer() : openViewer(p));
    return el;
  }

  function rerenderList() {
    const vis    = filteredPackets();
    const pinned = vis.filter(p => pinnedIds.has(p.id));
    const rest   = vis.filter(p => !pinnedIds.has(p.id));

    listEl.innerHTML = "";
    const frag = document.createDocumentFragment();

    if (pinned.length) {
      const s = document.createElement("div");
      s.className = "zs-sec"; s.textContent = "Pinned";
      frag.appendChild(s);
      pinned.forEach(p => frag.appendChild(createRow(p)));
    }

    if (rest.length) {
      if (pinned.length) {
        const s = document.createElement("div");
        s.className = "zs-sec"; s.textContent = "All";
        frag.appendChild(s);
      }
      rest.forEach(p => frag.appendChild(createRow(p)));
    }

    listEl.appendChild(frag);
    countEl.textContent = `${vis.length} / ${packets.length}`;
    if (autoScroll) listEl.scrollTop = listEl.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════
  //  Viewer
  // ═══════════════════════════════════════════════════════════

  function setTab(name) {
    sidebar.querySelectorAll(".zt").forEach(t => t.classList.toggle("on", t.dataset.tab === name));
    sidebar.querySelectorAll(".zp").forEach(p => p.classList.toggle("on", p.id === `zs-${name}-p`));
  }

  function openViewer(p) {
    selectedId = p.id;
    viewerPanel.classList.add("vis");
    dividerEl.classList.add("vis");
    viewerPanel.style.width = `${viewerWidthPx}px`;
    viewerPanel.style.flex  = "0 0 auto";

    const dir     = p.direction === "IN" ? "zin" : "zout";
    const vd      = sidebar.querySelector("#zs-vd");
    vd.textContent = p.direction;
    vd.className   = `zs-vdir ${dir}`;

    sidebar.querySelector("#zs-vtype").textContent = typeTag(p.parsed);

    const conn    = wsMap.get(p.ws);
    const urlPart = conn ? ` · ${conn.url.replace(/^wss?:\/\//, "").slice(0, 50)}` : "";
    sidebar.querySelector("#zs-vinfo").textContent =
      `${fmtTime(p.timestamp)} · ${fmtBytes(payloadSize(p.parsed))}${urlPart}`;

    // JSON pane
    const tree = sidebar.querySelector("#zs-jtree");
    tree.innerHTML = "";
    if (p.parsed._loading) {
      const loading = document.createElement("span");
      loading.style.color = "var(--txt2)";
      loading.textContent = "Decoding…";
      tree.appendChild(loading);
    } else {
      tree.appendChild(renderJsonNode(p.parsed.json ?? p.parsed, 0, null));
    }

    // Raw / Hex / Resend panes
    sidebar.querySelector("#zs-raw").textContent    = fullBody(p.parsed);
    sidebar.querySelector("#zs-hex").innerHTML      = p.parsed.hex ?? "(no binary data)";
    sidebar.querySelector("#zs-re-ed").value        = getEditableResendBody(p);

    // Sync selection in list
    listEl.querySelectorAll(".zr").forEach(el =>
      el.classList.toggle("sel", Number(el.dataset.id) === p.id));
  }

  function closeViewer() {
    selectedId = null;
    viewerPanel.classList.remove("vis");
    dividerEl.classList.remove("vis");
    listEl.querySelectorAll(".zr.sel").forEach(el => el.classList.remove("sel"));
  }

  // ═══════════════════════════════════════════════════════════
  //  JSON tree renderer
  // ═══════════════════════════════════════════════════════════

  function renderJsonNode(val, depth, key) {
    const node = document.createElement("div");
    node.className = "zjn";
    const row  = document.createElement("div");
    row.className = "zjr";
    node.appendChild(row);

    const indent  = "  ".repeat(depth);
    const keyHtml = key !== null ? `<span class="zjk">"${esc(String(key))}"</span>: ` : "";

    if (val === null) {
      row.innerHTML = `${indent}${keyHtml}<span class="zjz">null</span>`;
      return node;
    }

    if (typeof val !== "object") {
      let cls = "zjz";
      if (typeof val === "string")  cls = "zjs";
      else if (typeof val === "number")  cls = "zjn2";
      else if (typeof val === "boolean") cls = "zjb";

      const raw = esc(JSON.stringify(val));

      // Truncate very long strings with a "show all" link
      if (typeof val === "string" && val.length > 200) {
        const short = esc(JSON.stringify(val.slice(0, 200)));
        row.innerHTML = `${indent}${keyHtml}<span class="${cls}">${short}<span class="zjsm"> … show all</span></span>`;
        row.querySelector(".zjsm").addEventListener("click", e => {
          e.stopPropagation();
          row.innerHTML = `${indent}${keyHtml}<span class="${cls}">${raw}</span>`;
        });
      } else {
        row.innerHTML = `${indent}${keyHtml}<span class="${cls}">${raw}</span>`;
      }
      return node;
    }

    const isArr  = Array.isArray(val);
    const entries = isArr ? val.map((v, i) => [i, v]) : Object.entries(val);
    const open   = isArr ? "[" : "{";
    const close  = isArr ? "]" : "}";
    const collapsed = entries.length > 12;

    row.innerHTML = `${indent}<span class="zjt">${collapsed ? "▶" : "▼"}</span>${keyHtml}<span style="color:var(--txt2)">${open}</span> <span style="color:var(--txt3);font-size:10px">${entries.length}</span>`;

    const toggle = row.querySelector(".zjt");
    const ch     = document.createElement("div");
    ch.className = "zjch";
    if (collapsed) ch.classList.add("zjhide");

    entries.forEach(([k, v]) => ch.appendChild(renderJsonNode(v, depth + 1, k)));

    const endRow = document.createElement("div");
    endRow.className = "zjr";
    endRow.textContent = `${indent}${close}`;
    ch.appendChild(endRow);

    toggle.addEventListener("click", e => {
      e.stopPropagation();
      ch.classList.toggle("zjhide");
      toggle.textContent = ch.classList.contains("zjhide") ? "▶" : "▼";
    });

    node.appendChild(ch);
    return node;
  }

  // ═══════════════════════════════════════════════════════════
  //  Diff — coloured line-level diff
  // ═══════════════════════════════════════════════════════════

  function showDiff(leftId, rightId) {
    const a = packets.find(p => p.id === leftId);
    const b = packets.find(p => p.id === rightId);
    if (!a || !b) { setStatus("Diff: pin a packet first (right-click → Pin for diff)"); return; }

    setTab("diff");
    const la  = fullBody(a.parsed).split("\n");
    const lb  = fullBody(b.parsed).split("\n");
    const el  = sidebar.querySelector("#zs-diff");
    el.innerHTML = "";

    const hdr = document.createElement("span");
    hdr.className = "ds";
    hdr.textContent = `--- #${a.id}  ${typeTag(a.parsed)}\n+++ #${b.id}  ${typeTag(b.parsed)}\n\n`;
    el.appendChild(hdr);

    const max = Math.max(la.length, lb.length);
    for (let i = 0; i < max; i++) {
      const l = la[i] ?? "", r = lb[i] ?? "";
      if (l === r) {
        const s = document.createElement("span"); s.className = "ds"; s.textContent = `  ${l}\n`; el.appendChild(s);
      } else {
        if (l) { const s = document.createElement("span"); s.className = "dd"; s.textContent = `- ${l}\n`; el.appendChild(s); }
        if (r) { const s = document.createElement("span"); s.className = "da"; s.textContent = `+ ${r}\n`; el.appendChild(s); }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Actions
  // ═══════════════════════════════════════════════════════════

  function toggleFlag(p) {
    p.flagged = !p.flagged;
    p.flagged ? flaggedIds.add(p.id) : flaggedIds.delete(p.id);
    scheduleRender();
  }

  // Generate a ready-to-run JS snippet to replay this packet
  function copyAsCode(p) {
    const openWs = [...wsMap.keys()].find(w => w.readyState === 1);
    const url    = wsMap.get(openWs ?? p.ws)?.url ?? "wss://...";
    const json   = JSON.stringify(p.parsed.json ?? p.parsed, null, 2);
    const code   = `// Resend packet #${p.id}  (${typeTag(p.parsed)})\nconst ws = new WebSocket(${JSON.stringify(url)});\nws.addEventListener("open", () => ws.send(JSON.stringify(\n${json.replace(/^/gm, "  ")}\n)));`;
    navigator.clipboard.writeText(code).then(() => setStatus("Code snippet copied"));
  }

  function getEditableResendBody(p) {
    const raw = p?.parsed?.raw;
    if (typeof raw === "string") return raw;
    if (raw != null && typeof raw !== "object") return String(raw);
    return fullBody(p.parsed);
  }

  function encodeBlueboatPacket(decoded) {
    const raw = decoded?._raw && typeof decoded._raw === "object"
      ? decoded._raw
      : {
          type: 2,
          data: [decoded?.eventName, decoded?.payload],
          options: { compress: true },
          nsp: "/",
        };
    if (!raw?.data) throw new Error("Blueboat resend needs _raw or eventName/payload data.");
    const encoded = msgpackEncode(raw);
    const out = new Uint8Array(1 + encoded.byteLength);
    out[0] = 4;
    out.set(new Uint8Array(encoded), 1);
    return out.buffer;
  }

  function encodeColyseusPacket(decoded) {
    if (!decoded || !("channel" in decoded)) throw new Error("Colyseus resend needs a channel.");
    const channel = new Uint8Array(msgpackEncode(decoded.channel));
    const body = new Uint8Array(msgpackEncode(decoded.body));
    const out = new Uint8Array(1 + channel.length + body.length);
    out[0] = COLYSEUS_MSG;
    out.set(channel, 1);
    out.set(body, 1 + channel.length);
    return out.buffer;
  }

  function encodeStructuredResend(parsed) {
    if (parsed?.transport === "blueboat") return encodeBlueboatPacket(parsed);
    if (parsed?.transport === "colyseus") return encodeColyseusPacket(parsed);
    return null;
  }

  function getResendPayloadFromEditor(p, text) {
    const fallbackRaw = p?.parsed?.raw;

    // Text packets already have an exact wire-format string (Engine.IO / Socket.IO).
    // If the user leaves or edits that raw text, send that text directly.
    if (typeof fallbackRaw === "string") {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && typeof parsed.raw === "string") return parsed.raw;
      } catch (_) {}
      return text;
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error(`JSON: ${e.message}`); }

    const structured = encodeStructuredResend(parsed);
    if (structured) return structured;
    return JSON.stringify(parsed);
  }

  function queueResendLog(ws, sourceId) {
    const queue = resendLogQueue.get(ws) || [];
    queue.push({ sourceId });
    resendLogQueue.set(ws, queue);
  }

  function takeResendLog(ws) {
    const queue = resendLogQueue.get(ws);
    if (!queue?.length) return null;
    const next = queue.shift();
    if (queue.length) resendLogQueue.set(ws, queue);
    else resendLogQueue.delete(ws);
    return next;
  }

  function doResend() {
    const p = packets.find(x => x.id === selectedId);
    if (!p) return;
    const errEl = sidebar.querySelector("#zs-re-err");
    const editorText = sidebar.querySelector("#zs-re-ed").value;
    let out;
    try {
      out = getResendPayloadFromEditor(p, editorText);
      errEl.textContent = "";
    } catch (e) {
      errEl.textContent = e.message;
      return;
    }
    const ws = [...wsMap.keys()].find(w => w.readyState === 1);
    if (!ws) { errEl.textContent = "No open WebSocket."; return; }
    queueResendLog(ws, p.id);
    ws.send(out);
    setStatus(`Resent #${p.id} · ${fmtBytes(payloadSize(typeof out === "string" ? parseText(out) : parseBinary(out)))}`);
  }

  function clearPackets() {
    // Keep only pinned packets; reset counts
    packets  = packets.filter(p => pinnedIds.has(p.id));
    inCount  = packets.filter(p => p.direction === "IN").length;
    outCount = packets.filter(p => p.direction === "OUT").length;
    flaggedIds.clear();
    packets.forEach(p => { p.flagged = false; });
    pendingPackets = [];
    selectedId = null;
    closeViewer();
    scheduleRender();
    updateStats();
  }

  function resetSession() {
    packets = []; pendingPackets = [];
    inCount = 0; outCount = 0; firstPacketTs = null;
    pinnedIds.clear(); flaggedIds.clear();
    sparklinePkt.fill(0); sparklineB.fill(0);
    filter.query = ""; filter.type = ""; filter.direction = "ALL"; filter.flaggedOnly = false;
    filterInput.value = "";
    filterInput.classList.remove("rx");
    sidebar.querySelectorAll(".zd").forEach(b => b.classList.toggle("on", b.dataset.dir === "ALL"));
    selectedForDiffId = null;
    hooksGen++;
    closeViewer();
    scheduleRender();
    updateStats();
    setStatus("session reset");
  }

  function exportPackets() {
    const data = filteredPackets().map((p, i) => ({
      index:     i,
      id:        p.id,
      direction: p.direction,
      timestamp: new Date(p.timestamp).toISOString(),
      type:      typeTag(p.parsed),
      wsUrl:     wsMap.get(p.ws)?.url ?? null,
      payload:   p.parsed.json ?? p.parsed,
      flagged:   flaggedIds.has(p.id),
      pinned:    pinnedIds.has(p.id),
      resent:    Boolean(p.resent),
      resendSourceId: p.resendSourceId ?? null,
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `packets-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${data.length} packets`);
  }

  // ═══════════════════════════════════════════════════════════
  //  Packet logging
  // ═══════════════════════════════════════════════════════════

  function logPacket(direction, ws, payload, opts = {}) {
    const parsed = typeof payload === "string" ? parseText(payload) : parseBinary(payload);
    const ts     = Date.now();
    if (!firstPacketTs) firstPacketTs = ts;

    direction === "IN" ? inCount++ : outCount++;
    recordInSlot(payloadSize(parsed));

    const p = {
      id:         packetId++,
      direction,
      parsed,
      timestamp:  ts,
      ws,
      resent:     Boolean(opts.resent),
      resendSourceId: opts.resendSourceId ?? null,
      generation: hooksGen,
    };

    if (isPaused) {
      pendingPackets.push(p);
      sidebar.querySelector("#zs-pn").textContent = `${pendingPackets.length} buffered`;
      return;
    }

    packets.push(p);

    // Trim old packets, preserving pinned ones
    if (packets.length > MAX_PACKETS * 1.25) {
      const pinned = packets.filter(x => pinnedIds.has(x.id));
      const rest   = packets.filter(x => !pinnedIds.has(x.id)).slice(-MAX_PACKETS);
      packets      = [...pinned, ...rest].sort((a, b) => a.id - b.id);
    }

    scheduleRender();
    console.debug("[PS]", direction, typeTag(parsed), parsed);
  }

  // ═══════════════════════════════════════════════════════════
  //  Sidebar helpers
  // ═══════════════════════════════════════════════════════════

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle("hidden", !sidebarOpen);
    applyMargin();
  }

  function togglePause() {
    isPaused = !isPaused;
    pauseBtnEl.textContent = isPaused ? "Resume" : "Pause";
    pauseBtnEl.classList.toggle("on", isPaused);
    if (!isPaused) {
      pendingPackets.forEach(p => packets.push(p));
      pendingPackets = [];
      sidebar.querySelector("#zs-pn").textContent = "";
      scheduleRender();
      updateStats();
    }
  }

  function setAS(enabled, snap) {
    autoScroll = enabled;
    autoscrollBtnEl.classList.toggle("on", autoScroll);
    if (enabled && snap) listEl.scrollTop = listEl.scrollHeight;
  }

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  function applyMargin() {
    document.body.style.marginRight  = sidebarOpen ? `${currentWidth}px` : "0";
    document.body.style.transition   = "margin-right .2s ease";
    document.body.style.boxSizing    = "border-box";
  }

  // ═══════════════════════════════════════════════════════════
  //  WebSocket hooks
  // ═══════════════════════════════════════════════════════════

  function installHooks() {
    if (wsHooksInstalled) return;
    wsHooksInstalled = true;

    const OrigWS = window.WebSocket;

    function PatchedWS(...args) {
      const ws   = new OrigWS(...args);
      const url  = String(args[0] ?? "");
      const info = { id: ++wsSeq, url };
      wsMap.set(ws, info);

      ws.addEventListener("open",  ()  => { setStatus(`WS #${info.id} open · ${url}`);          updateStats(); });
      ws.addEventListener("close", e   => { setStatus(`WS #${info.id} closed (${e.code})`);      updateStats(); });
      ws.addEventListener("error", ()  => { setStatus(`WS #${info.id} error`); });

      const origSend = ws.send;
      ws.send = function (data) {
        const resendMeta = takeResendLog(ws);
        try { logPacket("OUT", ws, data, resendMeta ? { resent: true, resendSourceId: resendMeta.sourceId } : {}); } catch (e) { console.warn("[PS] OUT err", e); }
        return origSend.call(this, data);
      };

      ws.addEventListener("message", e => {
        try { logPacket("IN", ws, e.data); } catch (e) { console.warn("[PS] IN err", e); }
      });

      return ws;
    }

    // Preserve prototype chain so instanceof checks keep working.
    // setPrototypeOf(PatchedWS, OrigWS) also makes the static constants
    // (OPEN, CLOSED, etc.) accessible via prototype lookup — no need to copy them
    // (they're non-writable on the native constructor and would throw).
    PatchedWS.prototype = OrigWS.prototype;
    Object.setPrototypeOf(PatchedWS, OrigWS);

    Object.defineProperty(window, "WebSocket", { value: PatchedWS, writable: true, configurable: true });
  }

  // ═══════════════════════════════════════════════════════════
  //  Init
  // ═══════════════════════════════════════════════════════════

  function init() {
    if (initialized || !document.body) return;
    initialized = true;
    injectStyles();
    buildSidebar();
    installHooks();
    updateStats();
    console.log(`[PacketSniffer] v${VERSION} installed · [K] toggle · [/] filter · [↑↓] navigate`);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
    const obs = new MutationObserver(() => {
      if (document.body) { obs.disconnect(); init(); }
    });
    obs.observe(document.documentElement, { childList: true });
  }
})();
