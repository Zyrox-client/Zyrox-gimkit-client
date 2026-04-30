# Zyrox Client Browser Extension (MV3)

This folder packages the root `zyrox-base.js` userscript as a Chromium Manifest V3 extension targeting Gimkit join pages.

## How extension packaging differs from userscript mode

- **Execution model**: userscripts are managed by Tampermonkey/Greasemonkey, while this version is loaded as a native browser extension content script.
- **Context bridge**: `content.js` runs in isolated extension context and injects `inject.js` into the **page context** using `chrome.runtime.getURL(...)`.
- **Why inject into page context**: `zyrox-base.js` patches `window.WebSocket`; this must happen in the page world (not isolated world) and at `document_start`.
- **Metadata handling**: userscript header metadata block (`// ==UserScript== ... // ==/UserScript==`) is stripped from `inject.js` payload.

## Files

- `manifest.json`: MV3 config with minimal scope for `https://www.gimkit.com/join*`.
- `content.js`: tiny bridge script that injects `inject.js` once.
- `inject.js`: executable payload derived from `/zyrox-base.js` without userscript metadata.
- `icons/`: placeholder folder for icons you add manually.

## Load unpacked extension (Chrome / Edge)

1. Open extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the folder: `extension/zyrox-client/`.
5. Navigate to `https://www.gimkit.com/join`.

## Update workflow when `zyrox-base.js` changes

1. Update `/zyrox-base.js` as normal.
2. Regenerate `inject.js` by removing userscript header metadata block.
3. Keep/adjust the extension-level init guard (`window.__ZYROX_EXTENSION_INJECTED__`).
4. Bump `manifest.json` version to match project release if needed.
5. Reload unpacked extension on the browser extensions page.

## Known limitations / security notes

- Extension is intentionally scoped to `https://www.gimkit.com/join*` only.
- Injected page scripts run with page privileges; review payload changes carefully before shipping.
- Web store policies may require additional review for script-injection patterns.
- No extra permissions are requested beyond what is needed for the join-page content script + web-accessible payload.
