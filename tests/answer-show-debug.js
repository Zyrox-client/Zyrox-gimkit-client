// ==UserScript==
// @name         Zyrox Gimkit Question ID Extractor (Debug)
// @namespace    https://github.com/zyrox
// @version      0.2.1
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
  const ID_LIKE_RE = /^[a-f0-9]{8,}$/i;
  const BAD_IDS = new Set(["content", "question", "game", "player", "host", "team", "true", "false"]);

  const state = {
    currentQuestionId: null,
    source: null,
    questionsById: new Map(),
    namedIdMap: new Map(),
    aliasMap: new Map(),
    lastQuestionSignature: null,
  };

  function isLikelyQuestionId(value) {
    if (typeof value !== "string") return false;
    const v = value.trim();
    if (!v || v.length < 8) return false;
    if (BAD_IDS.has(v.toLowerCase())) return false;
    if (v.includes(" ")) return false;
    return ID_LIKE_RE.test(v) || v.includes("_") || v.includes("-");
  }

  function resolveId(id, seen = new Set()) {
    if (!id || seen.has(id)) return id || null;
    seen.add(id);
    const redirected = state.aliasMap.get(id) || state.namedIdMap.get(id);
    return redirected ? resolveId(redirected, seen) : id;
  }

  function setCurrentQuestionId(id, source, extra = {}) {
    if (!isLikelyQuestionId(id)) return;
    const resolved = resolveId(id);
    if (!isLikelyQuestionId(resolved)) return;
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
    widgetEl.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:999999;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.3;background:rgba(0,0,0,.82);color:#7CFF9D;padding:8px 10px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:340px;pointer-events:none;white-space:pre-wrap;";
    document.documentElement.appendChild(widgetEl);
    return widgetEl;
  }

  function updateWidget(id, source, question) {
    const el = ensureWidget();
    const prompt = question?.text || question?.prompt || "(prompt unavailable)";
    el.textContent = `Question ID: ${id}\nSource: ${source}\nPrompt: ${String(prompt).slice(0, 90)}`;
  }

  function walk(value, visit, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
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
      if (!(obj instanceof Map) || !obj.size) return;
      for (const [k, v] of obj.entries()) {
        if (typeof k === "string" && v && typeof v === "object") {
          const qid = v._id || v.id || k;
          if (isLikelyQuestionId(qid)) state.questionsById.set(qid, v);
        }
        if (typeof k === "string" && typeof v === "string") {
          if (isLikelyQuestionId(v)) state.namedIdMap.set(k, v);
          if (isLikelyQuestionId(k) && isLikelyQuestionId(v)) state.aliasMap.set(k, v);
        }
      }
    });
  }

  function maybeExtractQuestionFromBag(bag, source, meta) {
    if (!bag || typeof bag !== "object") return false;

    const directCandidates = [bag.questionId, bag.currentQuestionId, bag.activeQuestionId, bag.question_id, bag.currentQuestionID];
    for (const c of directCandidates) {
      if (isLikelyQuestionId(c)) {
        setCurrentQuestionId(c, source, meta);
        return true;
      }
    }

    const questionObj = bag.question || bag.currentQuestion || bag.activeQuestion || bag.item;
    const qid = questionObj?._id || questionObj?.id;
    if (isLikelyQuestionId(qid)) {
      setCurrentQuestionId(qid, source, meta);
      return true;
    }

    const list = bag.questionList || bag.questions || bag.items;
    const idx = bag.questionIndex ?? bag.currentQuestionIndex ?? bag.activeQuestionIndex;
    if (Array.isArray(list) && Number.isInteger(idx) && isLikelyQuestionId(list[idx])) {
      setCurrentQuestionId(list[idx], source, { ...meta, idx });
      return true;
    }

    return false;
  }

  function scanFiberForQuestionId() {
    const roots = [];
    for (const node of document.querySelectorAll("*")) {
      const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      if (key && node[key]) roots.push({ node, fiber: node[key] });
    }

    for (const { node, fiber } of roots) {
      const stack = [fiber];
      const seen = new Set();
      let steps = 0;

      while (stack.length && steps < 8000) {
        steps++;
        const f = stack.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);

        const props = f.memoizedProps;
        const memoState = f.memoizedState;

        collectMapsFromObject(props);
        collectMapsFromObject(memoState);

        if (maybeExtractQuestionFromBag(props, "react-fiber-props", { node: node.tagName })) return true;
        if (maybeExtractQuestionFromBag(memoState, "react-fiber-state", { node: node.tagName })) return true;

        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
        if (f.return) stack.push(f.return);
      }
    }
    return false;
  }

  function correlateVisibleQuestionText() {
    const joinedText = Array.from(document.querySelectorAll("h1,h2,h3,[class*='question'],[data-testid*='question']"))
      .slice(0, 16)
      .map((n) => n.textContent?.trim())
      .filter(Boolean)
      .join(" ");
    if (!joinedText || joinedText.length < 12) return;

    if (joinedText === state.lastQuestionSignature) return;
    state.lastQuestionSignature = joinedText;

    for (const [id, question] of state.questionsById.entries()) {
      const text = question?.text || question?.prompt || "";
      if (typeof text === "string" && text.length > 12 && joinedText.includes(text.slice(0, 24))) {
        setCurrentQuestionId(id, "mutation-text-correlation");
        break;
      }
    }
  }

  const observer = new MutationObserver(() => {
    scanFiberForQuestionId();
    correlateVisibleQuestionText();
  });

  function processPlainObjectPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    const items = Array.isArray(payload) ? payload : [payload];

    for (const item of items) {
      const candidate = item?.data && typeof item.data === "object" ? item.data : item;
      if (!candidate || typeof candidate !== "object") continue;
      const key = candidate.key;
      const data = candidate.data;

      const isQuestions = key === "GAME_QUESTIONS" || data?.type === "GAME_QUESTIONS";
      if (isQuestions) {
        const questions = Array.isArray(data?.value) ? data.value : Array.isArray(data) ? data : [];
        for (const q of questions) {
          const id = q?._id || q?.id;
          if (isLikelyQuestionId(id)) state.questionsById.set(id, q);
        }
      }

      const isList = key === "PLAYER_QUESTION_LIST" || data?.type === "PLAYER_QUESTION_LIST";
      if (isList) {
        const list = data?.value?.questionList || data?.questionList || [];
        const idx = data?.value?.questionIndex ?? data?.questionIndex ?? 0;
        if (Array.isArray(list) && isLikelyQuestionId(list[idx])) {
          setCurrentQuestionId(list[idx], "packet-player-question-list", { idx });
        }
      }

      if (key === "PLAYER_QUESTION_LIST_INDEX" || data?.type === "PLAYER_QUESTION_LIST_INDEX") {
        const idx = data?.value ?? data;
        const list = data?.questionList || data?.value?.questionList;
        if (Array.isArray(list) && Number.isInteger(idx) && isLikelyQuestionId(list[idx])) {
          setCurrentQuestionId(list[idx], "packet-player-question-index", { idx });
        }
      }

      if (key === "QUESTION_REVEALED") {
        const q = data?.question || data;
        const qid = q?._id || q?.id;
        if (isLikelyQuestionId(qid)) {
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

  function safelyParseJson(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  function inspectRawMessage(rawData) {
    if (typeof rawData === "string") {
      const parsed = safelyParseJson(rawData);
      if (parsed) processPlainObjectPayload(parsed);
      return;
    }

    if (!(rawData instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(rawData);
    if (!bytes.byteLength) return;

    if (bytes[0] === 4) {
      // Keep parse shallow; several environments wrap payload in nested objects.
      try {
        const decodedText = new TextDecoder().decode(bytes.slice(1));
        const parsed = safelyParseJson(decodedText);
        if (parsed) processPlainObjectPayload(parsed);
      } catch (_) {}
    }
  }

  const nativeAddEventListener = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (type, listener, options) {
    if (type === "message" && !this.__zyroxQidPatched) {
      this.__zyroxQidPatched = true;
      nativeAddEventListener.call(this, "message", (event) => {
        normalizeData(event.data).then(inspectRawMessage).catch(() => {});
      });
    }
    return nativeAddEventListener.call(this, type, listener, options);
  };

  window.addEventListener("load", () => {
    ensureWidget();
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    setInterval(() => {
      scanFiberForQuestionId();
      correlateVisibleQuestionText();
      collectMapsFromObject(window);
    }, 700);

    console.log(LOG_PREFIX, "Loaded. Extractor active (React Fiber primary, network/mutation/storage fallbacks).");
  });
})();
