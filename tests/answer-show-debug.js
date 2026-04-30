// ==UserScript==
// @name         Zyrox Gimkit Question ID Extractor (Debug)
// @namespace    https://github.com/zyrox
// @version      0.2.0
// @description  Extracts and displays the current Gimkit question ID in real-time using React Fiber + packet fallbacks.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @match        https://www.gimkit.com/play*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxQuestionIdExtractor]";

  const state = {
    currentQuestionId: null,
    source: null,
    questionsById: new Map(),
    namedIdMap: new Map(),
    aliasMap: new Map(),
  };

  function resolveId(id, seen = new Set()) {
    if (!id || seen.has(id)) return id || null;
    seen.add(id);
    const redirected = state.aliasMap.get(id);
    return redirected ? resolveId(redirected, seen) : id;
  }

  function setCurrentQuestionId(id, source, extra = {}) {
    if (!id) return;
    const resolved = resolveId(id);
    if (resolved === state.currentQuestionId && source === state.source) return;
    state.currentQuestionId = resolved;
    state.source = source;

    const question = state.questionsById.get(resolved) || null;
    updateWidget(resolved, source, question);
    console.log(LOG_PREFIX, "Current question ID:", resolved, { source, question, ...extra });
  }

  let widgetEl;
  function ensureWidget() {
    if (widgetEl && document.contains(widgetEl)) return widgetEl;
    widgetEl = document.createElement("div");
    widgetEl.id = "zyrox-question-id-widget";
    widgetEl.style.cssText = [
      "position:fixed",
      "right:10px",
      "bottom:10px",
      "z-index:999999",
      "font-family:ui-monospace,SFMono-Regular,Menlo,monospace",
      "font-size:12px",
      "line-height:1.3",
      "background:rgba(0,0,0,0.82)",
      "color:#7CFF9D",
      "padding:8px 10px",
      "border-radius:8px",
      "box-shadow:0 4px 16px rgba(0,0,0,0.3)",
      "max-width:320px",
      "pointer-events:none",
      "white-space:pre-wrap",
    ].join(";");
    document.documentElement.appendChild(widgetEl);
    return widgetEl;
  }

  function updateWidget(id, source, question) {
    const el = ensureWidget();
    const prompt = question?.text || question?.prompt || "(prompt unavailable)";
    el.textContent = `Question ID: ${id}\nSource: ${source}\nPrompt: ${String(prompt).slice(0, 90)}`;
  }

  function walk(value, visit, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    visit(value);

    if (Array.isArray(value)) {
      for (const v of value) walk(v, visit, seen);
      return;
    }

    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v && typeof v === "object") walk(v, visit, seen);
    }
  }

  function collectMapsFromObject(root) {
    walk(root, (obj) => {
      if (obj instanceof Map) {
        if (!obj.size) return;
        let objectValues = 0;
        let stringValues = 0;
        let stringToString = 0;

        for (const [k, v] of obj.entries()) {
          if (v && typeof v === "object") objectValues++;
          if (typeof v === "string") stringValues++;
          if (typeof k === "string" && typeof v === "string") stringToString++;
        }

        if (objectValues > 0) {
          for (const [k, v] of obj.entries()) {
            if (typeof k === "string" && v && typeof v === "object") {
              state.questionsById.set(k, v);
            }
          }
        }

        if (stringToString > 0 && stringValues > 0) {
          for (const [k, v] of obj.entries()) {
            if (typeof k === "string" && typeof v === "string") {
              state.namedIdMap.set(k, v);
              if (/^[a-f0-9]{16,}$/i.test(k) || /^[a-f0-9]{16,}$/i.test(v)) {
                state.aliasMap.set(k, v);
              }
            }
          }
        }
      }
    });
  }

  function scanFiberForQuestionId() {
    const nodes = document.querySelectorAll("*");
    for (const node of nodes) {
      const keys = Object.keys(node);
      const fiberKey = keys.find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      if (!fiberKey) continue;

      let fiber = node[fiberKey];
      let depth = 0;
      while (fiber && depth < 1200) {
        depth++;
        const props = fiber.memoizedProps;
        const stateNode = fiber.memoizedState;

        collectMapsFromObject(props);
        collectMapsFromObject(stateNode);

        const candidates = [];
        if (props && typeof props === "object") candidates.push(props);
        if (stateNode && typeof stateNode === "object") candidates.push(stateNode);

        for (const bag of candidates) {
          const directId = bag.questionId || bag.currentQuestionId || bag.id;
          if (typeof directId === "string" && directId.length > 6) {
            setCurrentQuestionId(directId, "react-fiber-direct", { node: node.tagName });
            return true;
          }

          const q = bag.question || bag.currentQuestion || bag.activeQuestion;
          const qid = q?._id || q?.id;
          if (typeof qid === "string") {
            setCurrentQuestionId(qid, "react-fiber-question-object", { node: node.tagName });
            return true;
          }
        }

        fiber = fiber.child || fiber.sibling || fiber.return;
      }
    }
    return false;
  }

  const observer = new MutationObserver(() => {
    scanFiberForQuestionId();
    if (state.currentQuestionId) return;

    const joinedText = Array.from(document.querySelectorAll("h1,h2,h3,[class*='question'],[data-testid*='question']"))
      .slice(0, 12)
      .map((n) => n.textContent?.trim())
      .filter(Boolean)
      .join(" ");

    if (!joinedText) return;
    for (const [id, question] of state.questionsById.entries()) {
      const text = question?.text || question?.prompt || "";
      if (text && joinedText.includes(String(text).slice(0, 30))) {
        setCurrentQuestionId(id, "mutation-text-correlation");
        break;
      }
    }
  });

  function msgpackDecode(buffer, startOffset = 0) {
    const view = new DataView(buffer);
    let offset = startOffset;
    const readString = (len) => {
      let out = "";
      const end = offset + len;
      while (offset < end) out += String.fromCharCode(view.getUint8(offset++));
      return out;
    };
    const read = () => {
      const token = view.getUint8(offset++);
      if (token < 0x80) return token;
      if (token < 0x90) {
        const size = token & 0x0f;
        const map = {};
        for (let i = 0; i < size; i++) map[read()] = read();
        return map;
      }
      if (token < 0xa0) {
        const size = token & 0x0f;
        const arr = [];
        for (let i = 0; i < size; i++) arr.push(read());
        return arr;
      }
      if (token < 0xc0) return readString(token & 0x1f);
      if (token > 0xdf) return token - 256;
      if (token === 194) return false;
      if (token === 195) return true;
      if (token === 217) return readString(view.getUint8(offset++));
      if (token === 218) {
        const n = view.getUint16(offset);
        offset += 2;
        return readString(n);
      }
      if (token === 220) {
        const n = view.getUint16(offset);
        offset += 2;
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(read());
        return arr;
      }
      if (token === 222) {
        const n = view.getUint16(offset);
        offset += 2;
        const map = {};
        for (let i = 0; i < n; i++) map[read()] = read();
        return map;
      }
      return null;
    };
    return { value: read(), offset };
  }

  function processPacket(rawData) {
    if (!(rawData instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(rawData);
    if (!bytes.byteLength || bytes[0] !== 4) return;

    const decoded = msgpackDecode(rawData.slice(1))?.value;
    const payload = Array.isArray(decoded?.data) ? decoded.data[1] : decoded?.data;
    if (!payload) return;

    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) {
      const candidate = item?.data && typeof item.data === "object" ? item.data : item;
      const key = candidate?.key;
      const data = candidate?.data;

      if (key === "GAME_QUESTIONS" || data?.type === "GAME_QUESTIONS") {
        const questions = Array.isArray(data?.value) ? data.value : Array.isArray(data) ? data : [];
        for (const q of questions) {
          const id = q?._id || q?.id;
          if (id) state.questionsById.set(id, q);
        }
      }

      if (key === "PLAYER_QUESTION_LIST" || data?.type === "PLAYER_QUESTION_LIST") {
        const list = data?.value?.questionList || data?.questionList || [];
        const idx = data?.value?.questionIndex ?? data?.questionIndex ?? 0;
        const candidateId = list[idx];
        if (candidateId) setCurrentQuestionId(candidateId, "packet-player-question-list", { idx });
      }

      if (key === "QUESTION_REVEALED") {
        const q = data?.question || data;
        const qid = q?._id || q?.id;
        if (qid) {
          state.questionsById.set(qid, q);
          setCurrentQuestionId(qid, "packet-question-revealed");
        }
      }
    }
  }

  async function normalizeData(raw) {
    if (raw instanceof ArrayBuffer) return raw;
    if (ArrayBuffer.isView(raw)) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    if (typeof Blob !== "undefined" && raw instanceof Blob) return raw.arrayBuffer();
    return null;
  }

  const nativeAddEventListener = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (type, listener, options) {
    if (type === "message" && !this.__zyroxQidPatched) {
      this.__zyroxQidPatched = true;
      nativeAddEventListener.call(this, "message", (event) => {
        normalizeData(event.data).then(processPacket).catch(() => {});
      });
    }
    return nativeAddEventListener.call(this, type, listener, options);
  };

  window.addEventListener("load", () => {
    ensureWidget();
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    scanFiberForQuestionId();

    setInterval(() => {
      scanFiberForQuestionId();
      collectMapsFromObject(window);
      try {
        Object.keys(localStorage || {}).forEach((k) => {
          const v = localStorage.getItem(k);
          if (typeof v === "string" && v.includes("question")) {
            const found = v.match(/[a-f0-9]{16,}/gi);
            if (found?.length) setCurrentQuestionId(found[0], "localStorage-heuristic", { key: k });
          }
        });
      } catch (_) {}
    }, 1200);

    console.log(LOG_PREFIX, "Loaded. Extractor active (React Fiber primary, network/mutation/storage fallbacks).");
  });
})();
