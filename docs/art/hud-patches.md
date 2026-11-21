# HUD art patches (boxing + goalkeeper)

Suggestions only; nothing in `src/sports/*` was edited. `import.meta.env` is typed (`tsconfig.json` has `"types": ["vite/client"]`). All `<img>`s are decorative (`alt=""`), so the existing text stays the accessible label.

## Boxing: `src/sports/boxing/hud.ts`

The `TEMPLATE` string already interpolates `${DRONE_NAME}`, so `${ART}` works the same way. There is no separate KO view: the KO banner goes in `.bx-fight` (which stays visible under `ended`) and fires from `setHp`. The end screen is `.bx-end`.

```diff
@@ const DRONE_NAME = 'HEX-7'
 const DRONE_NAME = 'HEX-7'
+const ART = `${import.meta.env.BASE_URL}art/`
@@ <section class="bx-panel bx-loading" role="status">
 <section class="bx-panel bx-loading" role="status">
+  <img class="bx-loading-art" src="${ART}splash-loading.svg" alt="" decoding="async" />
   <span class="bx-spinner" aria-hidden="true"></span>
@@ <section class="bx-calib" role="status" aria-live="polite">
+<img class="bx-calib-guide" src="${ART}calibration-silhouette.svg" alt="" decoding="async" />
 <section class="bx-calib" role="status" aria-live="polite">
@@ <div class="bx-telegraph" aria-hidden="true"></div>
   <div class="bx-telegraph" aria-hidden="true"></div>
+  <img class="bx-ko" src="${ART}title-ko.svg" alt="" aria-hidden="true" decoding="async" />
@@ <p class="bx-kicker bx-end-kicker">Round over</p>
   <p class="bx-kicker bx-end-kicker">Round over</p>
+  <img class="bx-end-art" alt="" decoding="async" hidden />
   <h2 class="bx-end-title" id="bx-end-title"></h2>
@@ const endKicker = q('.bx-end-kicker')
   const endKicker = q('.bx-end-kicker')
+  const endArt = q<HTMLImageElement>('.bx-end-art')
+  const koArt = q('.bx-ko')
@@ setHp(player, drone) {
       if (drone !== droneHp) {
         const hurt = drone < droneHp
+        const knockedOut = drone <= 0 && droneHp > 0
         droneHp = drone
         setBar(droneFill, droneN, droneBar, drone)
         if (hurt) replay(droneBar, 'bx-hp--hit')
+        if (knockedOut) replay(koArt, 'bx-ko--go')
       }
@@ showRoundEnd(result: RoundResult, onAgain) {
       wrap.dataset.outcome = outcome
+      const won = outcome === 'ko-win' || (outcome === 'time' && result.droneHp < result.playerHp)
+      const lost = outcome === 'ko-loss' || (outcome === 'time' && result.droneHp > result.playerHp)
+      endArt.hidden = !won && !lost // a draw keeps the text title only
+      if (won || lost) endArt.src = `${ART}${won ? 'title-win' : 'title-lose'}.svg`
```
`koArt` is typed `HTMLElement`, which is all `replay()` needs. The `droneHp > 0` guard means it fires once per KO, and never on the first `setHp` (where `droneHp` is `-1`).

## Boxing: `src/sports/boxing/hud.css`

Anchors: append the first block after the `.bx-loading-text { ... }` rule, and the rest after `.bx-end-line { ... }`. Add `.bx-ko--go` to the reduced-motion list at the end of the file (`@media (prefers-reduced-motion: reduce) { .bx-flash--go, ... }`).

