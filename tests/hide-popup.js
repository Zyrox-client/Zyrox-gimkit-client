// ==UserScript==
// @name         Zyrox hide popup test
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Test userscript that hides Gimkit purchase toasts and energy/resource popups.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @match        https://www.gimkit.com/play*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[ZyroxHidePopups]";
  const TOAST_SELECTOR = ".Toastify__toast";
  const TOAST_CLOSE_SELECTOR = ".Toastify__close-button";
  const ENERGY_POPUP_SELECTOR = ".maxAll.flex.hc";
  const ENERGY_RESOURCE_IMAGE_SELECTOR = "img[src^='/assets/map/inventory/resources/']";

  const state = {
    enabled: true,
    hidePurchaseToasts: true,
    hideEnergyPopups: true,
    observer: null,
    hiddenPurchaseToasts: 0,
    hiddenEnergyPopups: 0,
  };

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function isElement(node) {
    return node instanceof Element;
  }

  function isEnergyPopup(node) {
    return isElement(node) && node.matches(ENERGY_POPUP_SELECTOR) && Boolean(node.querySelector(ENERGY_RESOURCE_IMAGE_SELECTOR));
  }

  function hidePurchaseToast(toast) {
    if (!state.enabled || !state.hidePurchaseToasts || !isElement(toast) || toast.dataset.zyroxPopupHidden === "toast") return false;

    toast.dataset.zyroxPopupHidden = "toast";
    toast.style.display = "none";
    toast.querySelector(TOAST_CLOSE_SELECTOR)?.click();
    state.hiddenPurchaseToasts += 1;
    log("Hid purchase toast", toast);
    return true;
  }

  function hideEnergyPopup(popup) {
    if (!state.enabled || !state.hideEnergyPopups || !isEnergyPopup(popup) || popup.dataset.zyroxPopupHidden === "energy") return false;

    popup.dataset.zyroxPopupHidden = "energy";
    popup.style.display = "none";
    state.hiddenEnergyPopups += 1;
    log("Hid energy/resource popup", popup);
    return true;
  }

  function scanNode(node) {
    if (!isElement(node)) return;

    if (node.matches(TOAST_SELECTOR)) hidePurchaseToast(node);
    if (isEnergyPopup(node)) hideEnergyPopup(node);

    node.querySelectorAll?.(TOAST_SELECTOR).forEach(hidePurchaseToast);
    node.querySelectorAll?.(ENERGY_POPUP_SELECTOR).forEach((candidate) => {
      if (isEnergyPopup(candidate)) hideEnergyPopup(candidate);
    });
  }

  function scanDocument() {
    scanNode(document.documentElement);
  }

  function observePopups() {
    if (state.observer) return;

    state.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) scanNode(node);
      }
    });

    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    scanDocument();
    log("Enabled. Use window.__zyroxHidePopups to inspect or change settings.");
  }

  function setEnabled(enabled) {
    state.enabled = Boolean(enabled);
    if (state.enabled) scanDocument();
    log(state.enabled ? "Popup hiding enabled" : "Popup hiding disabled");
  }

  window.__zyroxHidePopups = {
    enable() {
      setEnabled(true);
    },
    disable() {
      setEnabled(false);
    },
    rescan() {
      scanDocument();
    },
    setPurchaseToasts(enabled) {
      state.hidePurchaseToasts = Boolean(enabled);
      if (state.enabled) scanDocument();
    },
    setEnergyPopups(enabled) {
      state.hideEnergyPopups = Boolean(enabled);
      if (state.enabled) scanDocument();
    },
    status() {
      return { ...state, observer: Boolean(state.observer) };
    },
  };

  if (document.documentElement) observePopups();
  else window.addEventListener("DOMContentLoaded", observePopups, { once: true });
})();
