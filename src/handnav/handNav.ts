// Hand cursor for every menu: point with a raised hand, hold still on a button until the ring fills.
// Runs on the shared pose pipeline (src/pose) and starts the camera on the home screen.
// Mouse, touch and keyboard keep working; a moving mouse hides the hand cursor for a moment.
import './handNav.css'
import './menus.css'
import { OneEuroFilter } from '../pose/oneEuro.ts'
import type { PosePipeline } from '../pose/pipeline.ts'
import type { PoseFrame } from '../pose/types.ts'
import { DwellTracker } from './dwell.ts'
import { DeadZone, pointerFromPose, rectDistance } from './pointer.ts'
import type { PointerHand } from './pointer.ts'

/** Anything a hand can pick. Mark an element data-dwell="off" to opt out. */
const TARGETS = 'button, [data-dwell], a[href], [role="button"], input[type="submit"], input[type="button"]'
/** Game states where hands are for playing, not pointing. */
const PLAY_STATES = new Set(['loading', 'calibrating', 'tutorial', 'fighting'])
const GK_PLAY_VIEWS = new Set(['loading', 'calibration', 'play'])
/** Keep the current target while the cursor is this close to it, px (stops edge flicker). */
const STICKY_PX = 28
/** A near miss within this distance still counts, px (makes every target feel bigger). */
const MAGNET_PX = 40
/** Cursor dead-zone radius, px. */
const DEAD_ZONE_PX = 7
/** No hand point for this long hides the cursor, ms. */
const LOST_MS = 350
/** A moving mouse hides the hand cursor for this long, ms. */
const MOUSE_QUIET_MS = 1500
/** Show the "raise a hand" hint after this long without a hand, ms. */
const HINT_AFTER_MS = 2500
const FILTER = { minCutoff: 0.9, beta: 4, dCutoff: 1 }

export interface HandNavOptions {
  /** Video element for the shared pose pipeline (the first caller's element is used by every sport). */
  video: HTMLVideoElement
}

export interface HandNav {
  dispose(): void
}

function visible(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"], [data-dwell="off"]')) return false
  if (el instanceof HTMLButtonElement && el.disabled) return false
  if (el instanceof HTMLInputElement && el.disabled) return false
  const r = el.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return false
  const cs = getComputedStyle(el)
  return cs.visibility !== 'hidden' && cs.pointerEvents !== 'none' && Number(cs.opacity) > 0.05
}

/** The open modal, if any: only its own buttons are live while it shows. */
function scope(): HTMLElement | null {
  const dialogs = document.querySelectorAll<HTMLElement>('[aria-modal="true"]:not([hidden]), [data-dwell-scope]:not([hidden])')
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const d = dialogs[i]
    if (d.getClientRects().length > 0 && getComputedStyle(d).visibility !== 'hidden') return d
  }
  return null
}

/** True when a menu is on screen (not mid-game). */
export function menuActive(doc: Document = document): boolean {
  if (doc.hidden) return false
  const shell = doc.querySelector<HTMLElement>('.shell')
  if (shell?.dataset.view === 'launching') return false
  if (PLAY_STATES.has(doc.body.dataset.state ?? '')) return false
  for (const gk of doc.querySelectorAll<HTMLElement>('.gk-hud[data-view]')) {
    if (GK_PLAY_VIEWS.has(gk.dataset.view ?? '')) return false
  }
  return doc.querySelector('[data-hand-nav="off"]') === null
}

