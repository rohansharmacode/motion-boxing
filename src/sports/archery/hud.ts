// Aero Bow DOM HUD. Implements ArcheryHud from ./types.ts.
// Views: start, loading, error, calibration, play, end. Plus shot popups, callouts and a debug panel.
// Mirrors view and input mode onto the host (.ar-root) as data-ar-view / data-ar-input so page CSS can
// place the webcam (big framed mirror during calibration, small preview in play, hidden in mouse mode).
import './hud.css'
import { ARM_TENSION, ARROWS_PER_ROUND } from './types.ts'
import type {
  ArcheryHud,
  ArcheryView,
  CalibrationStatus,
  CalloutTone,
  InputMode,
  RoundResult,
  ShotResult,
} from './types.ts'

type View = 'start' | 'loading' | 'error' | 'calibration' | 'play' | 'end'
type MeterState = 'idle' | 'drawing' | 'hold' | 'release'

const CALIB_COPY: Record<CalibrationStatus, { title: string; sub: string }> = {
  'no-pose': { title: 'Step into view', sub: 'Stand back until the camera sees you.' },
  'shoulders-hidden': { title: 'Show both shoulders', sub: 'Face the screen, upper body in frame.' },
  holding: { title: 'Hold still…', sub: 'Face the screen, both arms down.' },
  done: { title: 'Ready!', sub: 'Nock your first arrow.' },
}

const METER_LABEL: Record<MeterState, string> = {
  idle: 'DRAW',
  drawing: 'DRAW',
  hold: 'HOLD',
  release: 'RELEASE!',
}

/** Steadiness at or above this reads as "let go now". */
const STEADY_OK = 0.6
const MAX_TOTAL = ARROWS_PER_ROUND * 10
const RING_R = 34
const RING_C = 2 * Math.PI * RING_R
const CALLOUT_MS = 1100
const SHOT_MS = 1200
/** Wind (m/s^2) that draws a full-length gauge arrow. */
const WIND_FULL = 3

const SVG_NS = 'http://www.w3.org/2000/svg'

// Tiny stick-figure pose icons for the how-to (viewBox 0 0 64 64, stroke only).
const POSE_ICONS: readonly string[] = [
  // 1: bow arm pushed straight out to the side, other arm relaxed.
  '<circle cx="26" cy="14" r="6"/><path d="M26 20v19M18 25h16M18 25l-5 14M34 25h18M26 39l-6 17M26 39l6 17"/>' +
    '<path class="ar-ico-hi" d="M54 10c6 8 6 22 0 30"/>',
  // 2: draw hand pulled back to the chin, elbow out, string drawn.
  '<circle cx="26" cy="14" r="6"/><path d="M26 20v19M18 25h16M34 25h18M26 39l-6 17M26 39l6 17M18 25l-9-2 13-3"/>' +
    '<path class="ar-ico-hi" d="M54 10c6 8 6 22 0 30M54 10 22 20l32 20"/>',
  // 3: hold steady, then let go: the hand opens back, the arrow flies.
  '<circle cx="26" cy="14" r="6"/><path d="M26 20v19M18 25h16M34 25h18M26 39l-6 17M26 39l6 17M18 25l-9-5-5-7"/>' +
    '<path class="ar-ico-hi" d="M54 10c6 8 6 22 0 30M54 10v30M40 25h22M58 21l4 4-4 4"/>' +
    '<path class="ar-ico-dim" d="M4 22l-2 3M8 28l-3 3"/>',
]

// Calibration frame: corner brackets, shoulder guide, centre axis and an arms-down outline.
const CALIB_FRAME =
  '<g class="ar-frame-corners"><path d="M24 64V24h40M576 64V24h-40M24 416v40h40M576 416v40h-40"/></g>' +
  '<path class="ar-frame-axis" d="M300 70v380"/>' +
  '<path class="ar-frame-shoulders" d="M150 214h300"/>' +
  '<g class="ar-frame-body">' +
  '<ellipse cx="300" cy="140" rx="38" ry="46"/>' +
  '<path d="M276 184c-6 10-10 18-12 26M324 184c6 10 10 18 12 26"/>' +
  '<path d="M224 222c10-10 26-14 40-12h72c14-2 30 2 40 12"/>' +
  '<path d="M224 222c-8 30-12 80-14 140M376 222c8 30 12 80 14 140"/>' +
  '<path d="M246 236c-2 40-2 100 2 200M354 236c2 40 2 100-2 200"/>' +
  '</g>' +
  '<path class="ar-frame-scan" d="M60 80h480"/>'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, ghost = false): HTMLButtonElement {
  const b = el('button', ghost ? 'ar-btn ar-btn--ghost' : 'ar-btn', label)
  b.type = 'button'
  return b
}

