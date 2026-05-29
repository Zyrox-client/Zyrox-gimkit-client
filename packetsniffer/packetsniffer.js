// ==UserScript==
// @name         Zyrox packet sniffer
// @namespace    https://github.com/zyrox
// @version      3.0.0
// @description  WebSocket packet inspector — resend templates, variable substitution, sparkline stats, keyboard nav.
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
  const VERSION          = "3.0.0";
  const MAX_PACKETS      = 1500;
  const DEFAULT_WIDTH    = 940;
  const MIN_WIDTH        = 380;
  const COLYSEUS_MSG     = 13;
  const SPARKLINE_SLOTS  = 36;
  const SLOT_MS          = 1500;
  const FILTER_DEBOUNCE  = 90;

  const ENGINE_TYPES = {"0":"OPEN","1":"CLOSE","2":"PING","3":"PONG","4":"MESSAGE","5":"UPGRADE","6":"NOOP"};
  const SOCKET_TYPES = {"0":"CONNECT","1":"DISCONNECT","2":"EVENT","3":"ACK","4":"ERROR","5":"BINARY_EVENT","6":"BINARY_ACK"};

  // Semantic colors for known types – intentional palette, not hue rotation
  const TYPE_COLORS = {
    "EVENT":"#f0844c","ACK":"#40cc88","CONNECT":"#44aaff",
    "DISCONNECT":"#f04466","PING":"#68708c","PONG":"#68708c",
    "MESSAGE":"#b870ff","BINARY_EVENT":"#f06030","BINARY_ACK":"#30b870",
    "OPEN":"#38c8f8","CLOSE":"#f04455","ERROR":"#f03055","UPGRADE":"#7880ff",
  };

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
  let viewerWidthPx = Math.round(DEFAULT_WIDTH * 0.60);
  let renderScheduled = false, renderFull = false;
  let filterDirty = false;
  let filterDebounceTimer = null;
  let inCount = 0, outCount = 0;
  let firstPacketTs = null;
  let lastRenderedCount = 0; // incremental render watermark

  // Resend state
  let resendSeq = 0;
  const resendHistory = [];   // {ts, tag, bytes, ok, err}
  let resendRepeatHandle = null;

  // Sparkline ring buffer
  const sparklinePkt = new Array(SPARKLINE_SLOTS).fill(0);
  const sparklineB   = new Array(SPARKLINE_SLOTS).fill(0);
  let slotIdx = 0, lastSlotTs = Date.now();

  const pinnedIds   = new Set();
  const flaggedIds  = new Set();
  const wsMap       = new Map();    // ws → {id, url}
  const packetNotes = new Map();    // packetId → string
  const resendLogQ  = new WeakMap();// ws → [{sourceId}]
  let wsSeq = 0;

  const filter = {query:"",direction:"ALL",type:"",flaggedOnly:false,isRegex:false,re:null};

  // DOM refs
  let sidebar, listEl, countEl, filterInput, viewerPanel, bodyEl, dividerEl;
  let statsLineEl, statusEl, pauseBtnEl, autoscrollBtnEl;
  let clearConfirmEl, resetConfirmEl, sparklineSvgEl, connBadgeEl, contextMenuEl;
  let reEdEl, reErrEl, reCntEl, reDelayEl, reHistEl, reTplListEl, reSendAllBtn, reStopBtn;

  // ═══════════════════════════════════════════════════════════
  //  Template storage (localStorage, survives reload)
  // ═══════════════════════════════════════════════════════════
  const getTpls  = () => { try { return JSON.parse(localStorage.getItem("ps-tpls")||"{}"); } catch { return {}; } };
  const saveTpls = t  => { try { localStorage.setItem("ps-tpls", JSON.stringify(t)); } catch {} };

  // ═══════════════════════════════════════════════════════════
  //  Utilities
  // ═══════════════════════════════════════════════════════════
  const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const pad = (n, w=2) => String(n).padStart(w,"0");

  function fmtTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`;
  }
  function fmtRel(ts) {
    const ms = ts - (firstPacketTs ?? ts);
    const s = Math.floor(ms/1000), m = Math.floor(s/60);
    return m > 0 ? `+${m}m${pad(s%60)}s` : `+${s}.${pad(ms%1000,3)}s`;
  }
  function fmtBytes(n) {
    if (n < 1024)    return `${n}B`;
    if (n < 1048576) return `${(n/1024).toFixed(1)}KB`;
    return `${(n/1048576).toFixed(1)}MB`;
  }
  const tryJson = s => { if (typeof s!=="string") return null; try { return JSON.parse(s); } catch { return null; } };

  function genUUID() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = (Math.random()*16)|0;
      return (c==="x" ? r : (r&0x3)|0x8).toString(16);
    });
  }

  // Variable substitution — runs at send-time, not in editor
  // Supported: {{now}}, {{isonow}}, {{uuid}}, {{seq}}, {{rand:min:max}}, {{b64:text}}, {{b64d:b64}}
  function applyVars(text) {
    return text.replace(/\{\{(\w+)(?::([^}]*))?\}\}/g, (m, name, raw) => {
      const a = raw ? raw.split(":") : [];
      switch (name.toLowerCase()) {
        case "now":    return Date.now();
        case "isonow": return new Date().toISOString();
        case "uuid":   return genUUID();
        case "seq":    return ++resendSeq;
        case "rand": {
          const lo = Number(a[0]??0), hi = Number(a[1]??100);
          return Math.floor(Math.random()*(hi-lo+1))+lo;
        }
        case "b64":    return btoa(a.join(":"));
        case "b64d":   return atob(a.join(":"));
        default:       return m;
      }
    });
  }

  function hexDump(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (!b.length) return "(empty)";
    const lines = [];
    for (let i=0; i<b.length; i+=16) {
      const row = b.slice(i,i+16);
      const off = i.toString(16).padStart(5,"0");
      const hex = Array.from(row).map((x,j) => (j===8?" ":"")+x.toString(16).padStart(2,"0")).join(" ");
      const asc = Array.from(row).map(x => (x>=32&&x<127)?String.fromCharCode(x):".").join("");
      lines.push(`${off}  ${hex.padEnd(50)}  ${esc(asc)}`);
    }
    return lines.join("\n");
  }

  function toAB(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) return input.buffer.slice(input.byteOffset, input.byteOffset+input.byteLength);
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  //  MsgPack encoder
  // ═══════════════════════════════════════════════════════════
  function msgpackEncode(value) {
    const bytes = [], deferred = [];
    const write = input => {
      const type = typeof input;
      if (type === "string") {
        let len = 0;
        for (let i=0; i<input.length; i++) {
          const code = input.charCodeAt(i);
          if (code < 128) len++;
          else if (code < 2048) len += 2;
          else if (code < 55296 || code > 57343) len += 3;
          else { i++; len += 4; }
        }
        if (len < 32) bytes.push(160|len);
        else if (len < 256) bytes.push(217,len);
        else if (len < 65536) bytes.push(218,len>>8,len&255);
        else bytes.push(219,len>>24,(len>>16)&255,(len>>8)&255,len&255);
        deferred.push({type:"string",value:input,offset:bytes.length});
        bytes.length += len;
        return;
      }
      if (type === "number") {
        if (Number.isInteger(input) && Number.isFinite(input)) {
          if (input >= 0) {
            if (input<128) bytes.push(input);
            else if (input<256) bytes.push(204,input);
            else if (input<65536) bytes.push(205,input>>8,input&255);
            else if (input<4294967296) bytes.push(206,input>>24,(input>>16)&255,(input>>8)&255,input&255);
            else {
              const hi=Math.floor(input/Math.pow(2,32)),lo=input>>>0;
              bytes.push(207,hi>>24,(hi>>16)&255,(hi>>8)&255,hi&255,lo>>24,(lo>>16)&255,(lo>>8)&255,lo&255);
            }
          } else if (input>=-32) bytes.push(input);
          else if (input>=-128) bytes.push(208,input&255);
          else if (input>=-32768) bytes.push(209,(input>>8)&255,input&255);
          else if (input>=-2147483648) bytes.push(210,(input>>24)&255,(input>>16)&255,(input>>8)&255,input&255);
          else {
            const hi=Math.floor(input/Math.pow(2,32)),lo=input>>>0;
            bytes.push(211,hi>>24,(hi>>16)&255,(hi>>8)&255,hi&255,lo>>24,(lo>>16)&255,(lo>>8)&255,lo&255);
          }
          return;
        }
        bytes.push(203);
        deferred.push({type:"float64",value:input,offset:bytes.length});
        bytes.length += 8;
        return;
      }
      if (type === "boolean") { bytes.push(input?195:194); return; }
      if (input == null) { bytes.push(192); return; }
      if (Array.isArray(input)) {
        const len = input.length;
        if (len<16) bytes.push(144|len);
        else if (len<65536) bytes.push(220,len>>8,len&255);
        else bytes.push(221,len>>24,(len>>16)&255,(len>>8)&255,len&255);
        for (const item of input) write(item);
        return;
      }
      if (type === "object") {
        const keys = Object.keys(input).filter(k => typeof input[k]!=="function");
        const len = keys.length;
        if (len<16) bytes.push(128|len);
        else if (len<65536) bytes.push(222,len>>8,len&255);
        else bytes.push(223,len>>24,(len>>16)&255,(len>>8)&255,len&255);
        for (const key of keys) { write(key); write(input[key]); }
        return;
      }
      write(null);
    };
    write(value);
    const view = new DataView(new ArrayBuffer(bytes.length));
    for (let i=0; i<bytes.length; i++) view.setUint8(i, bytes[i]&255);
    for (const part of deferred) {
      if (part.type === "float64") { view.setFloat64(part.offset, part.value); continue; }
      let offset = part.offset;
      const value = part.value;
      for (let i=0; i<value.length; i++) {
        let code = value.charCodeAt(i);
        if (code<128) view.setUint8(offset++,code);
        else if (code<2048) { view.setUint8(offset++,192|(code>>6)); view.setUint8(offset++,128|(code&63)); }
        else if (code<55296||code>57343) {
          view.setUint8(offset++,224|(code>>12));
          view.setUint8(offset++,128|((code>>6)&63));
          view.setUint8(offset++,128|(code&63));
        } else {
          i++;
          code = 65536+(((code&1023)<<10)|(value.charCodeAt(i)&1023));
          view.setUint8(offset++,240|(code>>18));
          view.setUint8(offset++,128|((code>>12)&63));
          view.setUint8(offset++,128|((code>>6)&63));
          view.setUint8(offset++,128|(code&63));
        }
      }
    }
    return view.buffer;
  }

  // ═══════════════════════════════════════════════════════════
  //  MsgPack decoder
  // ═══════════════════════════════════════════════════════════
  function msgpackDecode(ab, startOffset=0) {
    if (!(ab instanceof ArrayBuffer)) return null;
    const v = new DataView(ab);
    let o = startOffset;
    const rStr = n => {
      let s="", end=o+n;
      while (o<end) {
        const b=v.getUint8(o++);
        if (b<0x80) s+=String.fromCharCode(b);
        else if (b<0xe0) s+=String.fromCharCode(((b&0x1f)<<6)|(v.getUint8(o++)&0x3f));
        else if (b<0xf0) s+=String.fromCharCode(((b&0x0f)<<12)|((v.getUint8(o++)&0x3f)<<6)|(v.getUint8(o++)&0x3f));
        else {
          const cp=((b&7)<<18)|((v.getUint8(o++)&0x3f)<<12)|((v.getUint8(o++)&0x3f)<<6)|(v.getUint8(o++)&0x3f);
          const hi=cp-0x10000;
          s+=String.fromCharCode((hi>>10)+0xd800,(hi&0x3ff)+0xdc00);
        }
      }
      return s;
    };
    const rBin = n => { const b=ab.slice(o,o+n); o+=n; return b; };
    const read = () => {
      const t=v.getUint8(o++);
      if (t<=0x7f) return t;
      if (t<=0x8f) { const n=t&0xf,m={}; for (let i=0;i<n;i++) m[read()]=read(); return m; }
      if (t<=0x9f) { const n=t&0xf,a=[]; for (let i=0;i<n;i++) a.push(read()); return a; }
      if (t<=0xbf) return rStr(t&0x1f);
      if (t>=0xe0) return t-256;
      switch(t) {
        case 0xc0:return null; case 0xc2:return false; case 0xc3:return true;
        case 0xc4:return rBin(v.getUint8(o++));
        case 0xc5:{const n=v.getUint16(o);o+=2;return rBin(n);}
        case 0xc6:{const n=v.getUint32(o);o+=4;return rBin(n);}
        case 0xca:{const r=v.getFloat32(o);o+=4;return r;}
        case 0xcb:{const r=v.getFloat64(o);o+=8;return r;}
        case 0xcc:return v.getUint8(o++);
        case 0xcd:{const r=v.getUint16(o);o+=2;return r;}
        case 0xce:{const r=v.getUint32(o);o+=4;return r;}
        case 0xd0:return v.getInt8(o++);
        case 0xd1:{const r=v.getInt16(o);o+=2;return r;}
        case 0xd2:{const r=v.getInt32(o);o+=4;return r;}
        case 0xd9:return rStr(v.getUint8(o++));
        case 0xda:{const n=v.getUint16(o);o+=2;return rStr(n);}
        case 0xdb:{const n=v.getUint32(o);o+=4;return rStr(n);}
        case 0xdc:{const n=v.getUint16(o);o+=2;const a=[];for(let i=0;i<n;i++)a.push(read());return a;}
        case 0xdd:{const n=v.getUint32(o);o+=4;const a=[];for(let i=0;i<n;i++)a.push(read());return a;}
        case 0xde:{const n=v.getUint16(o);o+=2;const m={};for(let i=0;i<n;i++)m[read()]=read();return m;}
        case 0xdf:{const n=v.getUint32(o);o+=4;const m={};for(let i=0;i<n;i++)m[read()]=read();return m;}
        default:return `<ext:0x${t.toString(16)}>`;
      }
    };
    try { return {value:read(),offset:o}; } catch { return null; }
  }

  // ═══════════════════════════════════════════════════════════
  //  Protocol detection
  // ═══════════════════════════════════════════════════════════
  function decodeStructuredBinary(input) {
    const ab = toAB(input);
    if (!ab) return null;
    const b = new Uint8Array(ab);
    if (!b.length) return null;
    if (b[0] === COLYSEUS_MSG) {
      const ch = msgpackDecode(ab,1);
      if (!ch) return null;
      const body = (b.byteLength>ch.offset) ? msgpackDecode(ab,ch.offset)?.value??null : null;
      return {transport:"colyseus",channel:ch.value,body};
    }
    if (b[0] === 4) {
      const dec = msgpackDecode(ab.slice(1),0)?.value;
      if (!dec||typeof dec!=="object") return null;
      const d = dec.data;
      return {transport:"blueboat",eventName:Array.isArray(d)?d[0]:null,payload:Array.isArray(d)?d[1]:d,_raw:dec};
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  //  Parsers
  // ═══════════════════════════════════════════════════════════
  function parseText(text) {
    if (typeof text!=="string") return {raw:text};
    const et=text[0], en=ENGINE_TYPES[et]??"UNKNOWN", payload=text.slice(1);
    if (et!=="4") return {engineType:et,engineName:en,payload,raw:text};
    const st=payload[0], sn=SOCKET_TYPES[st]??"UNKNOWN", body=payload.slice(1);
    return {engineType:et,engineName:en,socketType:st,socketName:sn,body,json:tryJson(body),raw:text};
  }

  function parseBinary(value) {
    if (value instanceof Blob) {
      const meta = {kind:"Blob",bytes:value.size,text:null,json:null,hex:null,_loading:true};
      value.arrayBuffer().then(ab => {
        const u8 = new Uint8Array(ab);
        meta.hex = hexDump(u8);
        if (decodeEnabled) {
          const d = decodeStructuredBinary(ab);
          if (d) { meta.transport=d.transport; meta.json=d; meta.text=JSON.stringify(d); }
        }
        if (!meta.text) { try { meta.text=new TextDecoder("utf-8",{fatal:true}).decode(u8); } catch {} }
        if (!meta.json&&meta.text) meta.json=tryJson(meta.text);
        meta._loading=false;
        // FIX: update viewer panel directly if this packet is selected
        const p = packets.find(x => x.parsed===meta);
        if (p) {
          if (p.id===selectedId) openViewer(p);
          scheduleRender(false);
        }
      }).catch(() => { meta._loading=false; });
      return meta;
    }
    const ab = toAB(value);
    if (!ab) return {kind:typeof value,bytes:0,hex:null,text:null,json:null};
    const u8 = new Uint8Array(ab);
    const hex = hexDump(u8);
    let text=null, json=null, transport=null;
    if (decodeEnabled) {
      const d = decodeStructuredBinary(ab);
      if (d) { transport=d.transport; json=d; text=JSON.stringify(d); }
    }
    if (!text) { try { text=new TextDecoder("utf-8",{fatal:true}).decode(u8); } catch {} }
    if (!json&&text) json=tryJson(text);
    return {kind:"Binary",bytes:u8.length,text,json,hex,transport};
  }

  // ═══════════════════════════════════════════════════════════
  //  Type tags & colors
  // ═══════════════════════════════════════════════════════════
  function typeTag(parsed) {
    if (parsed._tag) return parsed._tag;
    let t;
    const tr = parsed.transport;
    if      (tr==="colyseus") t = `colyseus/${String(parsed.channel??"")}`;
    else if (tr==="blueboat") t = parsed.eventName ? `blueboat/${parsed.eventName}` : "blueboat";
    else if (parsed.socketName&&parsed.socketName!=="UNKNOWN") t = parsed.socketName;
    else if (parsed.engineName&&parsed.engineName!=="UNKNOWN") t = parsed.engineName;
    else if (parsed.kind) t = `${parsed.kind}:${parsed.bytes??0}B`;
    else t = "RAW";
    return (parsed._tag = t);
  }

  function typeColor(tag) {
    const key = tag.toUpperCase().split("/")[0];
    if (TYPE_COLORS[key]) return TYPE_COLORS[key];
    if (tag.startsWith("colyseus/")) return "#34d4c0";
    if (tag.startsWith("blueboat/")) return "#cc60cc";
    let h = 5381;
    for (let i=0; i<tag.length; i++) h = ((h<<5)^h^tag.charCodeAt(i))>>>0;
    return `hsl(${(h%280+50)%360},50%,58%)`;
  }

  function fullBody(parsed) {
    if (parsed.json) { try { return JSON.stringify(parsed.json,null,2); } catch {} }
    if (parsed.text)          return parsed.text;
    if (parsed.raw != null)   return String(parsed.raw);
    if (parsed.hex)           return parsed.hex;
    return JSON.stringify(parsed,null,2);
  }

  function payloadSize(parsed) {
    if (parsed._sz != null)   return parsed._sz;
    if (parsed.bytes != null) return (parsed._sz = parsed.bytes);
    return (parsed._sz = fullBody(parsed).length);
  }

  // ═══════════════════════════════════════════════════════════
  //  Filter
  // ═══════════════════════════════════════════════════════════
  function parseFilter(raw) {
    filter.query=""; filter.type=""; filter.flaggedOnly=false;
    filter.isRegex=false; filter.re=null;
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    const free = [];
    for (const t of tokens) {
      if (t.startsWith("dir:")) {
        const v=t.slice(4).toUpperCase();
        if ("ALL IN OUT".includes(v)) filter.direction=v;
      } else if (t.startsWith("type:")) {
        filter.type=t.slice(5).toLowerCase();
      } else if (t==="flagged"||t==="flagged:true") {
        filter.flaggedOnly=true;
      } else {
        free.push(t);
      }
    }
    const q = free.join(" ");
    if (q.startsWith("/")&&q.length>1) {
      const li=q.lastIndexOf("/");
      const [pat,flags]=li>0?[q.slice(1,li),q.slice(li+1)]:[q.slice(1),"i"];
      try {
        filter.re=new RegExp(pat,flags);
        filter.isRegex=true;
        filter.query=q;
      } catch {
        // Invalid regex — fall back to literal string match, keep orange highlight as warning
        filter.query=q.slice(1).toLowerCase();
        filter.isRegex=false;
      }
    } else {
      filter.query=q.toLowerCase();
    }
  }

  function matchesFilter(p) {
    if (filter.direction!=="ALL"&&p.direction!==filter.direction) return false;
    if (filter.flaggedOnly&&!flaggedIds.has(p.id)) return false;
    const tag=typeTag(p.parsed).toLowerCase();
    if (filter.type&&!tag.includes(filter.type)) return false;
    if (filter.query) {
      const hay=`${tag} ${fullBody(p.parsed)}`;
      return filter.isRegex ? (filter.re?.test(hay)??false) : hay.toLowerCase().includes(filter.query);
    }
    return true;
  }

  const filteredPackets = () => packets.filter(matchesFilter);

  // ═══════════════════════════════════════════════════════════
  //  Stats & Sparkline
  // ═══════════════════════════════════════════════════════════
  function advanceSlot() {
    const now=Date.now();
    const n=Math.min(SPARKLINE_SLOTS,Math.floor((now-lastSlotTs)/SLOT_MS));
    for (let i=0;i<n;i++) { slotIdx=(slotIdx+1)%SPARKLINE_SLOTS; sparklinePkt[slotIdx]=0; sparklineB[slotIdx]=0; }
    if (n>0) lastSlotTs=now-(now-lastSlotTs)%SLOT_MS;
  }
  function recordInSlot(bytes) { advanceSlot(); sparklinePkt[slotIdx]++; sparklineB[slotIdx]+=bytes; }
  function recentPPS() {
    advanceSlot();
    let t=0;
    for (let i=0;i<5;i++) t+=sparklinePkt[(slotIdx-i+SPARKLINE_SLOTS)%SPARKLINE_SLOTS];
    return (t/(5*SLOT_MS/1000)).toFixed(1);
  }
  function recentBPS() {
    advanceSlot();
    let t=0;
    for (let i=0;i<5;i++) t+=sparklineB[(slotIdx-i+SPARKLINE_SLOTS)%SPARKLINE_SLOTS];
    return t/(5*SLOT_MS/1000);
  }
  function sparklineData() {
    advanceSlot();
    const d=[];
    for (let i=1;i<=SPARKLINE_SLOTS;i++) d.push(sparklinePkt[(slotIdx+i)%SPARKLINE_SLOTS]);
    return d;
  }
  function renderSparkline() {
    if (!sparklineSvgEl) return;
    const d=sparklineData(), max=Math.max(...d,1);
    const W=90,H=20,bw=W/SPARKLINE_SLOTS;
    sparklineSvgEl.innerHTML=d.map((v,i)=>{
      const h=Math.max(1,(v/max)*H), a=(0.2+(v/max)*0.8).toFixed(2);
      return `<rect x="${(i*bw).toFixed(1)}" y="${(H-h).toFixed(1)}" width="${(bw-0.5).toFixed(1)}" height="${h.toFixed(1)}" rx="0.5" fill="var(--acc)" opacity="${a}"/>`;
    }).join("");
  }
  function updateStats() {
    if (!statsLineEl) return;
    const open=[...wsMap.keys()].filter(ws=>ws.readyState===1).length;
    statsLineEl.textContent=`${packets.length} pkts  ·  ${recentPPS()}/s  ·  ${fmtBytes(recentBPS())}/s  ·  ↓${inCount} ↑${outCount}`;
    if (connBadgeEl) { connBadgeEl.textContent=`${open} conn`; connBadgeEl.style.color=open?"var(--grn)":"var(--txt3)"; }
    renderSparkline();
  }

  // ═══════════════════════════════════════════════════════════
  //  Styles  — redesigned: dark purple-tinted theme, indigo accent
  // ═══════════════════════════════════════════════════════════
  function injectStyles() {
    const s = document.createElement("style");
    s.textContent = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');

#zs {
  --bg:    #0b0c11;
  --bg1:   #0f1018;
  --bg2:   #161722;
  --bg3:   #1e1f2e;
  --bdr:   #1c1d2c;
  --bdr2:  #272838;
  --txt:   #c0c2d4;
  --txt2:  #54566e;
  --txt3:  #2a2b3c;
  --acc:   #7b7dfa;
  --acc-b: rgba(123,125,250,.24);
  --acc-g: rgba(123,125,250,.07);
  --in:    #38d4ff;
  --in-b:  rgba(56,212,255,.22);
  --in-g:  rgba(56,212,255,.06);
  --out:   #ff9e56;
  --out-b: rgba(255,158,86,.22);
  --out-g: rgba(255,158,86,.06);
  --grn:   #4ed49a;
  --red:   #f05070;
  --yel:   #f0c040;
  --r:     3px;
  --font:  'JetBrains Mono','Cascadia Code',ui-monospace,monospace;
}
#zs *, #zs *::before, #zs *::after { box-sizing:border-box; margin:0; padding:0; }
#zs {
  position:fixed; top:0; right:0; width:${DEFAULT_WIDTH}px; height:100vh;
  z-index:999999; display:flex; flex-direction:column;
  font-family:var(--font); font-size:12px;
  background:var(--bg); border-left:1px solid var(--bdr2);
  box-shadow:-8px 0 40px rgba(0,0,0,.7);
  transform:translateX(0); transition:transform .18s ease;
  user-select:none; color:var(--txt);
}
#zs.hidden { transform:translateX(100%); }

/* resize handle */
#zs-rh { position:absolute; left:0; top:0; width:5px; height:100%; cursor:ew-resize; z-index:10; }
#zs-rh:hover, #zs-rh.drag { background:var(--acc-b); }

/* header */
#zs-hdr {
  display:flex; align-items:center; gap:4px; flex-wrap:nowrap;
  padding:8px 10px 8px 12px; background:var(--bg1);
  border-bottom:1px solid var(--bdr2); flex-shrink:0; min-height:40px;
}
#zs-logo {
  color:var(--acc); font-weight:700; font-size:12px;
  letter-spacing:.06em; flex-shrink:0; margin-right:3px;
  text-transform:uppercase; opacity:.9;
}
#zs-spark { flex-shrink:0; display:block; opacity:.7; }
#zs-sp { flex:1; min-width:4px; }
#zs-conn { font-size:9px; color:var(--txt2); border:1px solid var(--bdr2); border-radius:var(--r); padding:2px 5px; flex-shrink:0; }

/* generic button */
.zb {
  background:transparent; border:1px solid var(--bdr2); color:var(--txt2);
  border-radius:var(--r); cursor:pointer; font-family:var(--font); font-size:10px;
  padding:3px 7px; white-space:nowrap; flex-shrink:0;
  transition:color .12s, border-color .12s, background .12s;
  line-height:1.4;
}
.zb:hover { color:var(--txt); border-color:var(--txt3); }
.zb.on  { color:var(--acc); border-color:var(--acc-b); background:var(--acc-g); }
.zb.warn:hover { color:var(--red); border-color:rgba(240,80,112,.3); background:rgba(240,80,112,.06); }
.zb.grn { color:var(--grn); border-color:rgba(78,212,154,.3); background:rgba(78,212,154,.06); }

/* controls */
#zs-ctl {
  display:flex; gap:4px; padding:6px 8px; align-items:center;
  border-bottom:1px solid var(--bdr2); background:var(--bg1); flex-shrink:0;
}
#zs-fi {
  flex:1; min-width:0;
  background:var(--bg2); border:1px solid var(--bdr2); border-radius:var(--r);
  color:var(--txt); font-family:var(--font); font-size:11px; padding:4px 8px; outline:none;
}
#zs-fi:focus { border-color:var(--acc-b); background:var(--bg3); }
#zs-fi.rx  { border-color:rgba(240,192,64,.4); color:var(--yel); }
#zs-fi.rxe { border-color:rgba(240,80,112,.4); color:var(--red); }
#zs-fi::placeholder { color:var(--txt3); }

/* stats bar */
#zs-st { padding:4px 10px; font-size:10px; color:var(--txt2); border-bottom:1px solid var(--bdr2); flex-shrink:0; }

/* confirm banners */
.zs-cfm { display:none; padding:4px 10px; font-size:11px; border-bottom:1px solid var(--bdr2); flex-shrink:0; }
#zs-clr-cfm { color:var(--red); background:rgba(240,80,112,.04); }
#zs-rst-cfm { color:var(--yel); background:rgba(240,192,64,.04); }
.zy { color:var(--txt); cursor:pointer; margin-left:6px; text-decoration:underline; }
.zn { color:var(--txt2); cursor:pointer; margin-left:5px; text-decoration:underline; }

/* body layout */
#zs-body { flex:1; display:flex; min-height:0; overflow:hidden; }
#zs-lp   { flex:1; display:flex; flex-direction:column; min-width:180px; overflow:hidden; }
#zs-lm   {
  display:flex; justify-content:space-between; align-items:center;
  padding:3px 10px; font-size:9px; color:var(--txt3);
  border-bottom:1px solid var(--bdr2); background:var(--bg1); flex-shrink:0;
  text-transform:uppercase; letter-spacing:.06em;
}
#zs-list { flex:1; overflow-y:auto; overflow-x:hidden; }

/* section label */
.zs-sec {
  padding:3px 10px; font-size:9px; color:var(--txt3);
  letter-spacing:.12em; text-transform:uppercase;
  border-bottom:1px solid var(--bdr2); background:var(--bg1);
}

/* packet row */
.zr {
  display:grid;
  grid-template-columns:34px 24px 1fr auto 68px;
  gap:0 5px; align-items:start;
  padding:5px 10px 5px 13px;
  border-bottom:1px solid var(--bdr);
  cursor:pointer; position:relative; min-width:0;
}
.zr::before {
  content:''; position:absolute; left:0; top:0; bottom:0; width:2px;
  transition:opacity .1s;
}
.zr.zin::before  { background:var(--in);  opacity:.3; }
.zr.zout::before { background:var(--out); opacity:.3; }
.zr:hover         { background:var(--bg2); }
.zr:hover::before { opacity:.9; }
.zr.sel           { background:var(--bg2); }
.zr.sel::before   { opacity:1; }
.zr.has-note .zr-id::after { content:'✎'; font-size:8px; margin-left:2px; color:var(--yel); opacity:.6; }

.zr-id   { font-size:9px; color:var(--txt3); text-align:right; padding-top:3px; line-height:1; }
.zr-dir  { font-size:8px; font-weight:700; padding:2px 3px; border-radius:2px; text-align:center; margin-top:2px; letter-spacing:.04em; }
.zr-dir.zin  { color:var(--in);  background:var(--in-g);  }
.zr-dir.zout { color:var(--out); background:var(--out-g); }
.zr-cell { min-width:0; }
.zr-type { font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; }
.zr-ts   { font-size:9px; color:var(--txt3); margin-top:2px; display:none; }
#zs-list.tson .zr-ts { display:block; }
.zr-sz   { font-size:9px; color:var(--txt3); text-align:right; padding-top:3px; white-space:nowrap; }
.zr-act  { display:flex; align-items:center; justify-content:flex-end; gap:2px; padding-top:1px; opacity:0; }
.zr:hover .zr-act   { opacity:1; }
.zr.has-flag .zr-act { opacity:1; }
.zr-flag { background:none; border:none; cursor:pointer; color:var(--txt3); font-size:12px; line-height:1; padding:0 2px; }
.zr-flag:hover, .zr-flag.on { color:var(--yel); }
.zr-resent { font-size:8px; color:var(--yel); border:1px solid rgba(240,192,64,.3); border-radius:2px; padding:1px 3px; }

/* divider */
#zs-dvd { width:4px; flex-shrink:0; cursor:col-resize; display:none; background:var(--bdr2); }
#zs-dvd.vis { display:block; }
#zs-dvd:hover, #zs-dvd.drag { background:var(--acc-b); }

/* viewer */
#zs-vwr { display:none; flex-direction:column; min-width:240px; overflow:hidden; }
#zs-vwr.vis { display:flex; }
#zs-vhdr {
  display:flex; gap:5px; align-items:flex-start;
  padding:7px 10px; border-bottom:1px solid var(--bdr2); background:var(--bg1); flex-shrink:0;
}
.zs-vdir { font-size:8px; font-weight:700; padding:2px 5px; border-radius:2px; flex-shrink:0; margin-top:3px; letter-spacing:.06em; }
.zs-vdir.zin  { color:var(--in);  background:var(--in-g);  border:1px solid var(--in-b);  }
.zs-vdir.zout { color:var(--out); background:var(--out-g); border:1px solid var(--out-b); }
#zs-vmeta { flex:1; min-width:0; }
#zs-vtype { color:var(--txt); font-size:12px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#zs-vinfo { color:var(--txt2); font-size:9px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.zvb {
  background:transparent; border:1px solid var(--bdr2); color:var(--txt2);
  border-radius:var(--r); cursor:pointer; font-family:var(--font); font-size:10px;
  padding:2px 6px; flex-shrink:0; white-space:nowrap; line-height:1.4;
}
.zvb:hover { color:var(--txt); }
.zvb.warn:hover { color:var(--red); }

/* viewer tabs */
#zs-tabs {
  display:flex; align-items:stretch; gap:0; padding:0 10px;
  border-bottom:1px solid var(--bdr2); background:var(--bg1); flex-shrink:0;
}
.zt-sep { flex:1; }
.zt {
  background:none; border:none; border-bottom:2px solid transparent;
  color:var(--txt2); font-family:var(--font); font-size:10px;
  padding:6px 12px; cursor:pointer; margin-bottom:-1px; white-space:nowrap;
}
.zt:hover { color:var(--txt); }
.zt.on { color:var(--acc); border-bottom-color:var(--acc); }

/* viewer panes */
#zs-vbody { flex:1; position:relative; min-height:0; }
.zp { position:absolute; inset:0; overflow:auto; display:none; padding:10px; user-select:text; }
.zp.on { display:block; }

/* JSON tree */
.zjn  { font-size:11px; line-height:1.7; }
.zjr  { white-space:pre; display:flex; align-items:baseline; gap:2px; }
.zjt  { display:inline-block; width:12px; cursor:pointer; color:var(--txt3); flex-shrink:0; }
.zjt:hover { color:var(--acc); }
.zjk  { color:#7eb3f5; cursor:pointer; }
.zjk:hover { text-decoration:underline; text-decoration-color:var(--txt3); }
.zjs  { color:#7dcc78; }
.zjn2 { color:#d09060; }
.zjb  { color:#d06060; }
.zjz  { color:var(--txt2); }
.zjch { margin-left:16px; }
.zjhide { display:none; }
.zjsm { cursor:pointer; color:var(--txt3); font-size:9px; }
.zjsm:hover { color:var(--txt2); text-decoration:underline; }
.zjval { cursor:pointer; }
.zjval:hover { opacity:.8; text-decoration:underline dotted; }

/* raw/hex */
#zs-raw, #zs-hex { white-space:pre; font-size:10px; color:var(--txt); line-height:1.7; }

/* diff */
#zs-diff { white-space:pre-wrap; font-size:10px; line-height:1.7; }
.da { color:var(--grn); background:rgba(78,212,154,.06); display:block; }
.dd { color:var(--red); background:rgba(240,80,112,.06); display:block; }
.ds { color:var(--txt2); display:block; }

/* resend pane — full overhaul */
#zs-resend-p { padding:0 !important; flex-direction:column; }
#zs-resend-p.on { display:flex !important; }

#zs-re-toolbar {
  display:flex; gap:4px; padding:6px 8px;
  border-bottom:1px solid var(--bdr2); background:var(--bg1); flex-shrink:0; flex-wrap:wrap;
}
#zs-re-vars-panel {
  display:none; padding:6px 8px; gap:4px; flex-wrap:wrap;
  border-bottom:1px solid var(--bdr2); background:var(--bg);
  flex-shrink:0;
}
#zs-re-vars-panel.open { display:flex; }
.zvar-chip {
  background:var(--bg2); border:1px solid var(--bdr2); border-radius:2px;
  color:var(--acc); font-family:var(--font); font-size:10px;
  padding:2px 6px; cursor:pointer; white-space:nowrap;
}
.zvar-chip:hover { background:var(--bg3); border-color:var(--acc-b); }
.zvar-chip span { color:var(--txt3); font-size:9px; margin-left:3px; }

#zs-re-ed {
  flex:1; background:var(--bg); color:var(--txt);
  border:none; border-bottom:1px solid var(--bdr2);
  font-family:var(--font); font-size:11px; padding:8px 10px; outline:none;
  resize:none; min-height:80px; line-height:1.65;
}
#zs-re-ed:focus { background:var(--bg2); }

#zs-re-repeat {
  display:flex; align-items:center; gap:5px; padding:5px 8px;
  border-bottom:1px solid var(--bdr2); flex-shrink:0; background:var(--bg1);
  font-size:10px; color:var(--txt2);
}
.zri {
  background:var(--bg2); border:1px solid var(--bdr2); border-radius:var(--r);
  color:var(--txt); font-family:var(--font); font-size:11px; padding:2px 5px;
  outline:none; width:52px; text-align:center;
}
.zri:focus { border-color:var(--acc-b); }

#zs-re-ft {
  display:flex; align-items:center; gap:5px; padding:6px 8px;
  border-bottom:1px solid var(--bdr2); background:var(--bg1); flex-shrink:0; flex-wrap:wrap;
}
#zs-re-err  { font-size:10px; color:var(--red); flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#zs-re-prog { font-size:10px; color:var(--grn); }

/* templates section */
#zs-re-tpl  { border-bottom:1px solid var(--bdr2); flex-shrink:0; }
#zs-re-tpl-hdr {
  display:flex; justify-content:space-between; align-items:center;
  padding:4px 8px; font-size:9px; color:var(--txt3); letter-spacing:.1em; text-transform:uppercase;
  background:var(--bg1);
}
#zs-re-tpl-list { max-height:90px; overflow-y:auto; }
.ztpl-row {
  display:flex; align-items:center; gap:4px; padding:4px 8px;
  border-bottom:1px solid var(--bdr); font-size:10px;
}
.ztpl-row:hover { background:var(--bg2); }
.ztpl-name { flex:1; color:var(--txt); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ztpl-load { padding:1px 6px !important; font-size:9px !important; }
.ztpl-del  { padding:1px 5px !important; font-size:9px !important; color:var(--txt3) !important; }
.ztpl-del:hover { color:var(--red) !important; }

/* history section */
#zs-re-hist { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
#zs-re-hist-hdr {
  padding:4px 8px; font-size:9px; color:var(--txt3); letter-spacing:.1em; text-transform:uppercase;
  background:var(--bg1); border-bottom:1px solid var(--bdr2); flex-shrink:0;
}
#zs-re-hist-list { flex:1; overflow-y:auto; }
.zrh-row {
  display:flex; align-items:center; gap:5px;
  padding:3px 8px; border-bottom:1px solid var(--bdr); font-size:10px;
}
.zrh-row.ok  .zrh-ok  { color:var(--grn); }
.zrh-row.err .zrh-err { color:var(--red); font-size:9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.zrh-ts  { color:var(--txt3); flex-shrink:0; font-size:9px; }
.zrh-tag { color:var(--txt);  flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.zrh-sz  { color:var(--txt2); flex-shrink:0; }
.zrh-ok, .zrh-err { flex-shrink:0; }

/* note badge on rows */
.znote-badge {
  display:inline-block; background:var(--yel); color:#111;
  font-size:8px; border-radius:2px; padding:0 3px; margin-left:4px;
  vertical-align:middle; max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}

/* context menu */
#zs-ctx {
  position:fixed; display:none;
  background:var(--bg2); border:1px solid var(--bdr2);
  z-index:1000001; padding:3px; border-radius:var(--r);
  box-shadow:0 8px 32px rgba(0,0,0,.7); min-width:175px;
}
.zci { padding:5px 10px; color:var(--txt2); cursor:pointer; font-size:11px; border-radius:2px; }
.zci:hover { background:var(--bg3); color:var(--txt); }
.zcs { height:1px; background:var(--bdr2); margin:3px 4px; }

/* footer */
#zs-ftr {
  padding:3px 10px; font-size:9px; color:var(--txt3);
  border-top:1px solid var(--bdr2); display:flex; justify-content:space-between;
  background:var(--bg1); flex-shrink:0;
}

/* scrollbars */
#zs-list, .zp, #zs-re-ed, #zs-re-tpl-list, #zs-re-hist-list {
  scrollbar-width:thin; scrollbar-color:var(--bdr2) transparent;
}
#zs-list::-webkit-scrollbar, .zp::-webkit-scrollbar,
#zs-re-tpl-list::-webkit-scrollbar, #zs-re-hist-list::-webkit-scrollbar {
  width:4px; height:4px;
}
#zs-list::-webkit-scrollbar-thumb, .zp::-webkit-scrollbar-thumb,
#zs-re-tpl-list::-webkit-scrollbar-thumb, #zs-re-hist-list::-webkit-scrollbar-thumb {
  background:var(--bdr2); border-radius:2px;
}
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
  <span id="zs-logo">⬡ Sniffer</span>
  <svg id="zs-spark" width="90" height="20" viewBox="0 0 90 20"></svg>
  <div id="zs-sp"></div>
  <span id="zs-conn">0 conn</span>
  <button id="zs-pause" class="zb">Pause</button>
  <button id="zs-as"    class="zb on" title="Auto-scroll to bottom">↓</button>
  <button id="zs-ts"    class="zb on" title="Show relative timestamps">⏱</button>
  <button id="zs-dec"   class="zb on" title="Decode binary (MsgPack/Colyseus)">Decode</button>
  <button id="zs-imp"   class="zb"    title="Import packet export JSON">Import</button>
  <button id="zs-exp"   class="zb">Export</button>
  <button id="zs-rst"   class="zb">Reset</button>
  <button id="zs-tog"   class="zb">Hide</button>
</div>
<div id="zs-ctl">
  <input id="zs-fi" type="text"
    placeholder="filter…  dir:in  type:event  /regex/  flagged"
    autocomplete="off" spellcheck="false" />
  <button class="zb zd on" data-dir="ALL">All</button>
  <button class="zb zd"    data-dir="IN">↓</button>
  <button class="zb zd"    data-dir="OUT">↑</button>
  <button id="zs-ff"  class="zb" title="Flagged packets only">★</button>
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
      <button id="zs-cpj"  class="zvb">Copy JSON</button>
      <button id="zs-cpc"  class="zvb" title="Copy as code snippet">Code ▾</button>
      <button id="zs-note" class="zvb" title="Add/edit note">✎</button>
      <button id="zs-edt"  class="zvb">Edit+Send</button>
      <button id="zs-vcl"  class="zvb">✕</button>
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
      <div class="zp on" id="zs-json-p">
        <div id="zs-jtree-bar" style="display:flex;gap:4px;margin-bottom:6px">
          <button id="zs-jtex" class="zvb" style="font-size:9px">Expand all</button>
          <button id="zs-jtcl" class="zvb" style="font-size:9px">Collapse all</button>
          <span id="zs-jpath" style="color:var(--txt3);font-size:9px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;align-self:center;padding-left:4px"></span>
        </div>
        <div id="zs-jtree"></div>
      </div>
      <div class="zp"    id="zs-raw-p"><pre id="zs-raw"></pre></div>
      <div class="zp"    id="zs-hex-p"><pre id="zs-hex"></pre></div>
      <div class="zp"    id="zs-diff-p">
        <pre id="zs-diff">Right-click a packet → "Pin for diff", right-click another → "Diff with pinned".</pre>
      </div>
      <div class="zp"    id="zs-resend-p">
        <!-- toolbar -->
        <div id="zs-re-toolbar">
          <button id="zs-re-fmt"  class="zvb" title="Pretty-print JSON">Format</button>
          <button id="zs-re-min"  class="zvb" title="Minify JSON">Minify</button>
          <button id="zs-re-orig" class="zvb" title="Restore original packet">Orig</button>
          <button id="zs-re-prev" class="zvb" title="Preview variable substitution">Preview</button>
          <div style="flex:1"></div>
          <button id="zs-re-vars-btn" class="zvb">Vars ▾</button>
        </div>
        <!-- variable chips panel -->
        <div id="zs-re-vars-panel">
          <span class="zvar-chip" data-var="{{now}}">{{now}}<span>unix ms</span></span>
          <span class="zvar-chip" data-var="{{isonow}}">{{isonow}}<span>ISO date</span></span>
          <span class="zvar-chip" data-var="{{uuid}}">{{uuid}}<span>random UUID</span></span>
          <span class="zvar-chip" data-var="{{seq}}">{{seq}}<span>auto-increment</span></span>
          <span class="zvar-chip" data-var="{{rand:0:100}}">{{rand:0:100}}<span>random int</span></span>
          <span class="zvar-chip" data-var="{{b64:text}}">{{b64:text}}<span>base64 enc</span></span>
          <span class="zvar-chip" data-var="{{b64d:dGV4dA==}}">{{b64d:…}}<span>base64 dec</span></span>
        </div>
        <!-- editor -->
        <textarea id="zs-re-ed" spellcheck="false"></textarea>
        <!-- repeat controls -->
        <div id="zs-re-repeat">
          <span>Repeat</span>
          <input id="zs-re-cnt"   class="zri" type="number" value="1" min="1" max="9999">
          <span>×  every</span>
          <input id="zs-re-delay" class="zri" type="number" value="0" min="0" max="60000">
          <span>ms</span>
          <div style="flex:1"></div>
          <span id="zs-re-prog"></span>
        </div>
        <!-- send row -->
        <div id="zs-re-ft">
          <button id="zs-send"     class="zvb grn">Send</button>
          <button id="zs-send-all" class="zvb">Send × <span id="zs-re-cnt-lbl">1</span></button>
          <button id="zs-send-stop" class="zvb warn" style="display:none">■ Stop</button>
          <span id="zs-re-err"></span>
        </div>
        <!-- templates -->
        <div id="zs-re-tpl">
          <div id="zs-re-tpl-hdr">
            <span>Templates</span>
            <button id="zs-re-tpl-save" class="zvb" style="font-size:9px;padding:1px 6px">Save…</button>
          </div>
          <div id="zs-re-tpl-list"></div>
        </div>
        <!-- history -->
        <div id="zs-re-hist">
          <div id="zs-re-hist-hdr">Send history</div>
          <div id="zs-re-hist-list"></div>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="zs-ftr">
  <span id="zs-status">ready</span>
  <span>[K] toggle · [/] filter · [↑↓] nav · [Esc] close</span>
</div>`;
    document.body.appendChild(sidebar);

    // Cache DOM refs
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
    reEdEl          = sidebar.querySelector("#zs-re-ed");
    reErrEl         = sidebar.querySelector("#zs-re-err");
    reCntEl         = sidebar.querySelector("#zs-re-cnt");
    reDelayEl       = sidebar.querySelector("#zs-re-delay");
    reHistEl        = sidebar.querySelector("#zs-re-hist-list");
    reTplListEl     = sidebar.querySelector("#zs-re-tpl-list");
    reSendAllBtn    = sidebar.querySelector("#zs-send-all");
    reStopBtn       = sidebar.querySelector("#zs-send-stop");

    // Context menu
    contextMenuEl = document.createElement("div");
    contextMenuEl.id = "zs-ctx";
    contextMenuEl.innerHTML = `
<div class="zci" data-a="pin">📌  Pin for diff</div>
<div class="zci" data-a="pin-top">⬆  Toggle pin to top</div>
<div class="zci" data-a="diff">⬛  Diff with pinned</div>
<div class="zcs"></div>
<div class="zci" data-a="flag">★  Toggle flag</div>
<div class="zci" data-a="note">✎  Add / edit note</div>
<div class="zci" data-a="copy">⎘  Copy JSON</div>
<div class="zci" data-a="code-js">{ }  Copy as JS snippet</div>
<div class="zci" data-a="code-py">🐍  Copy as Python snippet</div>`;
    document.body.appendChild(contextMenuEl);

    listEl.classList.add("tson");
    renderResendHistory();
    renderTplList();
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
    sidebar.querySelector("#zs-imp").addEventListener("click", importPackets);

    sidebar.querySelector("#zs-rst").addEventListener("click", () => {
      clearConfirmEl.style.display="none";
      resetConfirmEl.style.display="block";
      resetConfirmEl.innerHTML=`Reset session? <span class="zy" data-r="yes">Yes</span><span class="zn" data-r="no">No</span>`;
    });

    // ── Controls ────────────────────────────────────────────
    filterInput.addEventListener("input", () => {
      clearTimeout(filterDebounceTimer);
      filterDebounceTimer = setTimeout(() => {
        parseFilter(filterInput.value);
        filterInput.classList.toggle("rx", filter.isRegex);
        filterInput.classList.remove("rxe");
        scheduleRender(true);
      }, FILTER_DEBOUNCE);
    });

    sidebar.querySelectorAll(".zd").forEach(b => b.addEventListener("click", () => {
      filter.direction = b.dataset.dir;
      sidebar.querySelectorAll(".zd").forEach(x => x.classList.toggle("on", x.dataset.dir===filter.direction));
      scheduleRender(true);
    }));

    sidebar.querySelector("#zs-ff").addEventListener("click", e => {
      filter.flaggedOnly = !filter.flaggedOnly;
      e.currentTarget.classList.toggle("on", filter.flaggedOnly);
      scheduleRender(true);
    });

    sidebar.querySelector("#zs-clr").addEventListener("click", () => {
      resetConfirmEl.style.display="none";
      clearConfirmEl.style.display="block";
      clearConfirmEl.innerHTML=`Clear ${packets.length} packets? <span class="zy" data-c="yes">Yes</span><span class="zn" data-c="no">No</span>`;
    });

    clearConfirmEl.addEventListener("click", e => {
      const c = e.target.dataset.c;
      if (!c) return;
      clearConfirmEl.style.display="none";
      if (c==="yes") clearPackets();
    });

    resetConfirmEl.addEventListener("click", e => {
      const r = e.target.dataset.r;
      if (!r) return;
      resetConfirmEl.style.display="none";
      if (r==="yes") resetSession();
    });

    listEl.addEventListener("scroll", () => {
      if (!autoScroll) return;
      if (listEl.scrollHeight-listEl.scrollTop-listEl.clientHeight > 50) setAS(false, false);
    });

    // ── Viewer header ────────────────────────────────────────
    sidebar.querySelector("#zs-vcl").addEventListener("click", closeViewer);

    sidebar.querySelectorAll(".zt").forEach(t =>
      t.addEventListener("click", () => setTab(t.dataset.tab)));

    sidebar.querySelector("#zs-cpj").addEventListener("click", async () => {
      const p = packets.find(x => x.id===selectedId);
      if (p) { await navigator.clipboard.writeText(JSON.stringify(p.parsed.json ?? p.parsed, null, 2)); setStatus("JSON copied"); }
    });

    // Code copy dropdown (cycles through JS/Python on click)
    let codeTarget = "js";
    sidebar.querySelector("#zs-cpc").addEventListener("click", () => {
      const p = packets.find(x => x.id===selectedId);
      if (!p) return;
      if (codeTarget==="js") { copyAsCodeJS(p); codeTarget="py"; sidebar.querySelector("#zs-cpc").textContent="Py ▾"; }
      else                   { copyAsCodePy(p); codeTarget="js"; sidebar.querySelector("#zs-cpc").textContent="Code ▾"; }
    });

    sidebar.querySelector("#zs-note").addEventListener("click", () => {
      const p = packets.find(x => x.id===selectedId);
      if (p) promptNote(p);
    });

    sidebar.querySelector("#zs-edt").addEventListener("click", () => {
      setTab("resend");
      const p = packets.find(x => x.id===selectedId);
      if (!p) return;
      reEdEl.value = getEditableResendBody(p);
      reErrEl.textContent = "";
    });

    // ── JSON tree controls ───────────────────────────────────
    sidebar.querySelector("#zs-jtex").addEventListener("click", () => {
      sidebar.querySelectorAll("#zs-jtree .zjch.zjhide").forEach(el => {
        el.classList.remove("zjhide");
        const t=el.parentElement?.querySelector(".zjt"); if (t) t.textContent="▼";
      });
    });
    sidebar.querySelector("#zs-jtcl").addEventListener("click", () => {
      sidebar.querySelectorAll("#zs-jtree .zjch:not(.zjhide)").forEach(el => {
        el.classList.add("zjhide");
        const t=el.parentElement?.querySelector(".zjt"); if (t) t.textContent="▶";
      });
    });

    // ── Resend toolbar ────────────────────────────────────────
    sidebar.querySelector("#zs-re-fmt").addEventListener("click", () => {
      const j = tryJson(reEdEl.value);
      if (j) reEdEl.value = JSON.stringify(j, null, 2);
      else   reErrEl.textContent="Not valid JSON — nothing formatted";
    });

    sidebar.querySelector("#zs-re-min").addEventListener("click", () => {
      const j = tryJson(reEdEl.value);
      if (j) reEdEl.value = JSON.stringify(j);
      else   reErrEl.textContent="Not valid JSON — nothing minified";
    });

    sidebar.querySelector("#zs-re-orig").addEventListener("click", () => {
      const p = packets.find(x => x.id===selectedId);
      if (!p) return;
      reEdEl.value = getEditableResendBody(p);
      reErrEl.textContent = "";
      setStatus("Restored original");
    });

    sidebar.querySelector("#zs-re-prev").addEventListener("click", () => {
      const substituted = applyVars(reEdEl.value);
      const j = tryJson(substituted);
      const pretty = j ? JSON.stringify(j, null, 2) : substituted;
      // Show preview in a quick overlay
      showPreviewOverlay(pretty);
    });

    sidebar.querySelector("#zs-re-vars-btn").addEventListener("click", e => {
      const panel = sidebar.querySelector("#zs-re-vars-panel");
      panel.classList.toggle("open");
      e.currentTarget.textContent = panel.classList.contains("open") ? "Vars ▴" : "Vars ▾";
    });

    // Variable chips — insert at cursor
    sidebar.querySelectorAll(".zvar-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const varStr = chip.dataset.var;
        const start = reEdEl.selectionStart, end = reEdEl.selectionEnd;
        reEdEl.value = reEdEl.value.slice(0,start) + varStr + reEdEl.value.slice(end);
        reEdEl.selectionStart = reEdEl.selectionEnd = start + varStr.length;
        reEdEl.focus();
      });
    });

    // Update "Send × N" button label when count changes
    reCntEl.addEventListener("input", () => {
      const n = Math.max(1, parseInt(reCntEl.value,10)||1);
      sidebar.querySelector("#zs-re-cnt-lbl").textContent = n;
    });

    // ── Send buttons ──────────────────────────────────────────
    sidebar.querySelector("#zs-send").addEventListener("click", () => doResend());
    sidebar.querySelector("#zs-send-all").addEventListener("click", doResendRepeat);
    reStopBtn.addEventListener("click", stopRepeat);

    // ── Templates ─────────────────────────────────────────────
    sidebar.querySelector("#zs-re-tpl-save").addEventListener("click", () => {
      const name = prompt("Template name:", "");
      if (!name?.trim()) return;
      const t = getTpls();
      t[name.trim()] = reEdEl.value;
      saveTpls(t);
      renderTplList();
      setStatus(`Template "${name.trim()}" saved`);
    });

    // ── Context menu ──────────────────────────────────────────
    contextMenuEl.addEventListener("click", async e => {
      const a  = e.target.closest("[data-a]")?.dataset.a;
      const id = Number(contextMenuEl.dataset.id);
      const p  = packets.find(x => x.id===id);
      contextMenuEl.style.display="none";
      if (!p||!a) return;
      if      (a==="pin")     { selectedForDiffId=p.id; setStatus(`Pinned #${p.id} for diff`); }
      else if (a==="pin-top") { pinnedIds.has(p.id)?pinnedIds.delete(p.id):pinnedIds.add(p.id); scheduleRender(true); }
      else if (a==="diff")    { showDiff(selectedForDiffId,p.id); }
      else if (a==="flag")    { toggleFlag(p); }
      else if (a==="note")    { promptNote(p); }
      else if (a==="copy")    { await navigator.clipboard.writeText(JSON.stringify(p.parsed.json??p.parsed,null,2)); setStatus("Copied"); }
      else if (a==="code-js") { copyAsCodeJS(p); }
      else if (a==="code-py") { copyAsCodePy(p); }
    });

    document.addEventListener("click", e => {
      if (!contextMenuEl.contains(e.target)) contextMenuEl.style.display="none";
    });

    // ── Keyboard shortcuts ────────────────────────────────────
    document.addEventListener("keydown", e => {
      const inInput = ["INPUT","TEXTAREA"].includes(document.activeElement?.tagName);
      if (e.key==="k"&&!inInput&&!e.ctrlKey&&!e.metaKey) { toggleSidebar(); return; }
      if (!sidebarOpen) return;
      if (e.key==="/"&&!inInput) { filterInput.focus(); e.preventDefault(); return; }
      if (inInput) return;
      if (e.key==="Escape") { closeViewer(); return; }
      if (e.key==="ArrowDown"||e.key==="ArrowUp") {
        const vis=filteredPackets();
        const i=vis.findIndex(p=>p.id===selectedId);
        const next=e.key==="ArrowDown"
          ?(vis[i+1]??(selectedId==null?vis[0]:null))
          :vis[i-1];
        if (next) { openViewer(next); listEl.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({block:"nearest"}); }
        e.preventDefault();
      }
    });

    // ── Sidebar resize ────────────────────────────────────────
    const rh = sidebar.querySelector("#zs-rh");
    let rsDrag=false, rsX=0, rsW=0;
    rh.addEventListener("mousedown", e => {
      rsDrag=true; rsX=e.clientX; rsW=sidebar.offsetWidth;
      rh.classList.add("drag");
      document.body.style.cursor="ew-resize";
      document.body.style.userSelect="none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", e => {
      if (!rsDrag) return;
      const w=Math.max(MIN_WIDTH,Math.min(rsW+rsX-e.clientX,window.innerWidth*.95));
      currentWidth=w; sidebar.style.width=`${w}px`;
      if (sidebarOpen) document.body.style.marginRight=`${w}px`;
    });
    document.addEventListener("mouseup", () => {
      if (!rsDrag) return;
      rsDrag=false; rh.classList.remove("drag");
      document.body.style.cursor=""; document.body.style.userSelect="";
    });

    // ── Viewer split drag ─────────────────────────────────────
    let vDrag=false;
    dividerEl.addEventListener("mousedown", e => {
      if (!viewerPanel.classList.contains("vis")) return;
      vDrag=true; document.body.style.cursor="col-resize"; document.body.style.userSelect="none"; e.preventDefault();
    });
    document.addEventListener("mousemove", e => {
      if (!vDrag) return;
      const r=bodyEl.getBoundingClientRect();
      const w=Math.max(240,Math.min(r.width-180,r.right-e.clientX));
      viewerWidthPx=w; viewerPanel.style.width=`${w}px`;
    });
    document.addEventListener("mouseup", () => {
      if (!vDrag) return;
      vDrag=false; document.body.style.cursor=""; document.body.style.userSelect="";
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Rendering — incremental by default, full rebuild on demand
  // ═══════════════════════════════════════════════════════════
  function scheduleRender(full=false) {
    if (full) renderFull=true;
    if (renderScheduled) return;
    renderScheduled=true;
    requestAnimationFrame(() => {
      renderScheduled=false;
      if (renderFull) { renderFull=false; rerenderList(); }
      else { renderIncremental(); }
    });
  }

  // Fast path: just append new rows when no filters active and no pins
  function renderIncremental() {
    const hasFilter = filter.query||filter.type||filter.flaggedOnly||filter.direction!=="ALL"||pinnedIds.size;
    if (hasFilter) { rerenderList(); return; }
    const start=lastRenderedCount;
    if (packets.length<=start) return;
    const frag=document.createDocumentFragment();
    for (let i=start; i<packets.length; i++) frag.appendChild(createRow(packets[i]));
    listEl.appendChild(frag);
    lastRenderedCount=packets.length;
    countEl.textContent=`${packets.length} / ${packets.length}`;
    if (autoScroll) listEl.scrollTop=listEl.scrollHeight;
  }

  function rerenderList() {
    const vis    = filteredPackets();
    const pinned = vis.filter(p => pinnedIds.has(p.id));
    const rest   = vis.filter(p => !pinnedIds.has(p.id));
    listEl.innerHTML="";
    const frag=document.createDocumentFragment();
    if (pinned.length) {
      const s=document.createElement("div"); s.className="zs-sec"; s.textContent="📌 Pinned";
      frag.appendChild(s);
      pinned.forEach(p => frag.appendChild(createRow(p)));
    }
    if (rest.length) {
      if (pinned.length) {
        const s=document.createElement("div"); s.className="zs-sec"; s.textContent="All";
        frag.appendChild(s);
      }
      rest.forEach(p => frag.appendChild(createRow(p)));
    }
    listEl.appendChild(frag);
    lastRenderedCount=packets.length;
    countEl.textContent=`${vis.length} / ${packets.length}`;
    if (autoScroll) listEl.scrollTop=listEl.scrollHeight;
  }

  function createRow(p) {
    const el  = document.createElement("div");
    const dir = p.direction==="IN" ? "zin" : "zout";
    const tag = typeTag(p.parsed);
    const col = typeColor(tag);
    const fl  = flaggedIds.has(p.id);
    const note = packetNotes.get(p.id);

    el.className=`zr ${dir}${selectedId===p.id?" sel":""}${fl?" has-flag":""}${note?" has-note":""}`;
    el.dataset.id=p.id;
    el.innerHTML=`
<span class="zr-id">#${p.id}</span>
<span class="zr-dir ${dir}">${p.direction==="IN"?"↓":"↑"}</span>
<div class="zr-cell">
  <div class="zr-type" style="color:${col}" title="${esc(tag)}">${esc(tag)}${note?`<span class="znote-badge" title="${esc(note)}">${esc(note)}</span>`:""}</div>
  <div class="zr-ts">${fmtRel(p.timestamp)}</div>
</div>
<span class="zr-sz">${fmtBytes(payloadSize(p.parsed))}</span>
<div class="zr-act">
  ${p.resent?'<span class="zr-resent">↩RESEND</span>':''}
  <button class="zr-flag${fl?" on":""}" title="Flag">★</button>
</div>`;

    el.querySelector(".zr-flag").addEventListener("click", e => { e.stopPropagation(); toggleFlag(p); });

    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      contextMenuEl.dataset.id=p.id;
      const x=Math.min(e.clientX, window.innerWidth-190);
      const y=Math.min(e.clientY, window.innerHeight-200);
      contextMenuEl.style.left=`${x}px`;
      contextMenuEl.style.top=`${y}px`;
      contextMenuEl.style.display="block";
      e.stopPropagation();
    });

    el.addEventListener("click", () => selectedId===p.id ? closeViewer() : openViewer(p));
    return el;
  }

  // ═══════════════════════════════════════════════════════════
  //  Viewer
  // ═══════════════════════════════════════════════════════════
  function setTab(name) {
    sidebar.querySelectorAll(".zt").forEach(t => t.classList.toggle("on", t.dataset.tab===name));
    sidebar.querySelectorAll(".zp").forEach(p => p.classList.toggle("on", p.id===`zs-${name}-p`));
  }

  function openViewer(p) {
    selectedId=p.id;
    viewerPanel.classList.add("vis");
    dividerEl.classList.add("vis");
    viewerPanel.style.width=`${viewerWidthPx}px`;
    viewerPanel.style.flex="0 0 auto";

    const dir=p.direction==="IN"?"zin":"zout";
    const vd=sidebar.querySelector("#zs-vd");
    vd.textContent=p.direction; vd.className=`zs-vdir ${dir}`;

    sidebar.querySelector("#zs-vtype").textContent=typeTag(p.parsed);

    const conn=wsMap.get(p.ws);
    const urlPart=conn?` · ${conn.url.replace(/^wss?:\/\//,"").slice(0,50)}`:"";
    const note=packetNotes.get(p.id);
    sidebar.querySelector("#zs-vinfo").textContent=
      `${fmtTime(p.timestamp)} · #${wsMap.get(p.ws)?.id??"-"} · ${fmtBytes(payloadSize(p.parsed))}${urlPart}${note?` · ✎${note}`:""}`;

    // JSON pane
    const tree=sidebar.querySelector("#zs-jtree");
    tree.innerHTML="";
    sidebar.querySelector("#zs-jpath").textContent="";
    if (p.parsed._loading) {
      const loading=document.createElement("span");
      loading.style.color="var(--txt2)"; loading.textContent="Decoding…";
      tree.appendChild(loading);
    } else {
      tree.appendChild(renderJsonNode(p.parsed.json ?? p.parsed, 0, null, "$"));
    }

    // Raw / Hex panes
    sidebar.querySelector("#zs-raw").textContent=fullBody(p.parsed);
    sidebar.querySelector("#zs-hex").innerHTML=p.parsed.hex??"(no binary data)";
    reEdEl.value=getEditableResendBody(p);

    listEl.querySelectorAll(".zr").forEach(el => el.classList.toggle("sel", Number(el.dataset.id)===p.id));
  }

  function closeViewer() {
    selectedId=null;
    viewerPanel.classList.remove("vis");
    dividerEl.classList.remove("vis");
    listEl.querySelectorAll(".zr.sel").forEach(el => el.classList.remove("sel"));
  }

  // ═══════════════════════════════════════════════════════════
  //  JSON tree — with path tracking and value click-to-copy
  // ═══════════════════════════════════════════════════════════
  function renderJsonNode(val, depth, key, path) {
    const node=document.createElement("div");
    node.className="zjn";
    const row=document.createElement("div");
    row.className="zjr";
    node.appendChild(row);

    const indent="  ".repeat(depth);
    const keyHtml = key!==null
      ? `<span class="zjk" title="Click to copy path" data-path="${esc(path)}">"${esc(String(key))}"</span>: `
      : "";

    if (val===null) { row.innerHTML=`${indent}${keyHtml}<span class="zjz">null</span>`; return node; }

    if (typeof val !== "object") {
      let cls="zjz";
      if (typeof val==="string")  cls="zjs";
      else if (typeof val==="number")  cls="zjn2";
      else if (typeof val==="boolean") cls="zjb";
      const raw=esc(JSON.stringify(val));
      if (typeof val==="string" && val.length>200) {
        const short=esc(JSON.stringify(val.slice(0,200)));
        row.innerHTML=`${indent}${keyHtml}<span class="${cls} zjval" title="Click to copy value" data-val="${esc(JSON.stringify(val))}">${short}<span class="zjsm"> …show all</span></span>`;
        row.querySelector(".zjsm").addEventListener("click", e => {
          e.stopPropagation();
          const span=e.target.parentElement;
          span.innerHTML=raw;
        });
      } else {
        row.innerHTML=`${indent}${keyHtml}<span class="${cls} zjval" title="Click to copy value" data-val="${esc(JSON.stringify(val))}">${raw}</span>`;
      }
      // Click key to show path
      row.querySelector(".zjk")?.addEventListener("click", e => {
        e.stopPropagation();
        const p2=e.target.dataset.path||"";
        navigator.clipboard.writeText(p2).catch(()=>{});
        const pb=sidebar.querySelector("#zs-jpath");
        if (pb) { pb.textContent=p2; }
        setStatus(`Path copied: ${p2}`);
      });
      // Click value to copy it
      row.querySelector(".zjval")?.addEventListener("click", e => {
        if (e.target.classList.contains("zjsm")) return;
        e.stopPropagation();
        const raw2=e.target.dataset.val||e.target.textContent;
        navigator.clipboard.writeText(raw2).catch(()=>{});
        setStatus("Value copied");
      });
      return node;
    }

    const isArr=Array.isArray(val);
    const entries=isArr ? val.map((v,i)=>[i,v]) : Object.entries(val);
    const [open,close]=isArr?["[","]"]:["{"," }"];
    const collapsed=entries.length>10;

    row.innerHTML=`${indent}<span class="zjt">${collapsed?"▶":"▼"}</span>${keyHtml}<span style="color:var(--txt2)">${open}</span> <span style="color:var(--txt3);font-size:9px">${entries.length}</span>`;

    // Click key to show path (object nodes)
    row.querySelector(".zjk")?.addEventListener("click", e => {
      e.stopPropagation();
      const p2=e.target.dataset.path||"";
      navigator.clipboard.writeText(p2).catch(()=>{});
      const pb=sidebar.querySelector("#zs-jpath");
      if (pb) pb.textContent=p2;
      setStatus(`Path copied: ${p2}`);
    });

    const toggle=row.querySelector(".zjt");
    const ch=document.createElement("div");
    ch.className="zjch";
    if (collapsed) ch.classList.add("zjhide");

    entries.forEach(([k,v]) => {
      const childPath = isArr ? `${path}[${k}]` : `${path}.${k}`;
      ch.appendChild(renderJsonNode(v, depth+1, k, childPath));
    });

    const endRow=document.createElement("div");
    endRow.className="zjr";
    endRow.textContent=`${indent}${close}`;
    ch.appendChild(endRow);

    toggle.addEventListener("click", e => {
      e.stopPropagation();
      ch.classList.toggle("zjhide");
      toggle.textContent=ch.classList.contains("zjhide")?"▶":"▼";
    });

    node.appendChild(ch);
    return node;
  }

  // ═══════════════════════════════════════════════════════════
  //  Diff — pretty-prints both sides before diffing
  // ═══════════════════════════════════════════════════════════
  function showDiff(leftId, rightId) {
    const a=packets.find(p=>p.id===leftId);
    const b=packets.find(p=>p.id===rightId);
    if (!a||!b) { setStatus("Diff: pin a packet first (right-click → Pin for diff)"); return; }

    setTab("diff");
    // Use pretty-printed JSON for better diffs, fall back to raw
    const prettyOrFull = p => {
      if (p.parsed.json) { try { return JSON.stringify(p.parsed.json,null,2); } catch {} }
      return fullBody(p.parsed);
    };
    const la=prettyOrFull(a).split("\n");
    const lb=prettyOrFull(b).split("\n");
    const el=sidebar.querySelector("#zs-diff");
    el.innerHTML="";

    const hdr=document.createElement("span");
    hdr.className="ds";
    hdr.textContent=`--- #${a.id}  ${typeTag(a.parsed)}\n+++ #${b.id}  ${typeTag(b.parsed)}\n\n`;
    el.appendChild(hdr);

    const max=Math.max(la.length,lb.length);
    for (let i=0; i<max; i++) {
      const l=la[i]??"", r=lb[i]??"";
      if (l===r) {
        const s=document.createElement("span"); s.className="ds"; s.textContent=`  ${l}\n`; el.appendChild(s);
      } else {
        if (l) { const s=document.createElement("span"); s.className="dd"; s.textContent=`- ${l}\n`; el.appendChild(s); }
        if (r) { const s=document.createElement("span"); s.className="da"; s.textContent=`+ ${r}\n`; el.appendChild(s); }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Resend — variables, repeat, templates, history
  // ═══════════════════════════════════════════════════════════
  function renderResendHistory() {
    if (!reHistEl) return;
    reHistEl.innerHTML="";
    const recent=resendHistory.slice(-30).reverse();
    if (!recent.length) {
      reHistEl.innerHTML="<div style='color:var(--txt3);font-size:10px;padding:5px 8px'>No sends yet</div>";
      return;
    }
    const frag=document.createDocumentFragment();
    recent.forEach(h => {
      const el=document.createElement("div");
      el.className=`zrh-row ${h.ok?"ok":"err"}`;
      el.innerHTML=`<span class="zrh-ts">${fmtTime(h.ts)}</span><span class="zrh-tag">${esc(h.tag)}</span><span class="zrh-sz">${fmtBytes(h.bytes)}</span>${h.ok?'<span class="zrh-ok">✓</span>':`<span class="zrh-err">${esc(h.err||"?")}</span>`}`;
      frag.appendChild(el);
    });
    reHistEl.appendChild(frag);
  }

  function renderTplList() {
    if (!reTplListEl) return;
    reTplListEl.innerHTML="";
    const tpls=getTpls(), names=Object.keys(tpls);
    if (!names.length) {
      reTplListEl.innerHTML="<div style='color:var(--txt3);font-size:10px;padding:4px 8px'>No saved templates</div>";
      return;
    }
    const frag=document.createDocumentFragment();
    names.forEach(name => {
      const el=document.createElement("div");
      el.className="ztpl-row";
      el.innerHTML=`<span class="ztpl-name" title="${esc(name)}">${esc(name)}</span><button class="zvb ztpl-load">Load</button><button class="zvb ztpl-del">✕</button>`;
      el.querySelector(".ztpl-load").addEventListener("click", () => {
        reEdEl.value=tpls[name];
        reErrEl.textContent="";
        setStatus(`Template "${name}" loaded`);
      });
      el.querySelector(".ztpl-del").addEventListener("click", () => {
        const t=getTpls(); delete t[name]; saveTpls(t);
        renderTplList();
      });
      frag.appendChild(el);
    });
    reTplListEl.appendChild(frag);
  }

  function doResend(opts={}) {
    const p=packets.find(x=>x.id===selectedId);
    if (!reEdEl) return false;
    const editorText=reEdEl.value;
    let out, tag="unknown", bytes=0;
    try {
      const substituted=applyVars(editorText);
      out=getResendPayloadFromEditor(p, substituted);
      if (typeof out==="string") bytes=new TextEncoder().encode(out).length;
      else if (out instanceof ArrayBuffer) bytes=out.byteLength;
      else if (out instanceof Uint8Array)  bytes=out.byteLength;
      if (p) tag=typeTag(p.parsed);
      reErrEl.textContent="";
    } catch(e) {
      reErrEl.textContent=e.message;
      resendHistory.push({ts:Date.now(),tag,bytes:0,ok:false,err:e.message});
      renderResendHistory();
      return false;
    }
    const ws=[...wsMap.keys()].find(w=>w.readyState===1);
    if (!ws) {
      reErrEl.textContent="No open WebSocket connection.";
      resendHistory.push({ts:Date.now(),tag,bytes:0,ok:false,err:"No open WebSocket"});
      renderResendHistory();
      return false;
    }
    if (p) queueResendLog(ws, p.id);
    try {
      ws.send(out);
      resendHistory.push({ts:Date.now(),tag,bytes,ok:true,err:null});
      setStatus(`Sent ${fmtBytes(bytes)} · ${tag}`);
      renderResendHistory();
      return true;
    } catch(e) {
      reErrEl.textContent=e.message;
      resendHistory.push({ts:Date.now(),tag,bytes,ok:false,err:e.message});
      renderResendHistory();
      return false;
    }
  }

  function doResendRepeat() {
    stopRepeat();
    const cnt=Math.max(1, parseInt(reCntEl?.value||"1",10)||1);
    const delay=Math.max(0, parseInt(reDelayEl?.value||"0",10)||0);
    if (cnt<=1&&delay===0) { doResend(); return; }
    const progEl=sidebar.querySelector("#zs-re-prog");
    reStopBtn.style.display="";
    let remaining=cnt, sent=0;
    const tick = () => {
      if (remaining<=0) { stopRepeat(); return; }
      doResend();
      remaining--; sent++;
      if (progEl) progEl.textContent=`${sent}/${cnt}`;
      resendRepeatHandle=setTimeout(tick, delay>0?delay:0);
    };
    tick();
  }

  function stopRepeat() {
    clearTimeout(resendRepeatHandle);
    resendRepeatHandle=null;
    if (reStopBtn) reStopBtn.style.display="none";
    const progEl=sidebar.querySelector("#zs-re-prog");
    if (progEl) progEl.textContent="";
  }

  // Show a temporary preview overlay for variable substitution
  function showPreviewOverlay(text) {
    let overlay=sidebar.querySelector("#zs-prev-overlay");
    if (!overlay) {
      overlay=document.createElement("div");
      overlay.id="zs-prev-overlay";
      overlay.style.cssText="position:absolute;inset:0;background:var(--bg);z-index:10;padding:10px;overflow:auto;user-select:text;font-size:11px;line-height:1.65;white-space:pre;";
      const close=document.createElement("button");
      close.className="zvb";
      close.style.cssText="position:absolute;top:8px;right:8px;";
      close.textContent="✕ close";
      close.addEventListener("click", ()=>overlay.remove());
      overlay.appendChild(close);
      sidebar.querySelector("#zs-resend-p").appendChild(overlay);
    }
    overlay.childNodes.forEach(n => { if (n.nodeType===3||n.tagName==="PRE") n.remove(); });
    const pre=document.createElement("pre");
    pre.style.cssText="margin-top:28px;color:var(--txt);";
    pre.textContent=text;
    overlay.appendChild(pre);
  }

  // ═══════════════════════════════════════════════════════════
  //  Packet notes
  // ═══════════════════════════════════════════════════════════
  function promptNote(p) {
    const current=packetNotes.get(p.id)||"";
    const note=prompt("Note for packet #"+p.id+" (empty to clear):", current);
    if (note===null) return; // cancelled
    if (note.trim()==="") packetNotes.delete(p.id);
    else packetNotes.set(p.id, note.trim());
    scheduleRender(true);
    if (p.id===selectedId) openViewer(p);
  }

  // ═══════════════════════════════════════════════════════════
  //  Copy helpers — JS and Python snippets
  // ═══════════════════════════════════════════════════════════
  function copyAsCodeJS(p) {
    const ws=[...wsMap.keys()].find(w=>w.readyState===1);
    const url=wsMap.get(ws??p.ws)?.url??"wss://...";
    const json=JSON.stringify(p.parsed.json??p.parsed, null, 2);
    const code=
`// Resend packet #${p.id}  (${typeTag(p.parsed)})
const ws = new WebSocket(${JSON.stringify(url)});
ws.addEventListener("open", () => {
  ws.send(JSON.stringify(
${json.replace(/^/gm,"    ")}
  ));
});`;
    navigator.clipboard.writeText(code).then(()=>setStatus("JS snippet copied"));
  }

  function copyAsCodePy(p) {
    const ws=[...wsMap.keys()].find(w=>w.readyState===1);
    const url=wsMap.get(ws??p.ws)?.url??"wss://...";
    const json=JSON.stringify(p.parsed.json??p.parsed, null, 2);
    const code=
`# Resend packet #${p.id}  (${typeTag(p.parsed)})
import websocket, json, threading

payload = ${json}

def on_open(ws):
    ws.send(json.dumps(payload))

ws = websocket.WebSocketApp(
    ${JSON.stringify(url)},
    on_open=on_open,
)
threading.Thread(target=ws.run_forever, daemon=True).start()
input("Press Enter to stop...\\n")
ws.close()`;
    navigator.clipboard.writeText(code).then(()=>setStatus("Python snippet copied"));
  }

  // ═══════════════════════════════════════════════════════════
  //  Resend encoding helpers (unchanged from v2)
  // ═══════════════════════════════════════════════════════════
  function encodeBlueboatPacket(decoded) {
    const raw = decoded?._raw && typeof decoded._raw==="object"
      ? decoded._raw
      : {type:2, data:[decoded?.eventName,decoded?.payload], options:{compress:true}, nsp:"/"};
    if (!raw?.data) throw new Error("Blueboat resend needs _raw or eventName/payload data.");
    const encoded=msgpackEncode(raw);
    const out=new Uint8Array(1+encoded.byteLength);
    out[0]=4; out.set(new Uint8Array(encoded),1);
    return out.buffer;
  }

  function encodeColyseusPacket(decoded) {
    if (!decoded||!("channel" in decoded)) throw new Error("Colyseus resend needs a channel.");
    const channel=new Uint8Array(msgpackEncode(decoded.channel));
    const body=new Uint8Array(msgpackEncode(decoded.body));
    const out=new Uint8Array(1+channel.length+body.length);
    out[0]=COLYSEUS_MSG; out.set(channel,1); out.set(body,1+channel.length);
    return out.buffer;
  }

  function encodeStructuredResend(parsed) {
    if (parsed?.transport==="blueboat") return encodeBlueboatPacket(parsed);
    if (parsed?.transport==="colyseus") return encodeColyseusPacket(parsed);
    return null;
  }

  function getEditableResendBody(p) {
    const raw=p?.parsed?.raw;
    if (typeof raw==="string") return raw;
    if (raw!=null && typeof raw!=="object") return String(raw);
    return fullBody(p?.parsed??{});
  }

  function getResendPayloadFromEditor(p, text) {
    const fallbackRaw=p?.parsed?.raw;
    if (typeof fallbackRaw==="string") {
      try {
        const parsed=JSON.parse(text);
        if (parsed&&typeof parsed==="object"&&typeof parsed.raw==="string") return parsed.raw;
      } catch {}
      return text;
    }
    let parsed;
    try { parsed=JSON.parse(text); }
    catch(e) { throw new Error(`JSON: ${e.message}`); }
    const structured=encodeStructuredResend(parsed);
    if (structured) return structured;
    return JSON.stringify(parsed);
  }

  function queueResendLog(ws, sourceId) {
    const q=resendLogQ.get(ws)||[];
    q.push({sourceId});
    resendLogQ.set(ws, q);
  }
  function takeResendLog(ws) {
    const q=resendLogQ.get(ws);
    if (!q?.length) return null;
    const next=q.shift();
    if (q.length) resendLogQ.set(ws,q);
    else resendLogQ.delete(ws);
    return next;
  }

  // ═══════════════════════════════════════════════════════════
  //  Packet actions
  // ═══════════════════════════════════════════════════════════
  function toggleFlag(p) {
    p.flagged=!p.flagged;
    p.flagged ? flaggedIds.add(p.id) : flaggedIds.delete(p.id);
    scheduleRender(filter.flaggedOnly); // full rebuild only if filtering by flagged
  }

  function clearPackets() {
    packets=packets.filter(p=>pinnedIds.has(p.id));
    inCount=packets.filter(p=>p.direction==="IN").length;
    outCount=packets.filter(p=>p.direction==="OUT").length;
    flaggedIds.clear(); packetNotes.clear();
    packets.forEach(p=>{ p.flagged=false; });
    pendingPackets=[];
    selectedId=null;
    lastRenderedCount=0;
    closeViewer();
    scheduleRender(true);
    updateStats();
  }

  function resetSession() {
    packets=[]; pendingPackets=[]; inCount=0; outCount=0;
    firstPacketTs=null; lastRenderedCount=0;
    pinnedIds.clear(); flaggedIds.clear(); packetNotes.clear();
    sparklinePkt.fill(0); sparklineB.fill(0);
    filter.query=""; filter.type=""; filter.direction="ALL"; filter.flaggedOnly=false;
    filterInput.value=""; filterInput.classList.remove("rx","rxe");
    sidebar.querySelectorAll(".zd").forEach(b=>b.classList.toggle("on",b.dataset.dir==="ALL"));
    selectedForDiffId=null;
    resendHistory.length=0;
    hooksGen++;
    stopRepeat();
    closeViewer();
    renderResendHistory();
    scheduleRender(true);
    updateStats();
    setStatus("session reset");
  }

  function exportPackets() {
    const data=filteredPackets().map((p,i)=>({
      index:i, id:p.id, direction:p.direction,
      timestamp:new Date(p.timestamp).toISOString(),
      type:typeTag(p.parsed),
      wsUrl:wsMap.get(p.ws)?.url??null,
      payload:p.parsed.json??p.parsed,
      note:packetNotes.get(p.id)??null,
      flagged:flaggedIds.has(p.id),
      pinned:pinnedIds.has(p.id),
      resent:Boolean(p.resent),
      resendSourceId:p.resendSourceId??null,
    }));
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=`packets-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${data.length} packets`);
  }

  // Import previously exported packet JSON back into the viewer
  function importPackets() {
    const input=document.createElement("input");
    input.type="file"; input.accept=".json,application/json";
    input.addEventListener("change", () => {
      const file=input.files?.[0];
      if (!file) return;
      const reader=new FileReader();
      reader.onload=e => {
        let data;
        try { data=JSON.parse(e.target.result); }
        catch(err) { setStatus("Import failed: "+err.message); return; }
        if (!Array.isArray(data)) { setStatus("Import failed: expected array"); return; }
        let count=0;
        for (const entry of data) {
          if (!entry.direction||!entry.payload) continue;
          const parsed=Object.assign({json:entry.payload,_tag:entry.type},entry.payload);
          parsed._tag=entry.type;
          parsed._sz=null;
          const p={
            id:packetId++, direction:entry.direction,
            parsed, timestamp:new Date(entry.timestamp??0).getTime()||Date.now(),
            ws:null, resent:false, resendSourceId:null, generation:hooksGen,
            _imported:true,
          };
          if (!firstPacketTs) firstPacketTs=p.timestamp;
          if (entry.flagged) flaggedIds.add(p.id);
          if (entry.note) packetNotes.set(p.id, entry.note);
          packets.push(p);
          entry.direction==="IN" ? inCount++ : outCount++;
          count++;
        }
        scheduleRender(true);
        updateStats();
        setStatus(`Imported ${count} packets`);
      };
      reader.readAsText(file);
    });
    input.click();
  }

  // ═══════════════════════════════════════════════════════════
  //  Packet logging
  // ═══════════════════════════════════════════════════════════
  function logPacket(direction, ws, payload, opts={}) {
    const parsed=typeof payload==="string" ? parseText(payload) : parseBinary(payload);
    const ts=Date.now();
    if (!firstPacketTs) firstPacketTs=ts;

    direction==="IN" ? inCount++ : outCount++;
    recordInSlot(payloadSize(parsed));

    const p={
      id:packetId++, direction, parsed, timestamp:ts, ws,
      resent:Boolean(opts.resent),
      resendSourceId:opts.resendSourceId??null,
      generation:hooksGen,
    };

    if (isPaused) {
      pendingPackets.push(p);
      sidebar.querySelector("#zs-pn").textContent=`${pendingPackets.length} buffered`;
      return;
    }

    packets.push(p);

    // Trim old packets, keep pinned ones
    if (packets.length > MAX_PACKETS*1.25) {
      const pinned=packets.filter(x=>pinnedIds.has(x.id));
      const rest=packets.filter(x=>!pinnedIds.has(x.id)).slice(-MAX_PACKETS);
      packets=[...pinned,...rest].sort((a,b)=>a.id-b.id);
      lastRenderedCount=0; // force full rerender after trim
    }

    scheduleRender(false);
    console.debug("[PS]", direction, typeTag(parsed), parsed);
  }

  // ═══════════════════════════════════════════════════════════
  //  Sidebar state helpers
  // ═══════════════════════════════════════════════════════════
  function toggleSidebar() {
    sidebarOpen=!sidebarOpen;
    sidebar.classList.toggle("hidden",!sidebarOpen);
    applyMargin();
  }
  function togglePause() {
    isPaused=!isPaused;
    pauseBtnEl.textContent=isPaused?"Resume":"Pause";
    pauseBtnEl.classList.toggle("on",isPaused);
    if (!isPaused) {
      pendingPackets.forEach(p=>packets.push(p));
      pendingPackets=[];
      sidebar.querySelector("#zs-pn").textContent="";
      scheduleRender(true);
      updateStats();
    }
  }
  function setAS(enabled, snap) {
    autoScroll=enabled;
    autoscrollBtnEl.classList.toggle("on",autoScroll);
    if (enabled&&snap) listEl.scrollTop=listEl.scrollHeight;
  }
  function setStatus(msg) { if (statusEl) statusEl.textContent=msg; }
  function applyMargin() {
    document.body.style.marginRight=sidebarOpen?`${currentWidth}px`:"0";
    document.body.style.transition="margin-right .18s ease";
    document.body.style.boxSizing="border-box";
  }

  // ═══════════════════════════════════════════════════════════
  //  WebSocket hooks
  // ═══════════════════════════════════════════════════════════
  function installHooks() {
    if (wsHooksInstalled) return;
    wsHooksInstalled=true;
    const OrigWS=window.WebSocket;

    function PatchedWS(...args) {
      const ws=new OrigWS(...args);
      const url=String(args[0]??"");
      const info={id:++wsSeq,url};
      wsMap.set(ws,info);

      ws.addEventListener("open",  ()  => { setStatus(`WS #${info.id} open · ${url}`); updateStats(); });
      ws.addEventListener("close", e   => { setStatus(`WS #${info.id} closed (${e.code})`); updateStats(); });
      ws.addEventListener("error", ()  => { setStatus(`WS #${info.id} error`); });

      const origSend=ws.send;
      ws.send=function(data) {
        const meta=takeResendLog(ws);
        try { logPacket("OUT",ws,data, meta?{resent:true,resendSourceId:meta.sourceId}:{}); }
        catch(e) { console.warn("[PS] OUT err",e); }
        return origSend.call(this,data);
      };

      ws.addEventListener("message", e => {
        try { logPacket("IN",ws,e.data); }
        catch(e2) { console.warn("[PS] IN err",e2); }
      });

      return ws;
    }

    PatchedWS.prototype=OrigWS.prototype;
    Object.setPrototypeOf(PatchedWS,OrigWS);
    Object.defineProperty(window,"WebSocket",{value:PatchedWS,writable:true,configurable:true});
  }

  // ═══════════════════════════════════════════════════════════
  //  Init
  // ═══════════════════════════════════════════════════════════
  function init() {
    if (initialized||!document.body) return;
    initialized=true;
    injectStyles();
    buildSidebar();
    installHooks();
    updateStats();
    console.log(`[PacketSniffer] v${VERSION} — [K] toggle · [/] filter · [↑↓] nav`);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded",init);
    const obs=new MutationObserver(()=>{ if (document.body){ obs.disconnect(); init(); } });
    obs.observe(document.documentElement,{childList:true});
  }
})();
