// Home dashboard, game selection, launch transition and return-to-home.
// Mount once: mountShell({ launchers: { boxing: startBoxing } }).
// Neon theme: the hero-tile dashboard. Bright theme: a 4 x 3 channel grid with a preview panel.
import '../theme/index.ts'
import './shell.css'
import './channels.css'
import '../theme/bright/shell.css'
import { isBright } from '../theme/index.ts'
import { TILES, artUrl } from './catalogue.ts'
import { createRecords } from './records.ts'
import { createSfx } from './sfx.ts'
import type { Sfx } from './sfx.ts'
import type { CursorPoint, GameSession, Shell, ShellOptions, TileId, TileInfo } from './types.ts'

/** Hover time needed to pick a tile or button with the hand cursor. */
const DWELL_MS = 1200
/** Launch card animation before the game starts. Matches --shell-launch-ms in shell.css. */
const LAUNCH_MS = 900
/** Channel preview open/close (FLIP) duration. Matches --ch-flip-ms in bright/shell.css. */
const FLIP_MS = 420
/** Elements the hand cursor can dwell on. */
const DWELL_TARGET = '.shell-tile, [data-dwell]'

type View = 'home' | 'launching' | 'game'

// ---------- markup (static only; dynamic text is always set with textContent) ----------

const NEON_HOME = `
<div class="shell-bg" aria-hidden="true">
  <span class="shell-orb shell-orb--1"></span>
  <span class="shell-orb shell-orb--2"></span>
  <span class="shell-orb shell-orb--3"></span>
  <div class="shell-floor"></div>
</div>

<header class="shell-top">
  <div class="shell-brand">
    <span class="shell-logo" aria-hidden="true"></span>
    <span class="shell-brand-name">Kinetic</span>
    <span class="shell-brand-sub">motion sports</span>
  </div>
  <div class="shell-status">
    <span class="shell-pill"><span class="shell-pill-dot"></span>Webcam ready</span>
    <time class="shell-clock"></time>
  </div>
</header>

<p class="shell-greeting">Pick a sport</p>
<nav class="shell-grid" aria-label="Sports"></nav>

<footer class="shell-hints">
  <span><kbd>Hover</kbd> a tile with your hand to pick it</span>
  <span><kbd>Arrows</kbd> + <kbd>Enter</kbd></span>
  <span><kbd>Esc</kbd> back home</span>
  <span class="shell-privacy">Video never leaves this device</span>
</footer>
`

/** Original pixel cloud: 12 x 6 cells, drawn with crisp SVG rects. */
const PIXEL_CLOUD = `<svg viewBox="0 0 12 6" shape-rendering="crispEdges" aria-hidden="true">
  <path fill="#fff" d="M4 0h3v1h1v1h2v1h1v2h1v1H0V5h1V3h1V2h1V1h1z"/>
  <path fill="#cfe3f5" d="M0 5h12v1H0zM10 3h1v2h-1z"/>
</svg>`

/** Kinetic logo mark: a ring with a motion spark. Original. */
const LOGO = `<svg viewBox="0 0 48 48" aria-hidden="true">
  <circle cx="24" cy="24" r="15" fill="none" stroke="#ff5e24" stroke-width="5"/>
  <path d="M24 13v11l8 5" fill="none" stroke="#232629" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const RECORDS_ICON = `<svg viewBox="0 0 48 48" aria-hidden="true">
  <rect x="9" y="13" width="30" height="22" rx="3" fill="none" stroke="#5c6066" stroke-width="3.5"/>
  <path d="M10 15l14 11 14-11" fill="none" stroke="#5c6066" stroke-width="3.5" stroke-linejoin="round"/>
</svg>`

const BRIGHT_HOME = `
<div class="shell-bg ch-bg" aria-hidden="true">
  <span class="ch-cloud ch-cloud--1">${PIXEL_CLOUD}</span>
  <span class="ch-cloud ch-cloud--2">${PIXEL_CLOUD}</span>
  <span class="ch-cloud ch-cloud--3">${PIXEL_CLOUD}</span>
