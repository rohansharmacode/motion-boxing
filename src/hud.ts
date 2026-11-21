import './hud.css'
import type { PunchEvent, StartupErrorKind } from './types.ts'

export interface HudCounts {
  total: number
  jab: number
  hook: number
}

export interface Hud {
  showStart(onStart: () => void): void
  showLoading(text: string): void
  showError(kind: StartupErrorKind, onRetry: () => void): void
  showPlaying(): void
  setCoach(text: string | null): void
  addPunch(punch: PunchEvent): void
  setBlocking(on: boolean): void
  resetCounts(): void
  setDebug(values: Record<string, number | string>): void
  toggleDebug(): void
  readonly counts: HudCounts
}

type View = 'start' | 'loading' | 'error' | 'playing'

const ERROR_COPY: Record<StartupErrorKind, { title: string; help: string }> = {
  'camera-denied': {
    title: 'Camera blocked',
    help: 'Click the camera icon in the address bar, set it to Allow, then hit Try again.',
  },
  'camera-not-found': {
    title: 'No camera found',
    help: 'Plug in a webcam or check that it is switched on, then hit Try again.',
  },
  'camera-in-use': {
    title: 'Camera is busy',
    help: 'Another app or tab has it. Close video calls and other camera tabs, then hit Try again.',
  },
  'camera-unsupported': {
    title: 'Browser not supported',
    help: 'Use a recent Chrome, Edge, Firefox or Safari, and open the game over https or localhost.',
  },
  'camera-other': {
    title: 'Camera would not start',
    help: 'Something went wrong opening the camera. Reconnect it or restart the browser, then hit Try again.',
  },
  'tracker-failed': {
    title: 'Tracker did not load',
    help: 'The pose tracker downloads from the internet. Check your connection, then hit Try again.',
  },
}

// Static markup only. Dynamic text is always set with textContent.
const TEMPLATE = `
<div class="hud-backdrop"></div>

<section class="hud-panel hud-start" aria-labelledby="hud-wordmark">
  <p class="hud-kicker"><span class="hud-live-dot"></span>Webcam boxing</p>
  <h1 class="hud-wordmark" id="hud-wordmark">Motion Boxing</h1>
  <p class="hud-headline">Your camera is the ring. Your fists do the talking.</p>
  <ol class="hud-steps">
    <li><span class="hud-step-n">1</span><span>Step back until your head, shoulders and fists are in frame.</span></li>
    <li><span class="hud-step-n">2</span><span>Guard up. Fists by your chin.</span></li>
    <li><span class="hud-step-n">3</span><span>Throw jabs and hooks. Both hands high to block.</span></li>
  </ol>
  <button type="button" class="hud-btn" id="start-btn">Start camera</button>
  <p class="hud-privacy">Video is processed on this device and never uploaded.</p>
</section>

<section class="hud-panel hud-loading" role="status">
  <span class="hud-spinner" aria-hidden="true"></span>
  <p class="hud-loading-text"></p>
</section>

<section class="hud-panel hud-error" role="alert">
  <p class="hud-kicker hud-kicker--danger">Start failed</p>
  <h2 class="hud-error-title"></h2>
  <p class="hud-error-help"></p>
  <button type="button" class="hud-btn" id="retry-btn">Try again</button>
</section>

<div class="hud-play">
  <div class="hud-score">
    <div class="hud-score-main" aria-live="polite" aria-atomic="true">
      <span class="hud-total">0</span>
      <span class="hud-label">Punches</span>
    </div>
    <div class="hud-subs">
      <div class="hud-sub"><span class="hud-sub-label">Jab</span><span class="hud-sub-n hud-jab">0</span></div>
      <div class="hud-sub"><span class="hud-sub-label">Hook</span><span class="hud-sub-n hud-hook">0</span></div>
    </div>
  </div>

  <div class="hud-block"><span class="hud-block-dot"></span>Block</div>

  <div class="hud-flash" aria-hidden="true">
    <span class="hud-flash-type"></span>
    <span class="hud-flash-meta"></span>
  </div>

  <p class="hud-coach"></p>
</div>

<div class="hud-debug" hidden>
  <p class="hud-debug-title">Debug (D to hide)</p>
  <pre class="hud-debug-body">waiting for data</pre>
</div>
`