```diff
+.bx-loading-art {
+  display: block;
+  width: min(320px, 70vw);
+  margin: 0 auto 12px;
+}
+
+/* Shown over the full-viewport mirrored #webcam (src/style.css) during calibration. */
+.bx-calib-guide {
+  display: none;
+  position: absolute;
+  inset: 0;
+  width: 100%;
+  height: 100%;
+  object-fit: contain;
+  opacity: 0.55;
+  pointer-events: none;
+}
+.bx-hud[data-view='calibrating'] .bx-calib-guide { display: block; }
+
+.bx-ko {
+  position: absolute;
+  top: 38%;
+  left: 50%;
+  width: min(720px, 86vw);
+  opacity: 0;
+  pointer-events: none;
+  transform: translate(-50%, -50%);
+}
+.bx-ko--go { animation: bx-ko-slam 1400ms cubic-bezier(0.2, 0.9, 0.3, 1.2) forwards; }
+@keyframes bx-ko-slam {
+  0%   { opacity: 0; transform: translate(-50%, -50%) scale(2.4); }
+  18%  { opacity: 1; transform: translate(-50%, -50%) scale(0.94); }
+  28%  { transform: translate(-50%, -50%) scale(1); }
+  80%  { opacity: 1; }
+  100% { opacity: 0; transform: translate(-50%, -50%) scale(1); }
+}
+
+.bx-end-art {
+  display: block;
+  width: min(420px, 100%);
+  margin: 6px auto 0;
+}
+.bx-end-art[hidden] { display: none; }
+.bx-end-art:not([hidden]) + .bx-end-title { font-size: clamp(40px, 7vw, 64px); }
@@ @media (prefers-reduced-motion: reduce) {
   .bx-flash--go,
   .bx-flash--miss.bx-flash--go,
-  .bx-callout--go {
+  .bx-callout--go,
+  .bx-ko--go {
     animation: bx-fade 700ms ease-out forwards;
   }
```
The `.bx-end-title` font-size shrink is optional. It stops the text title fighting the art.

## Goalkeeper: `src/sports/goalkeeper/hud.ts`

The views exist: `.gk-loading`, `.gk-calib` and `.gk-end` (outcome = `saves` vs `goals`). There is no KO in this sport. Note: in standalone `goalkeeper.html` the webcam is a small mirrored PiP in the corner (`.gk-page .gk-webcam`), so the silhouette covers the HUD/scene, not the video itself.

```diff
@@ const CALLOUT_MS = 1100
 const CALLOUT_MS = 1100
+const ART = `${import.meta.env.BASE_URL}art/`
@@ function button(label: string, ghost = false): HTMLButtonElement {
+function artImg(className: string, file: string): HTMLImageElement {
+  const img = el('img', className)
+  img.alt = ''
+  img.decoding = 'async'
+  if (file) img.src = `${ART}${file}`
+  return img
+}
+
 function button(label: string, ghost = false): HTMLButtonElement {
@@ loading.append(el('div', 'gk-spinner'), loadingText)
-  loading.append(el('div', 'gk-spinner'), loadingText)
+  loading.append(artImg('gk-loading-art', 'splash-loading.svg'), el('div', 'gk-spinner'), loadingText)
@@ calib.append(ring, calibText)
   calib.append(ring, calibText)
+  const calibGuide = artImg('gk-calib-guide', 'calibration-silhouette.svg')
@@ const endKicker = el('p', 'gk-kicker', 'Full time')
   const endKicker = el('p', 'gk-kicker', 'Full time')
+  const endArt = artImg('gk-end-art', '')
@@ end.append(endKicker, endSaves, stats, kicksTable, endActions)
-  end.append(endKicker, endSaves, stats, kicksTable, endActions)
+  end.append(endKicker, endArt, endSaves, stats, kicksTable, endActions)
@@ hud.append(backdrop, play, callouts, start, loading, error, calib, end, debug)
-  hud.append(backdrop, play, callouts, start, loading, error, calib, end, debug)
+  hud.append(backdrop, calibGuide, play, callouts, start, loading, error, calib, end, debug)
@@ showEnd(result: ShootoutResult, againCb) {
       const total = result.kicks.length
+      endArt.src = `${ART}${result.saves > result.goals ? 'title-win' : 'title-lose'}.svg`
```
`calibGuide` sits outside `.gk-calib` because that panel is a small bottom card. With 5 kicks there is never a tie. If the count can be even, add `endArt.hidden = result.saves === result.goals`.

## Goalkeeper: `src/sports/goalkeeper/hud.css`

Anchor: append after the `.gk-loading-text { ... }` rule (loading art) and after `.gk-end-saves span { ... }` (end art). The guide block can go next to `.gk-calib`.

```diff
+.gk-loading-art {
+  display: block;
+  width: min(320px, 70vw);
+  margin: 0 auto 12px;
+}
+
+.gk-calib-guide {
+  display: none;
+  position: absolute;
+  inset: 0;
+  width: 100%;
+  height: 100%;
+  object-fit: contain;
+  opacity: 0.5;
+  pointer-events: none;
+}
+.gk-hud[data-view='calibration'] .gk-calib-guide { display: block; }
+
+.gk-end-art {
+  display: block;
+  width: min(400px, 100%);
+  margin: 4px auto 0;
+}
+@media (max-height: 760px) and (min-width: 561px) {
+  .gk-end-art { width: min(300px, 100%); }
+}
```
No reduced-motion change is needed here: no new animations are added, and the SVGs handle `prefers-reduced-motion` themselves.
