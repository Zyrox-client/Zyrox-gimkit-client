(() => {
  if (window.__ZYROX_CONTENT_BRIDGE_INSTALLED__) return;
  window.__ZYROX_CONTENT_BRIDGE_INSTALLED__ = true;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.type = 'text/javascript';
  script.async = false;

  (document.documentElement || document.head || document).appendChild(script);
  script.remove();
})();