export function createHud(root: HTMLElement): Hud {
  const wrap = document.createElement('div')
  wrap.className = 'hud'
  wrap.innerHTML = TEMPLATE
  root.append(wrap)

  function q<T extends HTMLElement>(selector: string): T {
    const el = wrap.querySelector<T>(selector)
    if (!el) throw new Error(`hud: missing ${selector}`)
    return el
  }

  const startBtn = q<HTMLButtonElement>('#start-btn')
  const retryBtn = q<HTMLButtonElement>('#retry-btn')
  const loadingText = q('.hud-loading-text')
  const errorTitle = q('.hud-error-title')
  const errorHelp = q('.hud-error-help')
  const score = q('.hud-score')
  const totalEl = q('.hud-total')
  const jabEl = q('.hud-jab')
  const hookEl = q('.hud-hook')
  const blockEl = q('.hud-block')
  const flash = q('.hud-flash')
  const flashType = q('.hud-flash-type')
  const flashMeta = q('.hud-flash-meta')
  const coach = q('.hud-coach')
  const debugPanel = q('.hud-debug')
  const debugBody = q('.hud-debug-body')

  const counts: HudCounts = { total: 0, jab: 0, hook: 0 }
  let onStartFn: (() => void) | null = null
  let onRetryFn: (() => void) | null = null
  let blocking = false
  let coachText: string | null = null
  let debugVisible = false
  let lastDebugAt = -Infinity

  startBtn.addEventListener('click', () => {
    const fn = onStartFn
    onStartFn = null
    startBtn.disabled = true
    fn?.()
  })

  retryBtn.addEventListener('click', () => {
    const fn = onRetryFn
    onRetryFn = null
    retryBtn.disabled = true
    fn?.()
  })

  function setView(view: View): void {
    wrap.dataset.view = view
  }

  /** Restart a CSS animation class, even mid-animation. */
  function replay(el: HTMLElement, cls: string): void {
    el.classList.remove(cls)
    void el.offsetWidth // force reflow so the animation restarts
    el.classList.add(cls)
  }

  function renderCounts(): void {
    totalEl.textContent = String(counts.total)
    jabEl.textContent = String(counts.jab)
    hookEl.textContent = String(counts.hook)
  }

  setView('start')

  return {
    showStart(onStart) {
      onStartFn = onStart
      startBtn.disabled = false
      setView('start')
    },

    showLoading(text) {
      loadingText.textContent = text
      setView('loading')
    },

    showError(kind, onRetry) {
      const copy = ERROR_COPY[kind]
      errorTitle.textContent = copy.title
      errorHelp.textContent = copy.help
      onRetryFn = onRetry
      retryBtn.disabled = false
      setView('error')
      retryBtn.focus({ preventScroll: true })
    },

    showPlaying() {
      setView('playing')
    },

    setCoach(text) {
      if (text === coachText) return
      coachText = text
      if (text === null) {
        coach.classList.remove('hud-coach--on')
      } else {
        coach.textContent = text
        coach.classList.add('hud-coach--on')
      }
    },

    addPunch(punch) {
      counts.total++
      counts[punch.type]++
      renderCounts()
      replay(score, 'hud-score--pop')

      flashType.textContent = punch.type
      flashMeta.textContent = `${punch.hand} · speed ${punch.speed.toFixed(1)}`
      replay(flash, 'hud-flash--go')
    },

    setBlocking(on) {
      if (on === blocking) return
      blocking = on
      blockEl.classList.toggle('hud-block--on', on)
    },

    resetCounts() {
      counts.total = 0
      counts.jab = 0
      counts.hook = 0
      renderCounts()
    },

    setDebug(values) {
      if (!debugVisible) return
      const now = performance.now()
      if (now - lastDebugAt < 100) return
      lastDebugAt = now
      let out = ''
      for (const key in values) {
        const v = values[key]
        out += `${key}: ${typeof v === 'number' ? v.toFixed(2) : v}\n`
      }
      debugBody.textContent = out
    },

    toggleDebug() {
      debugVisible = !debugVisible
      debugPanel.hidden = !debugVisible
      lastDebugAt = -Infinity
    },

    get counts() {
      return { ...counts }
    },
  }
}