</div>

<nav class="shell-grid ch-grid" aria-label="Channels"></nav>
<span class="ch-page" aria-hidden="true">&#9654;</span>

<footer class="ch-bar">
  <svg class="ch-bar-shape" viewBox="0 0 1600 200" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="ch-bar-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset="1" stop-color="#dfe7ef"/>
      </linearGradient>
    </defs>
    <path d="M0 40 H520 C600 40 610 0 700 0 H900 C990 0 1000 40 1080 40 H1600 V200 H0 Z" fill="url(#ch-bar-fill)"/>
    <path d="M0 40 H520 C600 40 610 0 700 0 H900 C990 0 1000 40 1080 40 H1600" fill="none" stroke="#cfe3f5" stroke-width="3"/>
  </svg>
  <button type="button" class="ch-round ch-round--logo" data-dwell aria-label="Kinetic settings">${LOGO}</button>
  <div class="ch-time">
    <time class="shell-clock ch-clock"><span class="ch-clock-h"></span><span class="ch-colon">:</span><span class="ch-clock-m"></span></time>
    <span class="ch-date"></span>
  </div>
  <button type="button" class="ch-round ch-round--records" data-dwell aria-label="Records">${RECORDS_ICON}</button>
</footer>

<section class="ch-preview" role="dialog" aria-modal="true" aria-label="Channel preview" hidden>
  <div class="ch-preview-art"><img class="ch-preview-img" alt="" decoding="async" /></div>
  <div class="ch-preview-info">
    <h2 class="ch-preview-title"></h2>
    <p class="ch-preview-how"></p>
    <p class="ch-preview-best"></p>
    <div class="ch-preview-extra"></div>
  </div>
  <div class="ch-preview-actions">
    <button type="button" class="ch-btn ch-btn--back" data-dwell>Back</button>
    <button type="button" class="ch-btn ch-btn--start" data-dwell>Start</button>
  </div>
</section>
`

const SHARED = `
<div class="shell-launch" aria-live="polite">
  <div class="shell-launch-card">
    <span class="shell-launch-icon"></span>
    <h2 class="shell-launch-title"></h2>
    <img class="shell-launch-art" src="${artUrl('splash-get-ready')}" alt="Get ready" width="800" height="320" decoding="async" />
    <span class="shell-launch-bar"><span></span></span>
  </div>
</div>

<div class="shell-toast" role="alert"></div>
<button type="button" class="shell-home" aria-label="Back to home">
  <span aria-hidden="true">&#8962;</span> Home
