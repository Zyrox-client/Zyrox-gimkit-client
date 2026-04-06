# ESP: Showing Teammates/Friendly Players (Implementation Options)

This note is based on `zyrox-base.js` + `example.js` behavior.

## Current behavior summary

- `zyrox-base.js` already iterates every non-local character in `renderEspPlayers` and computes `isTeammate` via team comparison (`getCharacterTeam(character) === myTeam`).
- Colors are teammate-aware (green fallback for teammates, red for enemies), but there is no explicit toggle/filter for **who** is drawn (enemy-only / teammate-only / both).
- `example.js` solves this with two toggles (`highlightTeammates`, `highlightEnemies`) and skips render based on those booleans.

## Option 1 (Recommended): Add explicit ESP target filters

Add config flags and use them in the render loop:

- `showEnemies: true`
- `showTeammates: true` (or default false if you want old enemy-focused behavior)

Render gate:

- compute `isTeammate`
- `if (isTeammate && !showTeammates) continue;`
- `if (!isTeammate && !showEnemies) continue;`

Why this is best:

- Minimal risk and smallest code change.
- Matches proven logic from `example.js`.
- Gives players full control (teammates-only, enemies-only, both).

## Option 2: Add one mode enum instead of two booleans

Use a single config value:

- `targetMode: "enemies" | "teammates" | "all"`

Render gate:

- `enemies`: draw only non-teammates
- `teammates`: draw only teammates
- `all`: draw both

Why choose this:

- Cleaner config surface.
- Easier for UI (single dropdown/cycle button).

Tradeoff:

- Slightly less flexible than independent booleans (cannot quickly disable everything except by module off).

## Option 3: Keep "all" visible, but style teammates separately + optional quiet mode

Always draw both, but differentiate friends heavily:

- Teammates: thinner boxes, muted alpha, no offscreen tracers, name only.
- Enemies: full tracers/arrows/hitbox.

Optional config:

- `teammateStyle: "full" | "minimal" | "namesOnly"`

Why choose this:

- Great for squad awareness without clutter.
- Good for modes where teammate positioning matters.

Tradeoff:

- More style logic and testing complexity.

## Option 4: Data-source hardening (if teammates are not detected reliably)

If teammate rendering appears inconsistent, the issue is often team resolution timing/source, not draw logic.

Use layered team resolution:

1. `stores.phaser.mainCharacter.teamId`
2. serializer mirror (`window.serializer.state.characters.$items`)
3. page bridge state (`window.__zyroxEspShared.localTeamId`)

Also delay "team-dependent filtering" until team is known (ignore strict teammate/enemy filtering while team is `null`/`__NO_TEAM_ID`).

Why choose this:

- Improves reliability in early-load or transport edge cases.

Tradeoff:

- Slightly more plumbing and fallback code.

## Suggested rollout path

1. Implement Option 1 first (fast and robust).
2. If UX needs simplification, switch to Option 2.
3. If clutter complaints show up, add Option 3 style presets.
4. If users report wrong friend/enemy classification, add Option 4 hardening.

## Practical defaults to ship

- `showEnemies: true`
- `showTeammates: true`
- `offscreenStyle: "tracers"`
- teammate colors toned down (e.g., `#36d17c`) and enemy colors high-contrast (e.g., `#ff4d4d`).

This gives immediate teammate visibility with minimal behavior surprise.
