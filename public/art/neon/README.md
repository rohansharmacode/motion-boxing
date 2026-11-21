# KINETIC — Neon Retro-Arcade Art Pack (`public/art/neon/`)

Original synthwave / retro-arcade asset pack for **KINETIC** (zero Nintendo/Wii names, logos, or characters). All assets are clean, lightweight vector SVGs served directly by Vite at `/art/neon/<filename>`.

**Core Palette:**
- Dark Navy Backdrop: `#080c1c` / `#0a0f24`
- Electric Cyan Glow: `#22e5ff`
- Hot Pink Glow: `#ff2e88`
- Neon Tube Core: `#f2f7ff`

---

## Asset Directory (16 SVGs)

### 1. Sport Tile Illustrations (`16:9`)

| File | Public URL | Dimensions | Size | Notes |
| :--- | :--- | :---: | :---: | :--- |
| `tile-boxing.svg` | `/art/neon/tile-boxing.svg` | `1280×720` (16:9) | 8.5 KB | Synthwave sunset ring, cyan & hot-pink cyber gloves colliding with hovering visor-drone silhouette |
| `tile-goalkeeper.svg` | `/art/neon/tile-goalkeeper.svg` | `1280×720` (16:9) | 5.9 KB | Neon goal frame + 9-zone laser net, diving geometric keeper gloves intercepting curving plasma shot |
| `tile-archery.svg` | `/art/neon/tile-archery.svg` | `1280×720` (16:9) | 5.2 KB | Glowing recurve energy bow, taut plasma arrow, concentric synthwave bullseye & laser wind streams |

### 2. Seamless Textures (`THREE.RepeatWrapping` Ready)

| File | Public URL | Dimensions | Tiling Mode | Size | Notes |
| :--- | :--- | :---: | :---: | :---: | :--- |
| `tex-ring-canvas.svg` | `/art/neon/tex-ring-canvas.svg` | `512×512` | Seamless 2D (`wrapS` + `wrapT`) | 2.3 KB | Dark navy woven boxing mat twill with stitched panel seams and faint cyan/pink accents |
| `tex-ring-floor-grid.svg` | `/art/neon/tex-ring-floor-grid.svg` | `512×512` | Seamless 2D (`wrapS` + `wrapT`) | 3.1 KB | Synthwave `#22e5ff` laser grid with `#ff2e88` sub-grid ticks and wrapped intersection diamonds |
| `tex-led-board.svg` | `/art/neon/tex-led-board.svg` | `1024×128` | Horizontal strip (`wrapS`) | 2.4 KB | Scrolling LED dot-matrix ribbon (`KINETIC ◆ MOTION ARENA ◆ FIGHT ◆ K.O.`) with cyan/pink rails |
| `tex-crowd-silhouettes.svg` | `/art/neon/tex-crowd-silhouettes.svg` | `1024×256` | Horizontal strip (`wrapS`, transparent sky) | 3.6 KB | 3-tier cheering arena crowd silhouettes with `#22e5ff` & `#ff2e88` glow sticks |
| `tex-skyline-strip.svg` | `/art/neon/tex-skyline-strip.svg` | `1024×256` | Horizontal strip (`wrapS`, transparent sky) | 3.8 KB | Layered retro-synthwave city skyline with glowing pixel windows and neon rooftop trims |
| `tex-metal-turnbuckle.svg` | `/art/neon/tex-metal-turnbuckle.svg` | `512×512` | Seamless 2D (`wrapS` + `wrapT`) | 3.4 KB | Brushed gunmetal + diamond knurling, hex bolts, and recessed cyan/pink neon groove strips |

### 3. HUD Icons (Transparent Background)

| File | Public URL | Dimensions | Size | Notes |
| :--- | :--- | :---: | :---: | :--- |
| `icon-guard.svg` | `/art/neon/icon-guard.svg` | `128×128` | 1.7 KB | Faceted neon shield with dual kinetic guard chevrons |
| `icon-combo.svg` | `/art/neon/icon-combo.svg` | `128×128` | 1.7 KB | Electrifying cyan-to-pink lightning surge bolt + speed chevrons |
| `icon-ko.svg` | `/art/neon/icon-ko.svg` | `128×128` | 1.7 KB | Starburst impact badge with font-independent vector `KO` glyphs |
| `icon-timer.svg` | `/art/neon/icon-timer.svg` | `128×128` | 2.1 KB | Cyber stopwatch dial with cyan sweep arc and hot-pink urgency wedge |

### 4. Brand Identity & Title-Screen Background

| File | Public URL | Dimensions | Size | Notes |
| :--- | :--- | :---: | :---: | :--- |
| `logo-kinetic.svg` | `/art/neon/logo-kinetic.svg` | `720×180` | 3.4 KB | Font-independent vector **KINETIC** chrome-cyan-pink synthwave wordmark (transparent background) |
| `icon-app-k.svg` | `/art/neon/icon-app-k.svg` | `1024×1024` | 3.0 KB | Rounded dark-navy app icon featuring interlocking cyan/pink neon **"K"** inside an octagonal ring |
| `title-screen-bg.svg` | `/art/neon/title-screen-bg.svg` | `1920×1080` | 7.3 KB | Full-HD synthwave sky, sliced retro sun, neon skyline, sweeping spotlights, perspective grid & CRT scanlines |

---

## Quick Usage Snippets

### Three.js Seamless Texture Loading
```ts
import { RepeatWrapping, SRGBColorSpace, TextureLoader } from 'three'

const loader = new TextureLoader()
const floorGrid = loader.load('/art/neon/tex-ring-floor-grid.svg')
floorGrid.colorSpace = SRGBColorSpace
floorGrid.wrapS = RepeatWrapping
floorGrid.wrapT = RepeatWrapping
floorGrid.repeat.set(8, 8)

const ledStrip = loader.load('/art/neon/tex-led-board.svg')
ledStrip.colorSpace = SRGBColorSpace
ledStrip.wrapS = RepeatWrapping
// In render loop: ledStrip.offset.x += dt * 0.12
```

### HTML / Title Screen & HUD
```html
<img src="/art/neon/logo-kinetic.svg" alt="KINETIC" />
<img src="/art/neon/tile-boxing.svg" alt="Boxing" style="aspect-ratio: 16 / 9; object-fit: cover;" />
<img src="/art/neon/icon-guard.svg" alt="Guard" width="32" height="32" />
```