</button>
<div class="shell-host"></div>
<div class="shell-cursor" aria-hidden="true"><span></span></div>
`

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/**
 * Animated SVG art re-rasterises every frame, which costs a lot of FPS with four big tiles.
 * Each neon tile shows a still bitmap of its art; only the focused tile plays the live SVG.
 */
function freezeArt(img: HTMLImageElement): void {
  img.dataset.live = img.src
  const snap = async (): Promise<void> => {
    try {
      await img.decode()
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (!w || !h || img.dataset.still) return
      const shown = img.getBoundingClientRect().width * (window.devicePixelRatio || 1)
      const scale = Math.min(3, Math.max(2, shown / w))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(w * scale)
      canvas.height = Math.round(h * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.92))
      if (!blob) return
      const still = URL.createObjectURL(blob)
      img.dataset.still = still
      if (img.dataset.playing !== 'true') img.src = still
    } catch {
      // Keep the live SVG if it cannot be drawn (or in a non-browser test environment).
    }
  }
  void snap()
}

/** Live art on the focused tile, still art everywhere else. */
function playArt(tile: HTMLElement, on: boolean): void {
  for (const img of tile.querySelectorAll<HTMLImageElement>('img[data-live]')) {
    const play = on && !reducedMotion()
    img.dataset.playing = String(play)
    const want = play ? img.dataset.live : (img.dataset.still ?? img.dataset.live)
    if (want && img.src !== want) img.src = want
  }
}

function bestLine(id: TileId, r: ReturnType<ReturnType<typeof createRecords>['get']>): string {
  if (id === 'leaderboard' || id === 'customise') return ''
  if (r.rounds === 0) return 'No rounds yet'
  const parts = [`${r.rounds} round${r.rounds === 1 ? '' : 's'}`]
  if (r.wins > 0) parts.push(`${r.wins} KO${r.wins === 1 ? '' : 's'}`)
  if (r.bestPunches > 0) parts.push(`best ${r.bestPunches} punches`)
  if (r.bestAccuracy > 0) parts.push(`${r.bestAccuracy}% acc`)
  return parts.join(' · ')
}

// ---------- sound toggle (bright settings) ----------

const SOUND_KEY = 'kinetic.sound'

function soundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Wraps the UI sounds so the settings toggle can mute them. */
function mutable(inner: Sfx): Sfx {
  const gate = (fn: () => void) => () => {
    if (soundOn()) fn()
  }
  return { hover: gate(() => inner.hover()), select: gate(() => inner.select()), back: gate(() => inner.back()), denied: gate(() => inner.denied()) }
}

// ---------- channel grid extras (bright) ----------

type ChannelId = TileId | 'coach' | 'settings'

interface ExtraChannel {
  id: 'coach' | 'settings'
  title: string
  howTo: string
  glyph: string
  accent: string
}

const EXTRA: readonly ExtraChannel[] = [
  {
    id: 'coach',
    title: 'Coach',
    howTo: 'Warm-ups and form tips from your motion coach.',
    glyph: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="20" r="9" fill="#2f9bff"/><path d="M16 54c0-12 7-20 16-20s16 8 16 20z" fill="#2f9bff"/><path d="M42 12l10-4-2 10" fill="none" stroke="#ff5e24" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    accent: '#8fd3fb',
  },
  {
    id: 'settings',
    title: 'Settings',
    howTo: 'Pick a look and switch sounds on or off.',
    glyph: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="11" fill="none" stroke="#5c6066" stroke-width="6"/><path d="M32 8v8M32 48v8M8 32h8M48 32h8M15 15l6 6M43 43l6 6M15 49l6-6M43 21l6-6" stroke="#5c6066" stroke-width="6" stroke-linecap="round"/></svg>`,
    accent: '#dfe7ef',
  },
]

const SLOTS = 12

// ---------- mount ----------