export function mountHandNav(opts: HandNavOptions): HandNav {
  const params = new URLSearchParams(location.search)
  const off = params.get('hands') === '0'

  const cursor = document.createElement('div')
  cursor.className = 'hn-cursor'
  cursor.setAttribute('aria-hidden', 'true')
  cursor.innerHTML = `<svg viewBox="0 0 64 64"><circle class="hn-track" cx="32" cy="32" r="26"/><circle class="hn-fill" cx="32" cy="32" r="26" pathLength="100"/></svg><span class="hn-dot"></span>`
  const hint = document.createElement('div')
  hint.className = 'hn-hint'
  hint.setAttribute('role', 'status')
  hint.textContent = 'Raise a hand to point. Hold still to select.'
  document.body.append(cursor, hint)

  const dwell = new DwellTracker<HTMLElement>()
  const fx = new OneEuroFilter(FILTER)
  const fy = new OneEuroFilter(FILTER)
  const dead = new DeadZone(DEAD_ZONE_PX)
  let hand: PointerHand | null = null
  let point: { x: number; y: number } | null = null
  let pointAt = 0
  let lastHandAt = performance.now()
  let mouseUntil = 0
  let targetEl: HTMLElement | null = null
  let shown = false

  // ---------- camera ----------
  let pipeline: PosePipeline | null = null
  let unsub: (() => void) | null = null
  let lastFrameAt = 0
  let acquiring = false
  let nextTryAt = 0
  let backoff = 2000
  let gaveUp = off
  let disposed = false

  function onFrame(frame: PoseFrame | null): void {
    lastFrameAt = performance.now()
    if (!frame || !pipeline) return
    const aspect = pipeline.videoWidth > 0 && pipeline.videoHeight > 0 ? pipeline.videoWidth / pipeline.videoHeight : 16 / 9
    const s = pointerFromPose(frame.image, aspect, window.innerWidth / window.innerHeight, hand)
    if (!s) {
      hand = null
      return
    }
    if (s.hand !== hand) {
      // New hand: jump straight there instead of sliding across.
      fx.reset()
      fy.reset()
      dead.reset()
      hand = s.hand
    }
    const nx = fx.filter(s.x, frame.t)
    const ny = fy.filter(s.y, frame.t)
    point = dead.apply(nx * window.innerWidth, ny * window.innerHeight)
    pointAt = performance.now()
    lastHandAt = pointAt
  }

  async function acquire(): Promise<void> {
    if (acquiring || gaveUp || disposed) return
    acquiring = true
    try {
      const { startPosePipeline } = await import('../pose/pipeline.ts')
      const p = await startPosePipeline(opts.video)
      if (disposed) return
      if (p !== pipeline) {
        unsub?.()
        pipeline = p
        unsub = p.subscribe(onFrame)
      }
      lastFrameAt = performance.now()
      backoff = 2000
    } catch (err) {
      const kind = (err as { kind?: string } | null)?.kind
      if (kind === 'camera-denied' || kind === 'camera-not-found') {
        gaveUp = true
        console.info('Hand menus off:', kind)
      } else {
        console.warn('Hand menus: camera start failed, retrying', err)
      }
      nextTryAt = performance.now() + backoff
      backoff = Math.min(backoff * 2, 30_000)
    } finally {
      acquiring = false
    }
  }

  /** Keep a live pipeline while a menu shows. A sport may have stopped it on exit. */
  function watchdog(now: number): void {
    if (gaveUp || acquiring || now < nextTryAt) return
    if (pipeline && now - lastFrameAt < 1500) return
    nextTryAt = now + 1500
    void acquire()
  }

  // ---------- targets ----------
  let candidates: HTMLElement[] = []
  let candidatesAt = 0

  function inScope(el: HTMLElement, sc: HTMLElement | null): boolean {
    return (!sc || sc.contains(el)) && el !== cursor && !hint.contains(el)
  }

  /** Is el the topmost thing at its own centre (not covered by a modal or overlay)? */
  function onTop(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return hit !== null && (el === hit || el.contains(hit))
  }

  function pick(x: number, y: number, now: number): HTMLElement | null {
    const sc = scope()
    if (targetEl && targetEl.isConnected && inScope(targetEl, sc) && visible(targetEl)) {
      if (rectDistance(targetEl.getBoundingClientRect(), x, y) <= STICKY_PX) return targetEl
    }
    const hit = document.elementFromPoint(x, y)
    const direct = hit instanceof Element ? hit.closest<HTMLElement>(TARGETS) : null
    if (direct && inScope(direct, sc) && visible(direct)) return direct
    if (now - candidatesAt > 300) {
      candidatesAt = now
      candidates = [...document.querySelectorAll<HTMLElement>(TARGETS)].filter((el) => inScope(el, sc) && visible(el) && onTop(el))
    }
    let best: HTMLElement | null = null
    let bestD = MAGNET_PX
    for (const el of candidates) {
      if (!el.isConnected) continue
      const d = rectDistance(el.getBoundingClientRect(), x, y)
      if (d <= bestD) {
        bestD = d
        best = el
      }
    }
    return best
  }

  function setTarget(el: HTMLElement | null, progress: number): void {
    if (el !== targetEl) {
      if (targetEl) {
        targetEl.classList.remove('hn-target')
        targetEl.style.removeProperty('--dwell')
      }
      targetEl = el
      if (el) {
        el.classList.add('hn-target')
        el.focus({ preventScroll: true })
      }
    }
    const p = progress.toFixed(3)
    if (el) el.style.setProperty('--dwell', p)
    cursor.style.setProperty('--dwell', p)
    cursor.classList.toggle('hn-cursor--busy', el !== null)
  }

  function show(on: boolean): void {
    if (on === shown) return
    shown = on
    cursor.classList.toggle('hn-cursor--on', on)
    if (!on) {
      dwell.reset()
      setTarget(null, 0)
    }
  }

  // ---------- loop ----------
  let raf = 0
  function loop(): void {
    raf = requestAnimationFrame(loop)
    const now = performance.now()
    const active = (sim || !gaveUp) && menuActive()
    if (active) watchdog(now)
    hint.classList.toggle('hn-hint--on', active && pipeline !== null && now - lastHandAt > HINT_AFTER_MS)

    if (!active || now < mouseUntil || !point || now - pointAt > LOST_MS) {
      show(false)
      return
    }
    show(true)
    cursor.style.transform = `translate(${point.x}px, ${point.y}px)`
    const res = dwell.update(pick(point.x, point.y, now), now)
    setTarget(res.target, res.progress)
    if (res.fired) {
      candidatesAt = 0
      res.fired.classList.add('hn-picked')
      window.setTimeout(() => res.fired?.classList.remove('hn-picked'), 300)
      res.fired.click()
    }
  }

  // ?handsim: the mouse plays the hand (no camera), for testing the dwell UI on any machine.
  const sim = params.has('handsim')
  if (sim) gaveUp = true

  function onMouse(e: PointerEvent): void {
    if (sim) {
      point = { x: e.clientX, y: e.clientY }
      pointAt = lastHandAt = performance.now() + 1e9
      return
    }
    if (e.pointerType !== 'mouse' || Math.abs(e.movementX) + Math.abs(e.movementY) < 3) return
    mouseUntil = performance.now() + MOUSE_QUIET_MS
  }
  window.addEventListener('pointermove', onMouse, { passive: true })

  if (!off) {
    raf = requestAnimationFrame(loop)
    // Start the camera on the home screen so the menus work hands-only from the first second.
    nextTryAt = 0
  }

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMouse)
      unsub?.()
      setTarget(null, 0)
      cursor.remove()
      hint.remove()
    },
  }
}
