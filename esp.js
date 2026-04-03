// ==UserScript==
// @name        Gimkit ESP (No GUI)
// @description Minimal ESP overlay only (no menu, no extra modules)
// @namespace   https://www.github.com/TheLazySquid/GimkitCheat/
// @match       https://www.gimkit.com/join*
// @match       https://www.gimkit.com/play*
// @run-at      document-start
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  const OVERLAY_Z_INDEX = 9999;
  const TICK_MS = 1000 / 30;

  function waitForBody() {
    if (document.body) return Promise.resolve();
    return new Promise((resolve) => window.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }

  async function exposeStores() {
    await waitForBody();

    const moduleScript = document.querySelector("script[src][type='module']");
    if (!moduleScript) throw new Error('Failed to find game module script');

    const response = await fetch(moduleScript.src);
    const text = await response.text();
    const gameScriptUrl = text.match(/FixSpinePlugin-[^.]+\.js/)?.[0];
    if (!gameScriptUrl) throw new Error('Failed to find game script URL');

    const gameScript = await import(`/assets/${gameScriptUrl}`);
    const stores = Object.values(gameScript).find((v) => v && v.assignment);
    if (!stores) throw new Error('Failed to resolve stores export');

    window.stores = stores;
    return stores;
  }

  function makeCanvas() {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = String(OVERLAY_Z_INDEX);

    const syncSize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    syncSize();
    window.addEventListener('resize', syncSize);
    document.body.appendChild(canvas);

    return canvas;
  }

  function getCharacters(stores) {
    const manager = stores?.phaser?.scene?.characterManager;
    const map = manager?.characters;

    if (!map) return [];
    if (typeof map.values === 'function') return Array.from(map.values());
    if (Array.isArray(map)) return map;
    return Object.values(map);
  }

  function getMainCharacter(stores) {
    const mainId = stores?.phaser?.mainCharacter?.id;
    const manager = stores?.phaser?.scene?.characterManager;
    const map = manager?.characters;

    if (!map) return null;
    if (mainId != null && typeof map.get === 'function') return map.get(mainId) || null;

    const chars = getCharacters(stores);
    return chars.find((c) => c?.id === mainId || c?.characterId === mainId) || null;
  }

  function getCharTeam(char) {
    return char?.teamId ?? char?.team?.id ?? char?.state?.teamId ?? char?.data?.teamId ?? null;
  }

  function getCharName(char) {
    return char?.name ?? char?.displayName ?? char?.state?.name ?? 'Player';
  }

  function getPos(char) {
    const x = char?.x ?? char?.position?.x ?? char?.body?.x;
    const y = char?.y ?? char?.position?.y ?? char?.body?.y;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    return { x, y };
  }

  function drawEsp(ctx, canvas, stores) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const camera = stores?.phaser?.scene?.cameras?.cameras?.[0];
    if (!camera) return;

    const me = getMainCharacter(stores);
    if (!me) return;

    const myTeam = getCharTeam(me);
    const camX = camera.midPoint?.x;
    const camY = camera.midPoint?.y;
    const zoom = camera.zoom || 1;
    if (typeof camX !== 'number' || typeof camY !== 'number') return;

    for (const char of getCharacters(stores)) {
      if (!char || char === me) continue;

      const pos = getPos(char);
      if (!pos) continue;

      const isTeammate = myTeam !== null && getCharTeam(char) === myTeam;
      const angle = Math.atan2(pos.y - camY, pos.x - camX);
      const distance = Math.hypot(pos.x - camX, pos.y - camY) * zoom;

      const arrowDist = Math.min(250, distance);
      const tipX = Math.cos(angle) * arrowDist + canvas.width / 2;
      const tipY = Math.sin(angle) * arrowDist + canvas.height / 2;
      const leftAngle = angle + (Math.PI * 3) / 4;
      const rightAngle = angle - (Math.PI * 3) / 4;

      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + Math.cos(leftAngle) * 50, tipY + Math.sin(leftAngle) * 50);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + Math.cos(rightAngle) * 50, tipY + Math.sin(rightAngle) * 50);
      ctx.lineWidth = 3;
      ctx.strokeStyle = isTeammate ? 'green' : 'red';
      ctx.stroke();

      ctx.fillStyle = 'black';
      ctx.font = '20px Verdana';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${getCharName(char)} (${Math.floor(distance)})`, tipX, tipY);
    }
  }

  async function boot() {
    const alreadyLoaded = document.querySelector('script[src*="amplitude.com"]') !== null;
    if (alreadyLoaded) {
      alert('This script must run before joining the game. Reload and try again.');
      return;
    }

    const stores = await exposeStores();
    await waitForBody();

    const canvas = makeCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D canvas context');

    setInterval(() => drawEsp(ctx, canvas, stores), TICK_MS);
    console.log('ESP active (no GUI, no extra modules).');
  }

  boot().catch((err) => {
    console.error('ESP failed to start:', err);
  });
})();