export function mountShell(options: ShellOptions): Shell {
  // Every theme uses the channel grid; the neon tile art is animated SVG, so it is shown as stills.
  /** Channel-grid layout (all themes). The old hero dashboard is kept behind this flag. */
  const channels = true as boolean
  const neon = !isBright()
  const root = options.root ?? document.body
  const sfx = mutable(createSfx())
  const wrap = document.createElement('div')
  wrap.className = channels ? 'shell shell--channels' : 'shell'
  wrap.innerHTML = (channels ? BRIGHT_HOME : NEON_HOME) + SHARED
  root.append(wrap)

  function q<T extends HTMLElement>(selector: string): T {
    const el = wrap.querySelector<T>(selector)
    if (!el) throw new Error(`shell: missing ${selector}`)
    return el
  }

  const grid = q('.shell-grid')
  const clock = q('.shell-clock')
  const launchEl = q('.shell-launch')
  const launchIcon = q('.shell-launch-icon')
  const launchTitle = q('.shell-launch-title')
  const toast = q('.shell-toast')
  const homeBtn = q<HTMLButtonElement>('.shell-home')
  const host = q('.shell-host')
  const cursor = q('.shell-cursor')

  // ---------- tiles ----------
  const tileEls = new Map<TileId, HTMLButtonElement>()
  const bestEls = new Map<TileId, HTMLElement>()
  const channelEls = new Map<ChannelId, HTMLButtonElement>()

  function span(cls: string, text = ''): HTMLSpanElement {
    const s = document.createElement('span')
    s.className = cls
    s.textContent = text
    return s
  }

  function artImg(src: string, cls: string, freeze: boolean): HTMLImageElement {
    const img = document.createElement('img')
    img.className = cls
    img.src = src
    img.alt = ''
    img.decoding = 'async'
    img.loading = 'eager'
    img.draggable = false
    if (freeze) freezeArt(img)
    return img
  }

  function hoverFocus(b: HTMLButtonElement): void {
    b.addEventListener('pointerenter', () => {
      if (view === 'home' && !previewOpen() && document.activeElement !== b) b.focus({ preventScroll: true })
    })
  }

  /** Neon hero tile. */
  function buildTile(info: TileInfo): HTMLButtonElement {
    const ready = options.launchers[info.id] !== undefined
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `shell-tile shell-tile--${info.id}${info.featured ? ' shell-tile--featured' : ''}`
    b.dataset.id = info.id
    b.dataset.ready = String(ready)
    b.style.setProperty('--a', info.accent)
    b.style.setProperty('--b', info.accent2)
    b.setAttribute('aria-label', `${info.title}. ${info.tagline}.${ready ? '' : ' Coming soon.'}`)

    const icon = span('shell-tile-icon')
    icon.innerHTML = info.icon // static catalogue SVG
    const body = span('shell-tile-body')
    body.append(span('shell-tile-title', info.title), span('shell-tile-tag', info.tagline))
    const how = span('shell-tile-how', info.howTo)
    const best = span('shell-tile-best')
    bestEls.set(info.id, best)
    // Art layers sit behind the text: sport art, then (locked tiles only) the coming-soon overlay, then a scrim.
    const art = ready
      ? [artImg(info.art, 'shell-tile-art', true)]
      : [artImg(info.art, 'shell-tile-art shell-tile-art--dim', true), artImg(artUrl('tile-coming-soon'), 'shell-tile-art shell-tile-art--soon', true)]
    b.append(
      ...art,
      span('shell-tile-scrim'),
      span('shell-tile-glow'),
      span('shell-tile-shine'),
      span('shell-tile-badge', ready ? 'Play' : 'Coming soon'),
      icon,
      body,
      how,
      best,
      span('shell-tile-dwell'),
    )
    b.addEventListener('click', () => void shell.launch(info.id))
    hoverFocus(b)
    b.addEventListener('blur', () => playArt(b, false))
    b.addEventListener('focus', () => {
      playArt(b, true)
      if (view === 'home') sfx.hover()
    })
    return b
  }

  /** Bright channel tile: small looping art preview and a title strip. */
  function buildChannel(id: ChannelId, title: string, ready: boolean, art: HTMLElement): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `ch-tile ch-tile--${id}`
    b.dataset.id = id
    b.dataset.ready = String(ready)
    b.dataset.dwell = ''
    b.setAttribute('aria-label', `${title}${ready ? '' : '. Coming soon'}`)
    const frame = span('ch-tile-art')
    frame.append(art)
    b.append(frame, span('ch-tile-title', title), span('shell-tile-dwell ch-tile-dwell'))
    if (!ready) b.append(span('ch-tile-soon', 'Soon'))
    b.addEventListener('click', () => openPreview(id))
    hoverFocus(b)
    b.addEventListener('focus', () => {
      if (view === 'home' && !previewOpen()) sfx.hover()
    })
    return b
  }

  if (channels) {
    for (const info of TILES) {
      const ready = options.launchers[info.id] !== undefined
      const img = artImg(info.art, 'ch-tile-img', neon)
      const b = buildChannel(info.id, info.title, ready, img)
      b.style.setProperty('--a', info.accent)
      tileEls.set(info.id, b)
      channelEls.set(info.id, b)
      grid.append(b)
    }
    for (const x of EXTRA) {
      const glyph = span('ch-tile-glyph')
      glyph.innerHTML = x.glyph // static markup
      glyph.style.setProperty('--tint', x.accent)
      const b = buildChannel(x.id, x.title, x.id === 'settings', glyph)
      b.style.setProperty('--a', x.id === 'settings' ? '#a98bff' : '#38c8ff')
      channelEls.set(x.id, b)
      grid.append(b)
    }
    for (let i = channelEls.size; i < SLOTS; i++) grid.append(span('ch-tile ch-tile--empty'))
  } else {
    for (const info of TILES) {
      const el = buildTile(info)
      tileEls.set(info.id, el)
      grid.append(el)
    }
  }

  const records = createRecords((id) => renderBest(id))
  function renderBest(id: TileId): void {
    const el = bestEls.get(id)
    if (el) el.textContent = bestLine(id, records.get(id))
  }
  for (const info of TILES) renderBest(info.id)

  // ---------- clock ----------
  function tickClock(): void {
    const now = new Date()
    if (!channels) {
      clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      return
    }
    q('.ch-clock-h').textContent = String(now.getHours()).padStart(2, '0')
    q('.ch-clock-m').textContent = String(now.getMinutes()).padStart(2, '0')
    const day = now.toLocaleDateString('en-GB', { weekday: 'short' })
    q('.ch-date').textContent = `${day} ${now.getDate()}/${now.getMonth() + 1}`
  }
  tickClock()
  const clockTimer = setInterval(tickClock, 10_000)

  // ---------- view state ----------
  let view: View = 'home'
  let current: TileId | null = null
  let session: GameSession | null = null
  let abort: AbortController | null = null
  let lastFocused: ChannelId = 'boxing'
  let toastTimer = 0

  function setView(v: View): void {
    view = v
    wrap.dataset.view = v
    if (v !== 'home') setCursorVisible(false)
  }
  setView('home')

  function showToast(text: string): void {
    toast.textContent = text
    toast.classList.add('shell-toast--on')
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => toast.classList.remove('shell-toast--on'), 2600)
  }

  function replay(el: HTMLElement, cls: string): void {
    el.classList.remove(cls)
    void el.offsetWidth
    el.classList.add(cls)
  }

  function focusTile(id: ChannelId): void {
    ;(channelEls.get(id) ?? tileEls.get(id as TileId))?.focus({ preventScroll: true })
  }

  // ---------- preview panel (bright) ----------
  let previewId: ChannelId | null = null
  let flipTimer = 0
  const preview = channels ? q('.ch-preview') : null

  function previewOpen(): boolean {
    return previewId !== null
  }

  /** FLIP: the transform that maps the panel's own box onto the tile's box. */
  function flipFrom(panel: HTMLElement, tile: HTMLElement): string {
    const a = tile.getBoundingClientRect()
    const b = panel.getBoundingClientRect()
    if (!b.width || !b.height) return 'none'
    const sx = a.width / b.width
    const sy = a.height / b.height
    return `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${sx}, ${sy})`
  }

  function fillPreview(id: ChannelId): void {
    if (!preview) return
    const img = q<HTMLImageElement>('.ch-preview-img')
    const title = q('.ch-preview-title')
    const how = q('.ch-preview-how')
    const best = q('.ch-preview-best')
    const extra = q('.ch-preview-extra')
    const start = q<HTMLButtonElement>('.ch-btn--start')
    extra.replaceChildren()
    const info = TILES.find((t) => t.id === id)
    preview.dataset.id = id
    if (info) {
      const ready = options.launchers[info.id] !== undefined
      // Neon: reuse the tile's still bitmap (animated SVGs are the costliest thing to draw).
      const still = channelEls.get(info.id)?.querySelector<HTMLImageElement>('img')?.dataset.still
      img.src = neon && still ? still : info.art
      img.hidden = false
      preview.style.setProperty('--a', info.accent)
      title.textContent = info.title
      how.textContent = info.howTo
      best.textContent = bestLine(info.id, records.get(info.id)) || info.tagline
      start.hidden = false
      start.disabled = !ready
      start.textContent = ready ? 'Start' : 'Coming soon'
      return
    }
    const x = EXTRA.find((e) => e.id === id)
    img.hidden = true
    title.textContent = x?.title ?? ''
    how.textContent = x?.howTo ?? ''
    best.textContent = ''
    start.hidden = true
    if (id === 'settings') {
      const row = (label: string, opts: readonly [string, boolean, () => void][]): HTMLElement => {
        const r = document.createElement('div')
        r.className = 'ch-setting'
        r.append(span('ch-setting-label', label))
        for (const [text, on, act] of opts) {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'ch-chip'
          btn.dataset.dwell = ''
          btn.textContent = text
          btn.setAttribute('aria-pressed', String(on))
          btn.addEventListener('click', act)
          r.append(btn)
        }
        return r
      }
      const setTheme = (t: string) => () => {
        const u = new URL(location.href)
        u.searchParams.set('theme', t)
        location.href = u.toString()
      }
      const setSound = (on: boolean) => () => {
        try {
          localStorage.setItem(SOUND_KEY, on ? 'on' : 'off')
        } catch {
          // ignore
        }
        fillPreview('settings')
        if (on) sfx.select()
      }
      extra.append(
        row('Look', [
          ['Neon', neon, setTheme('neon')],
          ['Bright', !neon, setTheme('bright')],
        ]),
        row('Sound', [
          ['On', soundOn(), setSound(true)],
          ['Off', !soundOn(), setSound(false)],
        ]),
      )
    }
  }

  function openPreview(id: ChannelId): void {
    if (!preview || view !== 'home' || previewOpen()) return
    const tile = channelEls.get(id)
    if (!tile) return
    if (id === 'coach') {
      sfx.denied()
      replay(tile, 'ch-tile--nope')
      showToast('Coach is coming soon')
      return
    }
    sfx.select()
    lastFocused = id
    previewId = id
    clearDwell()
    fillPreview(id)
    preview.hidden = false
    wrap.dataset.preview = 'open'
    clearTimeout(flipTimer)
    // FLIP: start on the tile, then animate to the panel's own box.
    preview.style.transition = 'none'
    preview.style.transform = flipFrom(preview, tile)
    preview.style.opacity = '0.4'
    void preview.offsetWidth
    preview.style.transition = ''
    preview.style.transform = 'none'
    preview.style.opacity = '1'
    const start = q<HTMLButtonElement>('.ch-btn--start')
    const first = !start.hidden && !start.disabled ? start : q<HTMLButtonElement>('.ch-btn--back')
    first.focus({ preventScroll: true })
  }

  /** Reverse FLIP back into the tile. instant skips the animation (used when a game starts). */
  function closePreview(instant = false): void {
    if (!preview || !previewOpen()) return
    const id = previewId as ChannelId
    previewId = null
    clearDwell()
    delete wrap.dataset.preview
    const tile = channelEls.get(id)
    clearTimeout(flipTimer)
    const done = (): void => {
      preview.hidden = true
      preview.style.transform = ''
      preview.style.opacity = ''
      preview.style.transition = ''
    }
    if (instant || !tile) {
      done()
      return
    }
    preview.style.transform = flipFrom(preview, tile)
    preview.style.opacity = '0'
    flipTimer = window.setTimeout(done, FLIP_MS)
    sfx.back()
    focusTile(id)
  }

  if (channels) {
    q('.ch-btn--back').addEventListener('click', () => closePreview())
    q('.ch-btn--start').addEventListener('click', () => {
      const id = previewId
      if (id && TILES.some((t) => t.id === id)) void shell.launch(id as TileId)
    })
    q('.ch-round--logo').addEventListener('click', () => openPreview('settings'))
    q('.ch-round--records').addEventListener('click', () => openPreview('leaderboard'))
  }

  // ---------- keyboard ----------
  type Dir = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
  const isDir = (k: string): k is Dir => k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown'

  /** Focusable targets for the arrow keys in the current state. */
  function navTargets(): HTMLElement[] {
    if (preview && previewOpen()) return [...preview.querySelectorAll<HTMLButtonElement>('button:not([hidden]):not([disabled])')]
    return channels ? [...channelEls.values()] : [...tileEls.values()]
  }

  /** Spatial navigation: nearest target centre in the pressed direction. */
  function move(dir: Dir): void {
    const targets = navTargets()
    const active = document.activeElement
    const start = targets.find((t) => t === active) ?? channelEls.get(lastFocused) ?? tileEls.get(lastFocused as TileId)
    if (!start || !targets.includes(start)) {
      targets[0]?.focus({ preventScroll: true })
      return
    }
    const a = start.getBoundingClientRect()
    const ax = a.left + a.width / 2
    const ay = a.top + a.height / 2
    let best: HTMLElement | null = null
    let bestScore = Infinity
    for (const el of targets) {
      if (el === start) continue
      const r = el.getBoundingClientRect()
      const dx = r.left + r.width / 2 - ax
      const dy = r.top + r.height / 2 - ay
      const along = dir === 'ArrowLeft' ? -dx : dir === 'ArrowRight' ? dx : dir === 'ArrowUp' ? -dy : dy
      const across = dir === 'ArrowLeft' || dir === 'ArrowRight' ? Math.abs(dy) : Math.abs(dx)
      if (along <= 1) continue
      const score = along + across * 2
      if (score < bestScore) {
        bestScore = score
        best = el
      }
    }
    if (best) best.focus({ preventScroll: true })
  }

  function onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Escape' && previewOpen() && view === 'home') {
      e.preventDefault()
      closePreview()
      return
    }
    if (e.key === 'Escape' && view !== 'home') {
      e.preventDefault()
      shell.goHome()
      return
    }
    if (view !== 'home') return
    if (isDir(e.key)) {
      e.preventDefault()
      move(e.key)
    }
  }
  window.addEventListener('keydown', onKey)

  grid.addEventListener('focusin', (e) => {
    const id = e.target instanceof HTMLElement ? e.target.dataset.id : undefined
    if (id && (channelEls.has(id as ChannelId) || tileEls.has(id as TileId))) lastFocused = id as ChannelId
  })

  homeBtn.addEventListener('click', () => shell.goHome())

  // ---------- hand cursor (dwell select) ----------
  let dwellEl: HTMLElement | null = null
  let dwellStart = 0
  let cursorVisible = false

  let cursorPoint: CursorPoint | null = null
  let cursorRaf = 0

  function setCursorVisible(on: boolean): void {
    if (on === cursorVisible) return
    cursorVisible = on
    cursor.classList.toggle('shell-cursor--on', on)
    if (on) cursorRaf = requestAnimationFrame(cursorLoop)
    else {
      cancelAnimationFrame(cursorRaf)
      cursorPoint = null
      clearDwell()
    }
  }

  /** Dwell keeps filling while the hand holds still, even if no new point arrives. */
  function cursorLoop(): void {
    if (!cursorVisible) return
    if (cursorPoint) updateCursor(cursorPoint)
    cursorRaf = requestAnimationFrame(cursorLoop)
  }

  function clearDwell(): void {
    if (dwellEl) dwellEl.style.setProperty('--dwell', '0')
    dwellEl = null
    cursor.style.setProperty('--dwell', '0')
  }

  function updateCursor(p: CursorPoint): void {
    const x = Math.min(Math.max(p.x, 0), 1) * window.innerWidth
    const y = Math.min(Math.max(p.y, 0), 1) * window.innerHeight
    cursor.style.transform = `translate(${x}px, ${y}px)`
    const hit = document.elementFromPoint(x, y)
    let target = hit instanceof Element ? hit.closest<HTMLElement>(DWELL_TARGET) : null
    // While the preview is open only its own buttons are live.
    if (target && preview && previewOpen() && !preview.contains(target)) target = null
    if (target instanceof HTMLButtonElement && (target.disabled || target.hidden)) target = null
    const now = performance.now()
    if (target !== dwellEl) {
      clearDwell()
      dwellEl = target
      dwellStart = now
      if (target) target.focus({ preventScroll: true })
      return
    }
    if (!target) return
    const progress = Math.min((now - dwellStart) / DWELL_MS, 1)
    target.style.setProperty('--dwell', progress.toFixed(3))
    cursor.style.setProperty('--dwell', progress.toFixed(3))
    if (progress >= 1) {
      clearDwell()
      dwellStart = now + 800 // short pause before another pick
      target.click()
    }
  }

  // ---------- launch / home ----------
  const shell: Shell = {
    get current() {
      return current
    },

    async launch(id) {
      if (view !== 'home') return
      const launcher = options.launchers[id]
      const info = TILES.find((t) => t.id === id)
      const tile = tileEls.get(id)
      if (!info || !tile) return
      if (!launcher) {
        sfx.denied()
        replay(tile, channels ? 'ch-tile--nope' : 'shell-tile--nope')
        showToast(`${info.title} is coming soon`)
        return
      }

      // Launch card grows out of the tile (or the open preview panel).
      const fromEl = preview && previewOpen() ? preview : tile
      const r = fromEl.getBoundingClientRect()
      closePreview(true)
      launchEl.style.setProperty('--from-x', `${r.left + r.width / 2 - window.innerWidth / 2}px`)
      launchEl.style.setProperty('--from-y', `${r.top + r.height / 2 - window.innerHeight / 2}px`)
      launchEl.style.setProperty('--from-s', String(Math.max(r.width / window.innerWidth, 0.2)))
      launchEl.style.setProperty('--a', info.accent)
      launchEl.style.setProperty('--b', info.accent2)
      launchIcon.innerHTML = info.icon
      launchTitle.textContent = info.title
      sfx.select()
      lastFocused = id
      current = id
      setView('launching')

      const ctl = new AbortController()
      abort = ctl
      await wait(LAUNCH_MS)
      if (ctl.signal.aborted) return

      host.replaceChildren()
      try {
        const s = await launcher({ host, signal: ctl.signal, exit: () => shell.goHome() })
        if (ctl.signal.aborted) {
          s.dispose()
          return
        }
        session = s
        setView('game')
      } catch (err) {
        console.error(`shell: ${id} failed to start`, err)
        if (ctl.signal.aborted) return
        abort = null
        current = null
        setView('home')
        focusTile(id)
        showToast(`${info.title} could not start. Check the console.`)
      }
    },

    goHome() {
      if (view === 'home') return
      abort?.abort()
      abort = null
      const s = session
      session = null
      current = null
      try {
        s?.dispose()
      } catch (err) {
        console.error('shell: dispose failed', err)
      }
      host.replaceChildren()
      sfx.back()
      setView('home')
      for (const info of TILES) renderBest(info.id)
      focusTile(lastFocused)
      options.onHome?.()
    },

    setCursor(p) {
      if (view !== 'home' || p === null) {
        setCursorVisible(false)
        return
      }
      cursorPoint = p
      setCursorVisible(true)
    },

    dispose() {
      shell.goHome()
      closePreview(true)
      window.removeEventListener('keydown', onKey)
      clearInterval(clockTimer)
      clearTimeout(flipTimer)
      cancelAnimationFrame(cursorRaf)
      clearTimeout(toastTimer)
      records.dispose()
      for (const img of wrap.querySelectorAll<HTMLImageElement>('img[data-still]')) URL.revokeObjectURL(img.dataset.still ?? '')
      wrap.remove()
    },
  }

  requestAnimationFrame(() => focusTile(lastFocused))
  return shell
}
