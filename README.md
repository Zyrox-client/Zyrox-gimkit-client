# zyrox gimkit client

Modern red/black Zyrox menu base for `gimkit.com/join`.

## Files
- `example.js`: Reference/example userscript from another project.
- `zyrox-base.js`: Zyrox menu framework with split General + Gamemode-Specific sections, plus per-module config popups.

## Usage
1. Install a userscript manager (Tampermonkey/Violentmonkey).
2. Create a new userscript and paste `zyrox-base.js`.
3. Open `https://www.gimkit.com/join`.
4. Press `\` to show/hide the menu.
5. The search bar in the top bar auto-focuses when the menu opens and filters utilities live.
6. Right-click a utility to open its config and set a keybind.
