// ==UserScript==
// @name         Gimkit Question DOM Edit Debugger
// @namespace    https://github.com/zyrox
// @version      1.0.0
// @description  Debug helper to detect which script edits question DOM nodes.
// @author       Zyrox
// @match        https://www.gimkit.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const TAG = "[QuestionDOMDebug]";
  const watchedKeywords = ["question", "answer", "prompt", "choice", "option"];

  function shouldWatchElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const id = (el.id || "").toLowerCase();
    const cls = (el.className || "").toString().toLowerCase();
    const role = (el.getAttribute?.("role") || "").toLowerCase();
    const aria = (el.getAttribute?.("aria-label") || "").toLowerCase();
    const text = `${id} ${cls} ${role} ${aria}`;
    return watchedKeywords.some((k) => text.includes(k));
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
      if (
        line.includes("gimkit.com") ||
        line.includes("webpack") ||
        line.includes("bundle") ||
        line.includes("chunk")
      ) {
        return line.trim();
      }
    }
    return lines[0]?.trim() || "unknown";
  }

  function logEdit(kind, target, extra = {}) {
    const err = new Error();
    const source = findLikelySourceFromStack(err.stack);
    const path = getPath(target);
    const payload = {
      kind,
      path,
      source,
      time: new Date().toISOString(),
      ...extra,
    };

    console.groupCollapsed(`${TAG} ${kind} :: ${path}`);
    console.log("Details:", payload);
    console.log("Target:", target);
    console.log("Stack:", err.stack);
    console.groupEnd();

    window.__questionDomDebugEvents ||= [];
    window.__questionDomDebugEvents.push(payload);
    if (window.__questionDomDebugEvents.length > 500) {
      window.__questionDomDebugEvents.shift();
    }
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
          const details = extractValue ? extractValue(value) : { value };
          logEdit(kind, this, details);
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
        logEdit(kind, target, { argsPreview: args.map((a) => (typeof a === "string" ? a.slice(0, 120) : typeof a)) });
      }
      return original.apply(this, args);
    };
  }

  function startMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target;
        if (!shouldWatchElement(target)) continue;

        if (mutation.type === "characterData") {
          logEdit("characterData", target.parentElement || target, {
            newText: target.textContent?.slice(0, 120),
          });
        } else if (mutation.type === "childList") {
          logEdit("childList", target, {
            added: mutation.addedNodes?.length || 0,
            removed: mutation.removedNodes?.length || 0,
          });
        } else if (mutation.type === "attributes") {
          logEdit("attribute", target, {
            attributeName: mutation.attributeName,
            value: target.getAttribute(mutation.attributeName),
          });
        }
      }
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    return observer;
  }

  function install() {
    patchSetter(Element.prototype, "innerHTML", "innerHTML");
    patchSetter(Node.prototype, "textContent", "textContent", (value) => ({
      newText: String(value).slice(0, 120),
    }));
    patchSetter(HTMLElement.prototype, "innerText", "innerText", (value) => ({
      newText: String(value).slice(0, 120),
    }));

    patchMethod(Element.prototype, "setAttribute", "setAttribute");
    patchMethod(Node.prototype, "appendChild", "appendChild", (self) => self);
    patchMethod(Node.prototype, "replaceChild", "replaceChild", (self) => self);
    patchMethod(Node.prototype, "removeChild", "removeChild", (self) => self);

    const observer = startMutationObserver();

    window.__questionDomDebug = {
      stop() {
        observer.disconnect();
        console.log(`${TAG} stopped.`);
      },
      dump() {
        return [...(window.__questionDomDebugEvents || [])];
      },
      clear() {
        window.__questionDomDebugEvents = [];
      },
    };

    console.log(`${TAG} installed. Use window.__questionDomDebug.dump() to inspect captured edits.`);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