function svg(viewBox: string, className: string, inner: string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg')
  s.setAttribute('viewBox', viewBox)
  s.setAttribute('class', className)
  s.setAttribute('aria-hidden', 'true')
  s.setAttribute('focusable', 'false')
  s.innerHTML = inner // static markup from this file only
  return s
}

/** Colour band for a ring score: 10 gold, 9-7 hot, 6-4 cool, 3-1 low, 0 miss. */
function tier(score: number): 'gold' | 'hot' | 'cool' | 'low' | 'miss' {
  if (score >= 10) return 'gold'
  if (score >= 7) return 'hot'
  if (score >= 4) return 'cool'
  if (score >= 1) return 'low'
  return 'miss'
}

function step2(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 50) / 50
}

export interface ArcheryHudOptions {
  /** Adds Home buttons (start, error, end, play corner) that call this. */
  onHome?: () => void
  /** Called on every HUD button press (UI click sound). */
  onButton?: () => void
  /** Also show a Home pill in the play corner. Off inside the shell, which has its own. Default true. */
  cornerHome?: boolean
}

export function createArcheryHud(root: HTMLElement, opts: ArcheryHudOptions = {}): ArcheryHud {
  const host = root.parentElement
  function homeButton(): HTMLButtonElement {
    const b = button('Home', true)
    b.addEventListener('click', () => opts.onHome?.())
    return b
  }
  const hud = el('div', 'ar-hud')
  hud.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('button')) opts.onButton?.()
  })
  hud.dataset.view = 'start'
  const backdrop = el('div', 'ar-backdrop')

  // ---------- start ----------
  const start = el('section', 'ar-panel ar-start')
  start.setAttribute('aria-labelledby', 'ar-start-title')
  const startKicker = el('p', 'ar-kicker')
  startKicker.append(el('span', 'ar-dot'), document.createTextNode('Motion sports · Archery'))
  const title = el('h1', 'ar-wordmark')
  title.id = 'ar-start-title'
  title.append(el('span', 'ar-wordmark-a', 'AERO'), ' ', el('span', 'ar-wordmark-b', 'BOW'))
  const tagline = el('p', 'ar-tagline', 'Draw. Hold. Release.')
  const steps = el('ol', 'ar-steps')
  const stepCopy = ['Push one arm out', 'Pull the other hand back to draw', 'Hold steady, then let go']
  stepCopy.forEach((copy, i) => {
    const li = el('li', 'ar-step')
    const icon = el('span', 'ar-step-icon')
    icon.append(svg('0 0 64 64', 'ar-ico', POSE_ICONS[i] ?? ''))
    li.append(el('span', 'ar-step-num', String(i + 1)), icon, el('span', 'ar-step-copy', copy))
    steps.append(li)
  })
  const startNote = el('p', 'ar-note-strong', '5 arrows. Wind on the last two.')
  const startActions = el('div', 'ar-actions')
  const startCamera = button('Play with camera')
  const startMouse = button('Play with mouse', true)
  startActions.append(startCamera, startMouse)
  if (opts.onHome) startActions.append(homeButton())
  const startHint = el('p', 'ar-note')
  startHint.append(el('kbd', 'ar-kbd', 'D'), document.createTextNode(' switches to mouse any time'))
  start.append(startKicker, title, tagline, steps, startNote, startActions, startHint)

  // ---------- loading ----------
  const loading = el('section', 'ar-panel ar-loading')
  loading.setAttribute('role', 'status')
  loading.setAttribute('aria-live', 'polite')
  const loadingText = el('p', 'ar-loading-text', 'Loading…')
  const spinner = el('div', 'ar-spinner')
  spinner.append(el('span'), el('span'), el('span'))
  loading.append(spinner, loadingText)

  // ---------- error ----------
  const error = el('section', 'ar-panel ar-error')
  error.setAttribute('role', 'alert')
  const errKicker = el('p', 'ar-kicker ar-kicker--bad', 'Camera problem')
  const errMsg = el('p', 'ar-error-msg')
  const errActions = el('div', 'ar-actions')
  const errRetry = button('Retry')
  const errMouse = button('Play with mouse', true)
  errActions.append(errRetry, errMouse)
  if (opts.onHome) errActions.append(homeButton())
  error.append(errKicker, errMsg, errActions)

  // ---------- calibration ----------
  const calibFrame = el('div', 'ar-calib-frame')
  calibFrame.append(svg('-20 0 640 480', 'ar-calib-svg', CALIB_FRAME))
  const calib = el('section', 'ar-panel ar-calib')
  calib.setAttribute('role', 'status')
  calib.setAttribute('aria-live', 'polite')
  const ring = document.createElementNS(SVG_NS, 'svg')
  ring.setAttribute('class', 'ar-ring')
  ring.setAttribute('viewBox', '0 0 84 84')
  ring.setAttribute('aria-hidden', 'true')
  const track = document.createElementNS(SVG_NS, 'circle')
  const fill = document.createElementNS(SVG_NS, 'circle')
  for (const c of [track, fill]) {
    c.setAttribute('cx', '42')
    c.setAttribute('cy', '42')
    c.setAttribute('r', String(RING_R))
  }
  track.setAttribute('class', 'ar-ring-track')
  fill.setAttribute('class', 'ar-ring-fill')
  fill.setAttribute('stroke-dasharray', String(RING_C))
  fill.setAttribute('stroke-dashoffset', String(RING_C))
  ring.append(track, fill)
  const ringWrap = el('div', 'ar-ring-wrap')
  const ringPct = el('span', 'ar-ring-pct', '0')
  ringWrap.append(ring, ringPct)
  const calibText = el('div', 'ar-calib-text')
  const calibStatus = el('p', 'ar-calib-status')
  const calibSub = el('p', 'ar-calib-sub')
  calibText.append(calibStatus, calibSub)
  calib.append(ringWrap, calibText)

  // ---------- play overlay ----------
  const play = el('div', 'ar-play')
  play.dataset.phase = 'idle'

  const left = el('div', 'ar-cluster ar-cluster--left')
  const pips = el('ol', 'ar-pips')
  pips.setAttribute('aria-label', 'Arrows')
  const leftMeta = el('div', 'ar-meta')
  const counter = el('p', 'ar-counter', 'ARROW 1/5')
  const badge = el('p', 'ar-badge', 'CAMERA')
  badge.dataset.mode = 'camera'
  leftMeta.append(counter, badge)
  left.append(pips, leftMeta)

  const right = el('div', 'ar-cluster ar-cluster--right')
  const totalBox = el('p', 'ar-total')
  totalBox.setAttribute('aria-live', 'polite')
  const totalNum = el('span', 'ar-total-num', '0')
  totalBox.append(totalNum, el('span', 'ar-total-max', ` / ${MAX_TOTAL}`))
  const wind = el('div', 'ar-wind')
  wind.setAttribute('aria-hidden', 'true')
  const windTrack = el('span', 'ar-wind-track')
  const windArrow = el('span', 'ar-wind-arrow')
  windTrack.append(windArrow)
  const windText = el('span', 'ar-wind-text', 'WIND 0.0')
  wind.append(windTrack, windText)
  right.append(totalBox, wind)

  const meter = el('div', 'ar-meter')
  meter.dataset.state = 'idle'
  const hint = el('p', 'ar-hint')
  const meterCard = el('div', 'ar-meter-card')
  const meterHead = el('div', 'ar-meter-head')
  const meterLabel = el('span', 'ar-meter-label', 'DRAW')
  const meterPct = el('span', 'ar-meter-pct', '0%')
  meterHead.append(meterLabel, meterPct)
  const tensionBar = el('div', 'ar-bar ar-bar--tension')
  tensionBar.style.setProperty('--ar-tick', String(ARM_TENSION))
  const tensionFill = el('div', 'ar-bar-fill')
  tensionBar.append(tensionFill, el('div', 'ar-bar-tick'))
  const steadyRow = el('div', 'ar-steady')
  const steadyBar = el('div', 'ar-bar ar-bar--steady')
  const steadyFill = el('div', 'ar-bar-fill')
  steadyBar.append(steadyFill)
  steadyRow.append(el('span', 'ar-steady-label', 'STEADY'), steadyBar)
  meterCard.append(meterHead, tensionBar, steadyRow)
  meter.append(hint, meterCard)

  play.append(left, right, meter)
  if (opts.onHome && opts.cornerHome !== false) {
    const corner = homeButton()
    corner.className = 'ar-home-corner'
    corner.textContent = '⌂ Home'
    corner.setAttribute('aria-label', 'Home')
    play.append(corner)
  }

  const shotLayer = el('div', 'ar-shots')
  shotLayer.setAttribute('aria-live', 'polite')
  const callouts = el('div', 'ar-callouts')
  callouts.setAttribute('aria-live', 'polite')

  // ---------- end ----------
  const end = el('section', 'ar-panel ar-end')
  end.setAttribute('aria-labelledby', 'ar-end-title')
  const endHead = el('div', 'ar-end-head')
  const endTotal = el('h2', 'ar-end-total')
  endTotal.id = 'ar-end-title'
  const chips = el('ol', 'ar-chips')
  chips.setAttribute('aria-label', 'Arrow scores')
  const stats = el('dl', 'ar-stats')
  const endActions = el('div', 'ar-actions')
  const again = button('Shoot again')
  endActions.append(again)
  if (opts.onHome) endActions.append(homeButton())
  end.append(endHead, endTotal, chips, stats, endActions)

  // ---------- debug ----------
  const debug = el('aside', 'ar-debug')
  debug.setAttribute('aria-label', 'Debug values')
  const debugList = el('dl')
  debug.append(debugList)
  let debugOpen = false

  hud.append(backdrop, calibFrame, play, shotLayer, callouts, start, loading, error, calib, end, debug)
  root.append(hud)
  if (host) {
    host.dataset.arView = 'start'
    host.dataset.arInput ??= 'camera'
  }

  // Handlers swap per show* call; listeners stay fixed so dispose is trivial.
  let onStartCamera: () => void = () => {}
  let onStartMouse: () => void = () => {}
  let onRetry: () => void = () => {}
  let onErrMouse: () => void = () => {}
  let onAgain: () => void = () => {}
  startCamera.addEventListener('click', () => onStartCamera())
  startMouse.addEventListener('click', () => onStartMouse())
  errRetry.addEventListener('click', () => onRetry())
  errMouse.addEventListener('click', () => onErrMouse())
  again.addEventListener('click', () => onAgain())

  const timers = new Set<number>()
  function later(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      timers.delete(id)
      fn()
    }, ms)
    timers.add(id)
  }

  // Tracks the view focus was last moved for. Starts null so the first
  // showStart counts as a change even though data-view starts as 'start'.
  let focusedView: View | null = null
  function setView(view: View, focus?: HTMLElement): void {
    const changed = focusedView !== view
    focusedView = view
    hud.dataset.view = view
    if (host) host.dataset.arView = view
    if (changed && focus) {
      // Focus after display flips so the button is focusable.
      requestAnimationFrame(() => focus.focus({ preventScroll: true }))
    }
  }

  // ---------- scoreboard ----------
  let lastCounter = ''
  function setCounter(arrow: number): void {
    const text = `ARROW ${Math.min(arrow + 1, ARROWS_PER_ROUND)}/${ARROWS_PER_ROUND}`
    if (text !== lastCounter) {
      lastCounter = text
      counter.textContent = text
    }
  }

  // The running total is summed here from the shots, so it is right whichever number the host passes.
  function setScoreboard(shots: readonly ShotResult[]): void {
    const byArrow = new Map<number, ShotResult>()
    for (const r of shots) byArrow.set(r.arrow, r)
    const current = shots.length < ARROWS_PER_ROUND ? shots.length : -1
    pips.replaceChildren()
    for (let i = 0; i < ARROWS_PER_ROUND; i++) {
      const pip = el('li', 'ar-pip')
      const r = byArrow.get(i)
      if (r) {
        pip.dataset.state = tier(r.score)
        pip.textContent = r.score === 0 ? 'M' : String(r.score)
        pip.setAttribute('aria-label', `Arrow ${i + 1}: ${r.score === 0 ? 'miss' : r.score}`)
      } else if (i === current) {
        pip.dataset.state = 'current'
        pip.setAttribute('aria-label', `Arrow ${i + 1}: now`)
      } else {
        pip.dataset.state = 'pending'
        pip.setAttribute('aria-label', `Arrow ${i + 1}: to come`)
      }
      pips.append(pip)
    }
    let total = 0
    for (const r of shots) total += r.score
    totalNum.textContent = String(total)
    setCounter(shots.length)
  }

  // ---------- per-frame view (cached: touch the DOM only on change) ----------
  let vPhase = ''
  let vState = ''
  let vTension = -1
  let vSteady = -2
  let vHint: string | null | undefined
  let vWind = Number.NaN

  function setLiveView(v: ArcheryView): void {
    if (v.phase !== vPhase) {
      vPhase = v.phase
      play.dataset.phase = v.phase
    }
    if (v.phase === 'aiming' || v.phase === 'nock') setCounter(v.arrow)

    const steady = v.steadiness === null ? -1 : step2(v.steadiness)
    const state: MeterState =
      v.drawPhase === 'armed' ? (steady >= STEADY_OK ? 'release' : 'hold') : v.drawPhase === 'drawing' ? 'drawing' : 'idle'
    if (state !== vState) {
      vState = state
      meter.dataset.state = state
      meterLabel.textContent = METER_LABEL[state]
    }

    const t = step2(v.tension)
    if (t !== vTension) {
      vTension = t
      tensionFill.style.transform = `scaleX(${t})`
      meterPct.textContent = `${Math.round(t * 100)}%`
      meter.classList.toggle('ar-over', t >= ARM_TENSION)
    }

    if (steady !== vSteady) {
      const wasOn = vSteady >= 0
      vSteady = steady
      if (steady >= 0) steadyFill.style.transform = `scaleX(${steady})`
      if (wasOn !== steady >= 0) steadyRow.classList.toggle('ar-on', steady >= 0)
    }

    if (v.hint !== vHint) {
      vHint = v.hint
      hint.textContent = v.hint ?? ''
      hint.classList.toggle('ar-on', !!v.hint)
    }

    const w = Math.round(v.wind * 10) / 10
    if (w !== vWind) {
      vWind = w
      const on = w !== 0
      wind.classList.toggle('ar-on', on)
      if (on) {
        wind.dataset.dir = w > 0 ? 'right' : 'left'
        windArrow.style.setProperty('--ar-k', String(Math.min(1, 0.3 + (0.7 * Math.abs(w)) / WIND_FULL)))
        windText.textContent = `WIND ${Math.abs(w).toFixed(1)}`
      }
    }
  }

  function stat(label: string, value: string, unit?: string, tone?: string): HTMLElement {
    const wrap = el('div', tone ? `ar-stat ar-stat--${tone}` : 'ar-stat')
    const dd = el('dd', undefined, value)
    if (unit) dd.append(' ', el('small', undefined, unit))
    wrap.append(el('dt', undefined, label), dd)
    return wrap
  }

  const api: ArcheryHud = {
    showStart(onCamera, onMouse) {
      onStartCamera = onCamera
      onStartMouse = onMouse
      setView('start', startCamera)
    },

    showLoading(text) {
      loadingText.textContent = text
      setView('loading')
    },

    showError(message, retry, mouse) {
      errMsg.textContent = message
      onRetry = retry
      onErrMouse = mouse
      setView('error', errRetry)
    },

    showCalibration(progress, status) {
      const p = Math.min(1, Math.max(0, progress))
      fill.setAttribute('stroke-dashoffset', String(RING_C * (1 - p)))
      const pct = String(Math.round(p * 100))
      if (ringPct.textContent !== pct) ringPct.textContent = pct
      if (calib.dataset.status !== status) {
        calib.dataset.status = status
        calibFrame.dataset.status = status
      }
      const copy = CALIB_COPY[status]
      if (calibStatus.textContent !== copy.title) calibStatus.textContent = copy.title
      if (calibSub.textContent !== copy.sub) calibSub.textContent = copy.sub
      setView('calibration')
    },

    showPlay() {
      setView('play')
      const active = document.activeElement
      if (active instanceof HTMLElement && hud.contains(active)) active.blur()
    },

    setScoreboard,

    setView: setLiveView,

    showShot(r: ShotResult) {
      const t = tier(r.score)
      const node = el('div', `ar-shot ar-shot--${t}`)
      if (r.bullseye || r.score >= 10) {
        node.append(el('span', 'ar-shot-burst'), el('span', 'ar-shot-main', 'BULLSEYE'))
      } else if (r.score === 0) {
        node.append(el('span', 'ar-shot-main', 'MISS'))
      } else {
        node.append(el('span', 'ar-shot-main', String(r.score)))
      }
      const sub = r.score === 0 && r.hit === null ? 'Landed short' : `Stability ${Math.round(r.stability)}`
      node.append(el('span', 'ar-shot-sub', r.score >= 10 ? `10 · ${sub}` : sub))
      // One popup at a time: the newest replaces any still fading.
      shotLayer.replaceChildren(node)
      later(SHOT_MS, () => node.remove())
    },

    callout(text: string, tone: CalloutTone) {
      const node = el('div', `ar-callout ar-callout--${tone}`, text)
      callouts.replaceChildren(node)
      later(CALLOUT_MS, () => node.remove())
    },

    setInputMode(mode: InputMode) {
      badge.dataset.mode = mode
      badge.textContent = mode === 'mouse' ? 'MOUSE · D' : 'CAMERA'
      if (host) host.dataset.arInput = mode
      hud.dataset.input = mode
    },

    showEnd(result: RoundResult, againCb) {
      onAgain = againCb
      shotLayer.replaceChildren()
      callouts.replaceChildren()
      const win = result.total >= 35
      endHead.replaceChildren(
        el('p', win ? 'ar-end-heading ar-end-heading--win' : 'ar-end-heading', win ? 'GREAT ROUND' : 'ROUND COMPLETE'),
      )
      end.classList.toggle('ar-end--win', win)
      endTotal.replaceChildren(
        el('span', 'ar-end-num', String(result.total)),
        el('span', 'ar-end-max', ` / ${MAX_TOTAL}`),
      )
      chips.replaceChildren()
      for (let i = 0; i < ARROWS_PER_ROUND; i++) {
        const r = result.shots.find((s) => s.arrow === i) ?? result.shots[i]
        const chip = el('li', 'ar-chip')
        chip.dataset.state = r ? tier(r.score) : 'pending'
        chip.append(el('span', 'ar-chip-n', `#${i + 1}`), el('span', 'ar-chip-v', r ? (r.score === 0 ? 'M' : String(r.score)) : '-'))
        chip.setAttribute('aria-label', `Arrow ${i + 1}: ${r ? (r.score === 0 ? 'miss' : r.score) : 'not shot'}`)
        chips.append(chip)
      }
      stats.replaceChildren(
        stat('Bullseyes', String(result.bullseyes), undefined, result.bullseyes > 0 ? 'gold' : undefined),
        stat('Avg stability', String(Math.round(result.avgStability))),
        stat('Best stability', String(Math.round(result.bestStability))),
        stat(
          'Grouping',
          result.grouping === null ? 'n/a' : String(Math.round(result.grouping * 100)),
          result.grouping === null ? undefined : 'cm',
        ),
        stat('Score', result.score.toLocaleString('en-US'), undefined, 'score'),
      )
      setScoreboard(result.shots)
      setView('end', again)
    },

    setDebug(values) {
      if (!debugOpen) return
      const rows: HTMLElement[] = []
      for (const [k, v] of Object.entries(values)) {
        rows.push(el('dt', undefined, k), el('dd', undefined, typeof v === 'number' ? fmtNum(v) : v))
      }
      debugList.replaceChildren(...rows)
    },

    toggleDebug() {
      debugOpen = !debugOpen
      debug.classList.toggle('ar-open', debugOpen)
    },

    dispose() {
      for (const id of timers) window.clearTimeout(id)
      timers.clear()
      hud.remove()
      if (host) {
        delete host.dataset.arView
        delete host.dataset.arInput
      }
    },
  }

  setScoreboard([])
  return api
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (Number.isInteger(v)) return String(v)
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)
}
