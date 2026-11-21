# Kinetic Ring — Art Asset Catalogue & Integration Guide

All artwork lives in `public/art/` (served directly by Vite at `/art/<filename>`) and `docs/art/`. Every asset follows the original **Kinetic Lab / Cyber-Arcade** neon palette (`#070913` void, `#00F0FF` cyan, `#FF2A85` magenta, `#C8FF00` volt lime, `#FFB800` amber, `#A47BFF` drone violet) with zero Nintendo/Wii/Mii likeness. All SVG animations honor `prefers-reduced-motion: reduce`.

---

## Complete Asset Manifest

### 1. Dashboard Tile Art (Animated 16:10 SVGs, all < 7 KB)

| File | Public URL | Size | Dimensions | Where to Use (Component / Screen) |
| :--- | :--- | :---: | :---: | :--- |
| `public/art/tile-boxing.svg` | `/art/tile-boxing.svg` | 6.6 KB | `640×400` (16:10) | **Home Dashboard (`src/shell/catalogue.ts`, `src/shell/shell.ts`)** — background/card artwork for the featured `boxing` tile (`.shell-tile--boxing`). |
| `public/art/tile-goalkeeper.svg` | `/art/tile-goalkeeper.svg` | 5.4 KB | `640×400` (16:10) | **Home Dashboard (`src/shell/catalogue.ts`, `src/shell/shell.ts`)** — card artwork for the `goalkeeper` tile (`.shell-tile--goalkeeper`). |
| `public/art/tile-archery.svg` | `/art/tile-archery.svg` | 4.7 KB | `640×400` (16:10) | **Home Dashboard (`src/shell/catalogue.ts`, `src/shell/shell.ts`)** — card artwork for the `archery` tile (`.shell-tile--archery`). |
| `public/art/tile-leaderboard.svg` | `/art/tile-leaderboard.svg` | 5.4 KB | `640×400` (16:10) | **Home Dashboard (`src/shell/catalogue.ts`, `src/shell/shell.ts`)** & **Leaderboard header (`src/ui/LeaderboardScreen.ts`)** — Snowflake podium & live telemetry tile. |
| `public/art/tile-coming-soon.svg` | `/art/tile-coming-soon.svg` | 3.6 KB | `640×400` (16:10) | **Home Dashboard (`src/shell/shell.ts`)** — fallback artwork for locked tiles where `dataset.ready === "false"` (no launcher registered yet). |

### 2. Opponent Drone Concept Sheet

| File | Public URL | Size | Dimensions | Where to Use (Component / Screen) |
| :--- | :--- | :---: | :---: | :--- |
| `public/art/drone-concept-sheet.svg` | `/art/drone-concept-sheet.svg` | 16.5 KB | `1440×860` | **3D Art Spec & Pitch Deck** — orthographic Front/Side reference synced to `HEX-7` in `src/sports/boxing/sceneParts.ts` (`head r=0.20m`, `chest r=0.26m`) + Easy (`HEX-3`), Medium (`HEX-7`), Hard (`HEX-9`) difficulty colour swatches. |

### 3. Splashes, Calibration Overlay & Round Title Cards

| File | Public URL | Size | Dimensions | Where to Use (Component / Screen) |
| :--- | :--- | :---: | :---: | :--- |
| `public/art/splash-loading.svg` | `/art/splash-loading.svg` | 3.3 KB | `640×360` | **Loading States (`src/sports/boxing/hud.ts` `.bx-loading`, `src/sports/goalkeeper/hud.ts` loading view, `src/ui/startScreen.ts`)** — shown while MediaPipe WASM & webcam stream initialize. |
| `public/art/splash-get-ready.svg` | `/art/splash-get-ready.svg` | 3.0 KB | `800×320` | **Launch / Pre-Bout Transition (`src/shell/shell.ts` `.shell-launch`, `src/sports/boxing/hud.ts`)** — displayed during the 900 ms tile-launch or calibration-complete countdown before the bell. |
| `public/art/calibration-silhouette.svg` | `/art/calibration-silhouette.svg` | 3.7 KB | `640×480` | **Calibration Overlay (`src/ui/CalibrationOverlay.ts`, `src/ui/calibration.ts`, `src/sports/boxing/hud.ts` `.bx-calib`, `src/sports/goalkeeper/hud.ts` calibration view)** — place directly over the mirrored `<video>` element (`pointer-events: none`) to guide shoulder width & raised guard fists. |
| `public/art/title-ko.svg` | `/art/title-ko.svg` | 2.7 KB | `800×280` | **Knockout Callout / End Screen (`src/sports/boxing/hud.ts`, `src/ui/BoxingHUD.ts`, `src/ui/PostMatchScreen.ts`)** — slam-in banner when opponent HP hits `0`. |
| `public/art/title-win.svg` | `/art/title-win.svg` | 2.3 KB | `800×280` | **Victory End Screen (`src/ui/PostMatchScreen.ts`, `src/ui/postMatch.ts`, `src/sports/boxing/hud.ts`, `src/sports/goalkeeper/hud.ts`)** — header graphic above the Snowflake Cortex AI Coach summary on a win. |
| `public/art/title-lose.svg` | `/art/title-lose.svg` | 2.1 KB | `800×280` | **Defeat / Time-Up End Screen (`src/ui/PostMatchScreen.ts`, `src/ui/postMatch.ts`, `src/sports/boxing/hud.ts`)** — header graphic above retry & AI Coach tips on a loss. |

### 4. Social, Pitch & Trailer Assets

| File | Public URL | Size | Dimensions | Where to Use (Component / Screen) |
| :--- | :--- | :---: | :---: | :--- |
| `public/art/og-social.svg` | `/art/og-social.svg` | 7.3 KB | `1200×630` | **Open Graph / Devpost / MLH Thumbnail (`index.html`, `shell.html`)** — `<meta property="og:image" content="/art/og-social.svg" />` and final 1.6 s trailer end card. |
| `public/art/judges-slide-bg.svg` | `/art/judges-slide-bg.svg` | 4.3 KB | `1920×1080` | **17:30 Judges Pitch Deck (Google Slides / Keynote / PowerPoint)** — clean dark safe-zone 16:9 background for demo slides. |
| `docs/art/trailer.md` | *(repo doc)* | 3.6 KB | — | **Demo Video Production** — 7-shot, 20-second trailer storyboard recordable directly from the live browser build. |

---

## Drop-In Integration Snippets

### Dashboard Tile Background (`src/shell/shell.ts` / `shell.css`)
```html
<img
  class="shell-tile-art"
  src="/art/tile-boxing.svg"
  alt=""
  loading="eager"
  decoding="async"
/>
```
Style with `width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 14px;` — CSS idle animations run automatically inside `<img>` tags in all modern browsers.

### Calibration Silhouette Over Mirrored Webcam (`src/ui/CalibrationOverlay.ts`)
```html
<div style="position: relative; aspect-ratio: 4 / 3;">
  <video autoplay playsinline muted style="width: 100%; height: 100%; transform: scaleX(-1);"></video>
  <img
    src="/art/calibration-silhouette.svg"
    alt="Align shoulders and fists"
    style="position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;"
  />
</div>
```

### Round Result Header (`src/ui/PostMatchScreen.ts`)
```ts
const titleAsset = outcome === 'ko'
  ? '/art/title-ko.svg'
  : outcome === 'win'
    ? '/art/title-win.svg'
    : '/art/title-lose.svg'
```
