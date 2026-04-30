// ==UserScript==
// @name         Gimkit Question DOM Edit Debugger
// @namespace    https://github.com/zyrox
// @version      1.1.0
// @description  Debug helper to detect which script edits question DOM nodes.
// @author       Zyrox
// @match        https://www.gimkit.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const TAG = "[QuestionDOMDebug]";
  const watchedKeywords = ["question", "answer", "prompt", "choice", "option", "notranslate", "lang-en"];
  const watchedAttributes = ["questioncolor", "answercolors", "position", "defaultbackgroundcolor"];

  function matchesWatchSignals(el) {
    if (!el || el.nodeType !== 1) return false;
    const id = (el.id || "").toLowerCase();
    const cls = (el.className || "").toString().toLowerCase();
    const role = (el.getAttribute?.("role") || "").toLowerCase();
    const aria = (el.getAttribute?.("aria-label") || "").toLowerCase();
    const attrs = el.getAttributeNames ? el.getAttributeNames().join(" ").toLowerCase() : "";
    const text = `${id} ${cls} ${role} ${aria} ${attrs}`;

    if (watchedKeywords.some((k) => text.includes(k))) return true;
    return watchedAttributes.some((name) => el.hasAttribute?.(name));
  }

  function shouldWatchElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (matchesWatchSignals(el)) return true;

    let current = el.parentElement;
    let depth = 0;
    while (current && depth < 6) {
      if (matchesWatchSignals(current)) return true;
      current = current.parentElement;
      depth++;
    }

    if (el.querySelector) {
      const nested = el.querySelector("[questioncolor],[answercolors],[position],span.notranslate,[class*='lang-']");
      if (nested) return true;
    }

    return false;
  }

  function getPath(node) {
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && parts.length < 8) {
      const tag = current.tagName.toLowerCase();
      const id = current.id ? `#${current.id}` : "";
      let cls = "";
      if (current.classList && current.classList.length) {
        cls = "." + Array.from(current.classList).slice(0, 3).join(".");
      }
      parts.unshift(`${tag}${id}${cls}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function findLikelySourceFromStack(stack) {
    if (!stack) return "unknown";
    const lines = String(stack).split("\n").slice(1);
    for (const line of lines) {
      if (line.includes("gimkit.com") || line.includes("webpack") || line.includes("bundle") || line.includes("chunk")) {
        return line.trim();
      }
    }
    return lines[0]?.trim() || "unknown";
  }

  function logEdit(kind, target, extra = {}) {
    const err = new Error();
    const source = findLikelySourceFromStack(err.stack);
    const payload = {
      kind,
      path: getPath(target),
      source,
      time: new Date().toISOString(),
      ...extra,
    };

    console.groupCollapsed(`${TAG} ${kind} :: ${payload.path}`);
    console.log("Details:", payload);
    console.log("Target:", target);
    console.log("Stack:", err.stack);
    console.groupEnd();

    window.__questionDomDebugEvents ||= [];
    window.__questionDomDebugEvents.push(payload);
    if (window.__questionDomDebugEvents.length > 1000) window.__questionDomDebugEvents.shift();
  }

  function patchSetter(proto, key, kind, extractValue) {
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    if (!desc?.set || !desc?.get) return;

    Object.defineProperty(proto, key, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(value) {
        if (shouldWatchElement(this)) {
          logEdit(kind, this, extractValue ? extractValue(value) : { valueType: typeof value });
        }
        return desc.set.call(this, value);
      },
    });
  }

  function patchMethod(proto, methodName, kind, getTarget) {
    const original = proto[methodName];
    if (typeof original !== "function") return;

    proto[methodName] = function (...args) {
      const target = getTarget ? getTarget(this, args) : this;
      if (shouldWatchElement(target)) {
        logEdit(kind, target, {
          argsPreview: args.map((a) => (typeof a === "string" ? a.slice(0, 120) : a?.nodeType ? `node:${a.nodeName}` : typeof a)),
        });
      }
      return original.apply(this, args);
    };
  }

  function startMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target?.nodeType === 3 ? mutation.target.parentElement : mutation.target;
        if (!shouldWatchElement(target)) continue;

        if (mutation.type === "characterData") {
          logEdit("characterData", target, { newText: mutation.target?.textContent?.slice(0, 200) });
        } else if (mutation.type === "childList") {
          logEdit("childList", target, {
            added: mutation.addedNodes?.length || 0,
            removed: mutation.removedNodes?.length || 0,
          });
        } else if (mutation.type === "attributes") {
          logEdit("attribute", target, {
            attributeName: mutation.attributeName,
            value: target.getAttribute?.(mutation.attributeName || ""),
          });
        }
      }
    });

    const root = document.documentElement || document;
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    return observer;
  }

  function install() {
    if (window.__questionDomDebugInstalled) return;
    window.__questionDomDebugInstalled = true;

    patchSetter(Element.prototype, "innerHTML", "innerHTML");
    patchSetter(Node.prototype, "textContent", "textContent", (value) => ({ newText: String(value).slice(0, 200) }));
    patchSetter(HTMLElement.prototype, "innerText", "innerText", (value) => ({ newText: String(value).slice(0, 200) }));

    patchMethod(Element.prototype, "setAttribute", "setAttribute");
    patchMethod(Node.prototype, "appendChild", "appendChild", (self) => self);
    patchMethod(Node.prototype, "replaceChild", "replaceChild", (self) => self);
    patchMethod(Node.prototype, "removeChild", "removeChild", (self) => self);

    const observer = startMutationObserver();

    window.__questionDomDebug = {
      stop() { observer.disconnect(); },
      dump() { return [...(window.__questionDomDebugEvents || [])]; },
      clear() { window.__questionDomDebugEvents = []; },
    };

    console.log(`${TAG} installed`);
  }

  install();
})();
