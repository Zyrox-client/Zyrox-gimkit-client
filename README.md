# zyrox gimkit client

A hacked client for `gimkit.com/join`.

## Files
- `example.js`: Reference/example userscript from another project.
- `zyrox-base.js`: Zyrox menu framework with multi-category General panels, Gamemode-Specific panels, search, and per-module config popups.

## Usage
1. Install a userscript manager (Tampermonkey/Violentmonkey).
2. Create a new userscript and paste `zyrox-base.js`.
3. Open `https://www.gimkit.com/join`.
4. Press `\` to show/hide the menu (or change Menu Key from the top bar).
5. The search bar in the top bar auto-focuses when the menu opens and filters utilities live.
6. Right-click a utility to open its centered config menu (with blurred background), set a keybind, or reset it with the square button.
7. Drag the bottom-right corner to resize the menu.
