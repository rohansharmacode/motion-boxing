// Home dashboard, game selection, launch transition and return-to-home.
// Mount once: mountShell({ launchers: { boxing: startBoxing } }).
import './shell.css'
import { TILES } from './catalogue.ts'
import { createRecords } from './records.ts'
import { createSfx } from './sfx.ts'
import type { CursorPoint, GameSession, Shell, ShellOptions, TileId, TileInfo } from './types.ts'

/** Hover time needed to pick a tile with the hand cursor. */
const DWELL_MS = 1200
/** Launch card animation before the game starts. Matches --shell-launch-ms in shell.css. */
const LAUNCH_MS = 900

type View = 'home' | 'launching' | 'game'

// Static markup only. Dynamic text is always set with textContent.
const TEMPLATE = `
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

<div class="shell-launch" aria-live="polite">
  <div class="shell-launch-card">
    <span class="shell-launch-icon"></span>
    <h2 class="shell-launch-title"></h2>
    <p class="shell-launch-sub">Get ready</p>
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

function bestLine(id: TileId, r: ReturnType<ReturnType<typeof createRecords>['get']>): string {
  if (r.rounds === 0) return id === 'leaderboard' ? '' : 'No rounds yet'
  const parts = [`${r.rounds} round${r.rounds === 1 ? '' : 's'}`]
  if (r.wins > 0) parts.push(`${r.wins} KO${r.wins === 1 ? '' : 's'}`)
  if (r.bestPunches > 0) parts.push(`best ${r.bestPunches} punches`)
  if (r.bestAccuracy > 0) parts.push(`${r.bestAccuracy}% acc`)
  return parts.join(' · ')
}

export function mountShell(options: ShellOptions): Shell {
  const root = options.root ?? document.body
  const sfx = createSfx()
  const wrap = document.createElement('div')
  wrap.className = 'shell'
  wrap.innerHTML = TEMPLATE
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

  function span(cls: string, text = ''): HTMLSpanElement {
    const s = document.createElement('span')
    s.className = cls
    s.textContent = text
    return s
  }

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
    b.append(
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
    b.addEventListener('pointerenter', () => {
      if (view !== 'home') return
      if (document.activeElement !== b) {
        b.focus({ preventScroll: true })
      }
    })
    b.addEventListener('focus', () => {
      if (view === 'home') sfx.hover()
    })
    return b
  }

  for (const info of TILES) {
    const el = buildTile(info)
    tileEls.set(info.id, el)
    grid.append(el)
  }

  const records = createRecords((id) => renderBest(id))
  function renderBest(id: TileId): void {
    const el = bestEls.get(id)
    if (el) el.textContent = bestLine(id, records.get(id))
  }
  for (const info of TILES) renderBest(info.id)

  // ---------- clock ----------
  function tickClock(): void {
    clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  tickClock()
  const clockTimer = setInterval(tickClock, 10_000)

  // ---------- view state ----------
  let view: View = 'home'
  let current: TileId | null = null
  let session: GameSession | null = null
  let abort: AbortController | null = null
  let lastFocused: TileId = 'boxing'
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

  function focusTile(id: TileId): void {
    tileEls.get(id)?.focus({ preventScroll: true })
  }

  // ---------- keyboard ----------
  type Dir = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
  const isDir = (k: string): k is Dir => k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown'

  /** Spatial navigation: nearest tile centre in the pressed direction. */
  function move(dir: Dir): void {
    const start = tileEls.get(focusedId())
    if (!start) return
    const a = start.getBoundingClientRect()
    const ax = a.left + a.width / 2
    const ay = a.top + a.height / 2
    let best: HTMLButtonElement | null = null
    let bestScore = Infinity
    for (const el of tileEls.values()) {
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

  function focusedId(): TileId {
    const el = document.activeElement
    const id = el instanceof HTMLElement ? el.dataset.id : undefined
    return TILES.some((t) => t.id === id) ? (id as TileId) : lastFocused
  }

  function onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return
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
    if (id && TILES.some((t) => t.id === id)) lastFocused = id as TileId
  })

  homeBtn.addEventListener('click', () => shell.goHome())

  // ---------- hand cursor (dwell select) ----------
  let dwellTile: HTMLButtonElement | null = null
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
    if (dwellTile) dwellTile.style.setProperty('--dwell', '0')
    dwellTile = null
    cursor.style.setProperty('--dwell', '0')
  }

  function updateCursor(p: CursorPoint): void {
    const x = Math.min(Math.max(p.x, 0), 1) * window.innerWidth
    const y = Math.min(Math.max(p.y, 0), 1) * window.innerHeight
    cursor.style.transform = `translate(${x}px, ${y}px)`
    const hit = document.elementFromPoint(x, y)
    const tile = hit instanceof Element ? hit.closest<HTMLButtonElement>('.shell-tile') : null
    const now = performance.now()
    if (tile !== dwellTile) {
      clearDwell()
      dwellTile = tile
      dwellStart = now
      if (tile) tile.focus({ preventScroll: true })
      return
    }
    if (!tile) return
    const progress = Math.min((now - dwellStart) / DWELL_MS, 1)
    tile.style.setProperty('--dwell', progress.toFixed(3))
    cursor.style.setProperty('--dwell', progress.toFixed(3))
    if (progress >= 1) {
      const id = tile.dataset.id as TileId
      clearDwell()
      dwellStart = now + 800 // short pause before another pick
      void shell.launch(id)
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
        replay(tile, 'shell-tile--nope')
        showToast(`${info.title} is coming soon`)
        return
      }

      // Launch card grows out of the tile.
      const r = tile.getBoundingClientRect()
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
      window.removeEventListener('keydown', onKey)
      clearInterval(clockTimer)
      cancelAnimationFrame(cursorRaf)
      clearTimeout(toastTimer)
      records.dispose()
      wrap.remove()
    },
  }

  requestAnimationFrame(() => focusTile(lastFocused))
  return shell
}
