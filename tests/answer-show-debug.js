// ==UserScript==
// @name         Zyrox Gimkit Question ID Extractor (Debug)
// @namespace    https://github.com/zyrox
// @version      0.2.2
// @description  Extract and display the current Gimkit question ID with low-overhead React/state inspection.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @match        https://www.gimkit.com/play*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxQuestionIdExtractor]";
  const ID_RE = /^[a-f0-9_-]{8,}$/i;
  const BAD_IDS = new Set(["content", "question", "game", "player", "host", "team", "true", "false"]);

  const state = {
    currentQuestionId: null,
    source: null,
    questionsById: new Map(),
    lastTextSig: "",
    scanScheduled: false,
  };

  function isLikelyQuestionId(v) {
    return typeof v === "string" && v.length >= 8 && !v.includes(" ") && !BAD_IDS.has(v.toLowerCase()) && ID_RE.test(v);
  }

  function setCurrentQuestionId(id, source) {
    if (!isLikelyQuestionId(id)) return;
    if (state.currentQuestionId === id && state.source === source) return;
    state.currentQuestionId = id;
    state.source = source;
    const q = state.questionsById.get(id) || null;
    updateWidget(id, source, q);
    console.log(LOG_PREFIX, "Current question ID:", id, { source, question: q });
  }

  let widgetEl;
  function updateWidget(id, source, question) {
    if (!widgetEl || !document.contains(widgetEl)) {
      widgetEl = document.createElement("div");
      widgetEl.id = "zyrox-question-id-widget";
      widgetEl.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:999999;font:12px/1.3 ui-monospace,Menlo,monospace;background:rgba(0,0,0,.82);color:#7CFF9D;padding:8px 10px;border-radius:8px;max-width:340px;pointer-events:none;white-space:pre-wrap;";
      document.documentElement.appendChild(widgetEl);
    }
    const prompt = question?.text || question?.prompt || "(prompt unavailable)";
    widgetEl.textContent = `Question ID: ${id || "(none)"}
Source: ${source || "(none)"}
Prompt: ${String(prompt).slice(0, 90)}`;
  }

  function getFiberRootCandidates() {
    const candidates = [];
    try {
      const appRoot = document.querySelector("#root,[data-reactroot]");
      if (appRoot) {
        const keys = Object.keys(appRoot);
        for (const k of keys) {
          if ((k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$")) && appRoot[k]) candidates.push(appRoot[k]);
        }
      }
    } catch (_) {}
    return candidates;
  }

  function maybeUseBag(bag, source) {
    if (!bag || typeof bag !== "object") return false;
    const ids = [bag.questionId, bag.currentQuestionId, bag.activeQuestionId, bag.question_id];
    for (const id of ids) if (isLikelyQuestionId(id)) return setCurrentQuestionId(id, source), true;

    const q = bag.question || bag.currentQuestion || bag.activeQuestion;
    const qid = q?._id || q?.id;
    if (isLikelyQuestionId(qid)) {
      state.questionsById.set(qid, q);
      setCurrentQuestionId(qid, source + "-question");
      return true;
    }

    const list = bag.questionList || bag.questions;
    const idx = bag.questionIndex ?? bag.currentQuestionIndex;
    if (Array.isArray(list) && Number.isInteger(idx) && isLikelyQuestionId(list[idx])) {
      setCurrentQuestionId(list[idx], source + "-list");
      return true;
    }
    return false;
  }

  function scanFiber() {
    const rootsRaw = getFiberRootCandidates();
    const roots = Array.isArray(rootsRaw) ? rootsRaw : [];
    if (!roots.length) return false;

    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      if (!root) continue;
      const start = root.current || root;
      if (!start || typeof start !== "object") continue;

      const stack = [start];
      const seen = new Set();
      let count = 0;

      while (stack.length && count < 1500) {
        count++;
        const f = stack.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);

        if (maybeUseBag(f.memoizedProps, "fiber-props")) return true;
        if (maybeUseBag(f.memoizedState, "fiber-state")) return true;

        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    return false;
  }

  function correlateText() {
    const text = Array.from(document.querySelectorAll("h1,h2,h3,[class*='question']")).slice(0, 8).map(n => n.textContent?.trim()).filter(Boolean).join(" ");
    if (!text || text.length < 12 || text === state.lastTextSig) return;
    state.lastTextSig = text;
    for (const [id, q] of state.questionsById.entries()) {
      const t = q?.text || q?.prompt || "";
      if (typeof t === "string" && t.length > 10 && text.includes(t.slice(0, 20))) {
        setCurrentQuestionId(id, "text-correlation");
        break;
      }
    }
  }

  function processPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    const items = Array.isArray(payload) ? payload : [payload];
    for (const raw of items) {
      const item = raw?.data && typeof raw.data === "object" ? raw.data : raw;
      const key = item?.key;
      const data = item?.data;

      if (key === "GAME_QUESTIONS" || data?.type === "GAME_QUESTIONS") {
        const arr = Array.isArray(data?.value) ? data.value : Array.isArray(data) ? data : [];
        for (const q of arr) {
          const id = q?._id || q?.id;
          if (isLikelyQuestionId(id)) state.questionsById.set(id, q);
        }
      }
      if (key === "PLAYER_QUESTION_LIST" || data?.type === "PLAYER_QUESTION_LIST") {
        const list = data?.value?.questionList || data?.questionList;
        const idx = data?.value?.questionIndex ?? data?.questionIndex ?? 0;
        if (Array.isArray(list) && isLikelyQuestionId(list[idx])) setCurrentQuestionId(list[idx], "packet-list");
      }
      if (key === "QUESTION_REVEALED") {
        const q = data?.question || data;
        const id = q?._id || q?.id;
        if (isLikelyQuestionId(id)) {
          state.questionsById.set(id, q);
          setCurrentQuestionId(id, "packet-revealed");
        }
      }
    }
  }

  function scheduleScan() {
    if (state.scanScheduled) return;
    state.scanScheduled = true;
    setTimeout(() => {
      state.scanScheduled = false;
      try {
        scanFiber();
        correlateText();
      } catch (error) {
        console.warn(LOG_PREFIX, "scan error", error);
      }
    }, 120);
  }

  const nativeAddEventListener = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (type, listener, options) {
    if (type === "message" && !this.__zyroxQidPatched) {
      this.__zyroxQidPatched = true;
      nativeAddEventListener.call(this, "message", (event) => {
        try {
          const data = event.data;
          if (typeof data === "string") {
            const parsed = JSON.parse(data);
            processPayload(parsed);
          }
        } catch (_) {}
        scheduleScan();
      });
    }
    return nativeAddEventListener.call(this, type, listener, options);
  };

  window.addEventListener("load", () => {
    updateWidget(null, null, null);
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    setInterval(scheduleScan, 2000);
    scheduleScan();
    console.log(LOG_PREFIX, "Loaded (low-overhead mode).");
  });
})();
