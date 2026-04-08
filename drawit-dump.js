// ==UserScript==
// @name        Gimkit Draw That - Raw Dump
// @description Logs only the Draw That round answer (term) from STATE_UPDATE payloads
// @namespace   https://github.com/local/drawthat-rawdump
// @match       https://www.gimkit.com/join*
// @run-at      document-start
// @grant       none
// @version     1.1.0
// ==/UserScript==

(function () {
    'use strict';

    const SKIP = new Set(["DRAW_MODE_LD"]);
    const LOG_DUPLICATES = false;

    let lastLoggedAnswer = null;

    // ── Decoder (same as before) ─────────────────────────────────────────────────
    function bbDecode(buffer) {
        try {
            const first = new Uint8Array(buffer)[0];
            if (first >= 0x30 && first <= 0x36) return null;
            function BB(buf) {
                this.t = 0;
                this.i = (buf instanceof ArrayBuffer ? buf : buf.buffer).slice(1);
                this.s = new DataView(this.i);
            }
            BB.prototype.str = function(n) {
                let s = '';
                for (let i = this.t, e = this.t + n; i < e; i++) {
                    let a = this.s.getUint8(i);
                    if (a < 128) s += String.fromCharCode(a);
                    else if ((a&0xe0)===0xc0) s += String.fromCharCode((a&0x1f)<<6|(this.s.getUint8(++i)&0x3f));
                    else if ((a&0xf0)===0xe0) s += String.fromCharCode((a&0x0f)<<12|(this.s.getUint8(++i)&0x3f)<<6|(this.s.getUint8(++i)&0x3f));
                }
                this.t += n; return s;
            };
            BB.prototype.arr = function(n) { const a=[]; for(let i=0;i<n;i++) a.push(this.p()); return a; };
            BB.prototype.map = function(n) { const o={}; for(let i=0;i<n;i++){const k=this.p();o[k]=this.p();} return o; };
            BB.prototype.bin = function(n) { const v=this.i.slice(this.t,this.t+n); this.t+=n; return v; };
            BB.prototype.p = function() {
                if (this.t >= this.s.byteLength) return undefined;
                const b = this.s.getUint8(this.t++);
                if (b < 0x80) return b;
                if (b < 0x90) return this.map(b&0x0f);
                if (b < 0xa0) return this.arr(b&0x0f);
                if (b < 0xc0) return this.str(b&0x1f);
                if (b > 0xdf) return -(0x100-b);
                switch(b) {
                    case 0xc0: return null;   case 0xc2: return false;  case 0xc3: return true;
                    case 0xc4:{const n=this.s.getUint8(this.t);this.t+=1;return this.bin(n);}
                    case 0xca:{const v=this.s.getFloat32(this.t);this.t+=4;return v;}
                    case 0xcb:{const v=this.s.getFloat64(this.t);this.t+=8;return v;}
                    case 0xcc:{const v=this.s.getUint8(this.t);this.t+=1;return v;}
                    case 0xcd:{const v=this.s.getUint16(this.t);this.t+=2;return v;}
                    case 0xce:{const v=this.s.getUint32(this.t);this.t+=4;return v;}
                    case 0xd0:{const v=this.s.getInt8(this.t);this.t+=1;return v;}
                    case 0xd1:{const v=this.s.getInt16(this.t);this.t+=2;return v;}
                    case 0xd2:{const v=this.s.getInt32(this.t);this.t+=4;return v;}
                    case 0xd9:{const n=this.s.getUint8(this.t);this.t+=1;return this.str(n);}
                    case 0xda:{const n=this.s.getUint16(this.t);this.t+=2;return this.str(n);}
                    case 0xdc:{const n=this.s.getUint16(this.t);this.t+=2;return this.arr(n);}
                    case 0xdd:{const n=this.s.getUint32(this.t);this.t+=4;return this.arr(n);}
                    case 0xde:{const n=this.s.getUint16(this.t);this.t+=2;return this.map(n);}
                    case 0xdf:{const n=this.s.getUint32(this.t);this.t+=4;return this.map(n);}
                    default: return `<0x${b.toString(16)}>`;
                }
            };
            const parsed = new BB(buffer).p();
            if (Array.isArray(parsed?.data)) {
                const inner = parsed.data[1];
                return { key: inner?.key ?? parsed.data[0], data: inner?.data ?? inner };
            }
            return parsed ?? null;
        } catch(e) { return null; }
    }

    function getRoundAnswer(stateUpdatePayload) {
        if (!Array.isArray(stateUpdatePayload)) return null;

        for (const entry of stateUpdatePayload) {
            if (!entry || entry.type !== "DRAW_MODE_ROUND") continue;
            if (!Array.isArray(entry.value)) continue;

            for (const roundField of entry.value) {
                const key = roundField?.value?.key;
                if (key !== "term") continue;

                const answer = roundField?.value?.value;
                if (typeof answer === "string" && answer.trim()) return answer;
            }
        }

        return null;
    }

    // ── Hook ─────────────────────────────────────────────────────────────────────
    const hooked = new WeakSet();

    function hookSocket(ws) {
        if (hooked.has(ws)) return;
        hooked.add(ws);
        console.log("%c[RawDump] Socket hooked", "color:#0f0;font-weight:bold;");

        ws.addEventListener("message", (e) => {
            const decoded = bbDecode(e.data);
            if (!decoded?.key) return;
            const key = decoded.key;
            if (SKIP.has(key)) return;

            if (key === "STATE_UPDATE") {
                const answer = getRoundAnswer(decoded.data);
                if (!answer) return;
                if (!LOG_DUPLICATES && answer === lastLoggedAnswer) return;

                lastLoggedAnswer = answer;
                console.log(`%c[DrawThat Answer] ${answer}`, "color:#2ecc71;font-weight:bold;");
                return;
            }
        });

        // Also log outgoing (except DRAW_MODE_LD spam)
        const orig = ws.send.bind(ws);
        ws.send = function(data) {
            // Incoming answer extraction is all we need; skip outbound logs to reduce noise.
            orig(data);
        };
    }

    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
        if (!this.url?.startsWith("ws://localhost")) hookSocket(this);
        origSend.call(this, data);
    };

    console.log("%c[DrawThat Answer] Ready. Waiting for term updates...", "color:#0f0;font-style:italic;");
})();
