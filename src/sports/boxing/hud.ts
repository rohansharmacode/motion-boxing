import './hud.css'
import type { CalibrationStatus, StartupErrorKind } from '../../pose/types.ts'
import type { AttackPattern, BoxingHud, CoachCard, PunchCounts, PunchKind, RoundResult } from './types.ts'

type View = 'start' | 'loading' | 'error' | 'calibrating' | 'fighting' | 'ended'

const DRONE_NAME = new URLSearchParams(location.search).get('style') === 'mii' ? 'CHAMP' : 'HEX-7'

const ERROR_COPY: Record<StartupErrorKind, { title: string; help: string }> = {
  'camera-denied': {
    title: 'Camera blocked',
    help: 'Click the camera icon in the address bar, set it to Allow, then hit Try again. Or play with the keyboard.',
  },
  'camera-not-found': {
    title: 'No camera found',
    help: 'Plug in a webcam or check that it is switched on, then hit Try again.',
  },
  'camera-in-use': {
    title: 'Camera is busy',
    help: 'Another app or tab is using it. Close video calls and other camera tabs, then hit Try again.',
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

const CALIBRATION_COPY: Record<CalibrationStatus, string> = {
  'no-pose': 'Step into frame so we can see you',
  'shoulders-hidden': 'Show both shoulders. Face the camera',
  'too-close': 'Too close! Take a big step back',
  'hands-hidden': 'Raise both fists so we can see them',
  holding: 'Nice! Hold your guard up',
  done: 'Locked in. Fight!',
}

const NAME_KEY = 'motion-sports.player-name'
const NAME_MAX = 16
const NO_CAM_CLASS = 'bx-no-cam'

/** Defence hint per attack pattern, shown during the 600 ms charge. */
const DEFENCE_COPY: Record<AttackPattern, { label: string; move: string }> = {
  straight: { label: 'Straight incoming', move: 'Slip or duck' },
  hook: { label: 'Hook incoming', move: 'Duck' },
  slam: { label: 'Slam incoming', move: 'Slip' },
}

const SOURCE_TAG: Record<CoachCard['source'], string> = {
  cortex: 'Coach AI',
  local: 'Local coach',
  demo: 'Demo',
}

function readName(): string {
  try {
    return (localStorage.getItem(NAME_KEY) ?? '').trim().slice(0, NAME_MAX)
  } catch {
    return ''
  }
}

function saveName(name: string): void {
  try {
    if (name) localStorage.setItem(NAME_KEY, name)
    else localStorage.removeItem(NAME_KEY)
  } catch {
    // Storage blocked: the name just lasts for this page.
  }
}

const COUNT_KEYS: (PunchKind | 'landed')[] = ['jab', 'cross', 'hook', 'uppercut', 'landed']

// Static markup only. Dynamic text is always set with textContent.
const TEMPLATE = `
<div class="bx-backdrop"></div>

<section class="bx-panel bx-start" aria-labelledby="bx-wordmark">
  <p class="bx-kicker"><span class="bx-live-dot"></span>Webcam boxing</p>
  <h1 class="bx-wordmark" id="bx-wordmark">Kinetic Ring</h1>
  <p class="bx-headline">Your camera is the ring. Knock the drone out of the air.</p>
  <ol class="bx-steps">
    <li><span class="bx-step-n">1</span><span>Step back until your head, shoulders and fists show.</span></li>
    <li><span class="bx-step-n">2</span><span>Hold your guard for 2 seconds to calibrate.</span></li>
    <li><span class="bx-step-n">3</span><span>Punch, block, slip. When the drone glows red, guard up or move.</span></li>
  </ol>
  <label class="bx-name">
    <span class="bx-name-label">Your name</span>
    <input class="bx-name-input" type="text" maxlength="${NAME_MAX}" autocomplete="nickname" spellcheck="false" placeholder="Optional" />
  </label>
  <button type="button" class="bx-btn" id="start-btn">Start camera</button>
  <div class="bx-kb-slot bx-kb-slot--start"></div>
  <p class="bx-privacy">Video stays on this device. Nothing is uploaded.</p>
</section>

<section class="bx-panel bx-loading" role="status">
  <span class="bx-spinner" aria-hidden="true"></span>
  <p class="bx-loading-text"></p>
</section>

<section class="bx-panel bx-error" role="alert">
  <p class="bx-kicker bx-kicker--danger">Start failed</p>
  <h2 class="bx-error-title"></h2>
  <p class="bx-error-help"></p>
  <button type="button" class="bx-btn" id="retry-btn">Try again</button>
  <div class="bx-kb-slot bx-kb-slot--error"></div>
</section>

<section class="bx-calib" role="status" aria-live="polite">
  <p class="bx-calib-title">Calibrating</p>
  <div class="bx-calib-track"><div class="bx-calib-fill"></div></div>
  <p class="bx-calib-status"></p>
</section>

<div class="bx-fight">
  <div class="bx-telegraph" aria-hidden="true"></div>

  <div class="bx-warn" role="alert">
    <p class="bx-warn-label"></p>
    <div class="bx-warn-main">
      <svg class="bx-warn-icon" viewBox="0 0 64 64" aria-hidden="true">
        <circle class="bx-ico-head" cx="32" cy="22" r="10" />
        <path class="bx-ico-slip" d="M6 22h10M6 22l5-5M6 22l5 5M58 22H48M58 22l-5-5M58 22l-5 5" />
        <path class="bx-ico-duck" d="M32 40v18M32 58l-6-6M32 58l6-6" />
      </svg>
      <span class="bx-warn-move"></span>
    </div>
    <p class="bx-warn-alt">or block</p>
    <div class="bx-warn-charge"></div>
  </div>

  <div class="bx-top">
    <div class="bx-timer" role="timer" aria-label="Time left">60</div>
    <div class="bx-hp bx-hp--drone">
      <div class="bx-hp-head"><span class="bx-hp-name">${DRONE_NAME}</span><span class="bx-hp-n bx-hp-drone-n">100</span></div>
      <div class="bx-hp-track"><div class="bx-hp-fill bx-hp-drone-fill"></div></div>
    </div>
  </div>

  <div class="bx-left">
  <div class="bx-score">
    <div class="bx-score-main" aria-live="polite" aria-atomic="true">
      <span class="bx-total">0</span>
      <span class="bx-label">Punches</span>
    </div>
    <div class="bx-subs">
      <div class="bx-sub"><span class="bx-sub-label">Jab</span><span class="bx-sub-n" data-k="jab">0</span></div>
      <div class="bx-sub"><span class="bx-sub-label">Cross</span><span class="bx-sub-n" data-k="cross">0</span></div>
      <div class="bx-sub"><span class="bx-sub-label">Hook</span><span class="bx-sub-n" data-k="hook">0</span></div>
      <div class="bx-sub"><span class="bx-sub-label">Upper</span><span class="bx-sub-n" data-k="uppercut">0</span></div>
      <div class="bx-sub bx-sub--landed"><span class="bx-sub-label">Landed</span><span class="bx-sub-n" data-k="landed">0</span></div>
    </div>
  </div>
  <div class="bx-combo" aria-live="polite"><span class="bx-combo-n">2</span><span class="bx-combo-label">hit<br />combo</span></div>
  </div>

  <div class="bx-badges">
    <div class="bx-guard"><span class="bx-dot"></span>Guard</div>
    <div class="bx-kbmode">
      <p class="bx-kbmode-title"><span class="bx-dot"></span>Keyboard</p>
      <p class="bx-kbmode-keys"><kbd>J</kbd> jab <kbd>K</kbd> cross <kbd>H</kbd> hook <kbd>U</kbd> upper</p>
      <p class="bx-kbmode-keys"><kbd>Shift</kbd> or <kbd>&uarr;</kbd> guard <kbd>&larr;</kbd><kbd>&rarr;</kbd> slip <kbd>&darr;</kbd> duck</p>
    </div>
  </div>

  <div class="bx-flash" aria-hidden="true">
    <span class="bx-flash-type"></span>
    <span class="bx-flash-meta"></span>
    <span class="bx-flash-counter">Counter</span>
  </div>

  <p class="bx-callout" role="status"></p>

  <div class="bx-hp bx-hp--player">
    <div class="bx-hp-head"><span class="bx-hp-name">You</span><span class="bx-hp-n bx-hp-player-n">100</span></div>
    <div class="bx-hp-track"><div class="bx-hp-fill bx-hp-player-fill"></div></div>
  </div>
</div>

<section class="bx-panel bx-end" aria-labelledby="bx-end-title">
  <div class="bx-end-main">
    <p class="bx-kicker bx-end-kicker">Round over</p>
    <h2 class="bx-end-title" id="bx-end-title"></h2>
    <p class="bx-end-line"></p>
    <dl class="bx-stats"></dl>
    <div class="bx-end-actions">
      <button type="button" class="bx-btn" id="again-btn">Fight again</button>
      <button type="button" class="bx-btn bx-btn--ghost" id="home-btn">Home</button>
    </div>
    <p class="bx-privacy">or press R</p>
  </div>
  <article class="bx-coach" aria-live="polite">
    <div class="bx-coach-wait">
      <span class="bx-coach-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <p>Coach is reviewing your round</p>
    </div>
    <div class="bx-coach-card">
      <div class="bx-coach-top"><span class="bx-coach-badge"></span><span class="bx-coach-src"></span></div>
      <h3 class="bx-coach-headline"></h3>
      <ol class="bx-coach-tips"><li></li><li></li><li></li></ol>
      <p class="bx-coach-drill"><span>Drill</span><span class="bx-coach-drill-text"></span></p>
    </div>
  </article>
</section>

<div class="bx-debug" hidden>
  <p class="bx-debug-title">Debug (\` to hide)</p>
  <pre class="bx-debug-body">waiting for data</pre>
</div>
`

export function createBoxingHud(root: HTMLElement): BoxingHud {
  const wrap = document.createElement('div')
  wrap.className = 'bx-hud'
  wrap.innerHTML = TEMPLATE
  root.append(wrap)

  function q<T extends HTMLElement = HTMLElement>(selector: string): T {
    const el = wrap.querySelector<T>(selector)
    if (!el) throw new Error(`hud: missing ${selector}`)
    return el
  }

  const startBtn = q<HTMLButtonElement>('#start-btn')
  const retryBtn = q<HTMLButtonElement>('#retry-btn')
  const againBtn = q<HTMLButtonElement>('#again-btn')
  const homeBtn = q<HTMLButtonElement>('#home-btn')
  const nameInput = q<HTMLInputElement>('.bx-name-input')
  nameInput.value = readName()
  // One keyboard button, moved between the start and error panels so the id stays unique.
  const kbBtn = document.createElement('button')
  kbBtn.type = 'button'
  kbBtn.id = 'kb-btn'
  kbBtn.className = 'bx-btn bx-btn--ghost'
  kbBtn.textContent = 'Play with keyboard'
  const kbSlotStart = q('.bx-kb-slot--start')
  const kbSlotError = q('.bx-kb-slot--error')

  const loadingText = q('.bx-loading-text')
  const errorTitle = q('.bx-error-title')
  const errorHelp = q('.bx-error-help')
  const calibFill = q('.bx-calib-fill')
  const calibStatus = q('.bx-calib-status')
  const calib = q('.bx-calib')
  const timerEl = q('.bx-timer')
  const droneFill = q('.bx-hp-drone-fill')
  const droneN = q('.bx-hp-drone-n')
  const droneBar = q('.bx-hp--drone')
  const playerFill = q('.bx-hp-player-fill')
  const playerN = q('.bx-hp-player-n')
  const playerBar = q('.bx-hp--player')
  const score = q('.bx-score')
  const totalEl = q('.bx-total')
  const countEls = new Map<string, HTMLElement>()
  for (const k of COUNT_KEYS) countEls.set(k, q(`.bx-sub-n[data-k="${k}"]`))
  const guardEl = q('.bx-guard')
  const kbModeEl = q('.bx-kbmode')
  const telegraphEl = q('.bx-telegraph')
  const warnEl = q('.bx-warn')
  const warnLabel = q('.bx-warn-label')
  const warnMove = q('.bx-warn-move')
  const comboEl = q('.bx-combo')
  const comboN = q('.bx-combo-n')
  const coachEl = q('.bx-coach')
  const coachBadge = q('.bx-coach-badge')
  const coachSrc = q('.bx-coach-src')
  const coachHeadline = q('.bx-coach-headline')
  const coachTips = Array.from(wrap.querySelectorAll<HTMLElement>('.bx-coach-tips li'))
  const coachDrill = q('.bx-coach-drill-text')
  const flash = q('.bx-flash')
  const flashType = q('.bx-flash-type')
  const flashMeta = q('.bx-flash-meta')
  const calloutEl = q('.bx-callout')
  const endTitle = q('.bx-end-title')
  const endLine = q('.bx-end-line')
  const endKicker = q('.bx-end-kicker')
  const stats = q('.bx-stats')
  const debugPanel = q('.bx-debug')
  const debugBody = q('.bx-debug-body')

  let onStartFn: (() => void) | null = null
  let onKbFn: (() => void) | null = null
  let onRetryFn: (() => void) | null = null
  let onAgainFn: (() => void) | null = null
  let onHomeFn: (() => void) | null = null

  // Last rendered values, so per-frame setters only touch the DOM on change.
  let calibPct = -1
  let calibState: CalibrationStatus | null = null
  let timerSec = -1
  let timerDanger = false
  let playerHp = -1
  let droneHp = -1
  const shownCounts: Record<string, number> = { total: -1 }
  let guardOn = false
  let telegraph: AttackPattern | null = null
  let combo = 0
  let kbOn = false
  let debugVisible = false
  let lastDebugAt = -Infinity

  /** Run a one-shot handler: clear it first so a double click cannot fire twice. */
  function once(btn: HTMLButtonElement, take: () => (() => void) | null): void {
    btn.addEventListener('click', () => {
      const fn = take()
      if (!fn) return
      btn.disabled = true
      fn()
    })
  }
  once(startBtn, () => {
    const fn = onStartFn
    onStartFn = onKbFn = null
    return fn
  })
  once(kbBtn, () => {
    const fn = onKbFn
    onStartFn = onKbFn = onRetryFn = null
    return fn
  })
  once(retryBtn, () => {
    const fn = onRetryFn
    onRetryFn = onKbFn = null
    return fn
  })
  once(againBtn, () => {
    const fn = onAgainFn
    onAgainFn = onHomeFn = null
    return fn
  })
  once(homeBtn, () => {
    const fn = onHomeFn
    onAgainFn = onHomeFn = null
    return fn
  })

  // Typing a name must not punch, toggle debug or move shell tiles. Escape still reaches the shell.
  nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation()
    if (e.key === 'Enter') nameInput.blur()
  })
  nameInput.addEventListener('input', () => saveName(nameInput.value.trim()))
  nameInput.addEventListener('change', () => {
    nameInput.value = nameInput.value.trim()
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

  function setBar(fill: HTMLElement, num: HTMLElement, bar: HTMLElement, hp: number): void {
    const v = Math.max(0, Math.min(100, hp))
    fill.style.transform = `scaleX(${v / 100})`
    num.textContent = String(Math.ceil(v))
    bar.classList.toggle('bx-hp--low', v <= 25)
  }

  function stat(label: string, value: string): void {
    const box = document.createElement('div')
    box.className = 'bx-stat'
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    box.append(dt, dd)
    stats.append(box)
  }

  setView('start')

  return {
    showStart(onCamera, onKeyboard) {
      onStartFn = onCamera
      onKbFn = onKeyboard
      startBtn.disabled = false
      kbBtn.disabled = false
      kbSlotStart.append(kbBtn)
      setView('start')
      startBtn.focus({ preventScroll: true })
    },

    showLoading(text) {
      loadingText.textContent = text
      setView('loading')
    },

    showError(kind, onRetry, onKeyboard) {
      const copy = ERROR_COPY[kind]
      errorTitle.textContent = copy.title
      errorHelp.textContent = copy.help
      onRetryFn = onRetry
      onKbFn = onKeyboard
      retryBtn.disabled = false
      kbBtn.disabled = false
      kbSlotError.append(kbBtn)
      setView('error')
      retryBtn.focus({ preventScroll: true })
    },

    showCalibration(progress, status) {
      setView('calibrating')
      const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100)
      if (pct !== calibPct) {
        calibPct = pct
        calibFill.style.transform = `scaleX(${pct / 100})`
      }
      if (status !== calibState) {
        calibState = status
        calibStatus.textContent = CALIBRATION_COPY[status]
        calib.dataset.status = status
      }
    },

    showFight() {
      // A new round: the next round end starts from the coach's waiting state.
      coachEl.classList.remove('bx-coach--ready')
      setView('fighting')
    },

    setHp(player, drone) {
      if (player !== playerHp) {
        const hurt = player < playerHp
        playerHp = player
        setBar(playerFill, playerN, playerBar, player)
        if (hurt) replay(playerBar, 'bx-hp--hit')
      }
      if (drone !== droneHp) {
        const hurt = drone < droneHp
        droneHp = drone
        setBar(droneFill, droneN, droneBar, drone)
        if (hurt) replay(droneBar, 'bx-hp--hit')
      }
    },

    setTimer(msLeft) {
      const sec = Math.max(0, Math.ceil(msLeft / 1000))
      if (sec === timerSec) return
      timerSec = sec
      timerEl.textContent = String(sec)
      const danger = sec <= 10
      if (danger !== timerDanger) {
        timerDanger = danger
        timerEl.classList.toggle('bx-timer--danger', danger)
      }
      if (danger && sec > 0) replay(timerEl, 'bx-timer--tick')
    },

    setCounts(counts: PunchCounts) {
      if (counts.total !== shownCounts.total) {
        const up = counts.total > shownCounts.total && shownCounts.total >= 0
        shownCounts.total = counts.total
        totalEl.textContent = String(counts.total)
        if (up) replay(score, 'bx-score--pop')
      }
      for (const k of COUNT_KEYS) {
        const v = counts[k]
        if (v === shownCounts[k]) continue
        shownCounts[k] = v
        const el = countEls.get(k)
        if (el) el.textContent = String(v)
      }
    },

    flashPunch(punch, landed, counter) {
      flashType.textContent = punch.kind
      flashMeta.textContent = `${punch.hand} · ${punch.peakVelocity.toFixed(1)} sw/s`
      flash.classList.toggle('bx-flash--miss', !landed)
      flash.classList.toggle('bx-flash--counter', counter)
      replay(flash, 'bx-flash--go')
    },

    callout(text, tone) {
      calloutEl.textContent = text
      calloutEl.dataset.tone = tone
      replay(calloutEl, 'bx-callout--go')
    },

    setGuard(on) {
      if (on === guardOn) return
      guardOn = on
      guardEl.classList.toggle('bx-guard--on', on)
    },

    setTelegraph(pattern) {
      if (pattern === telegraph) return
      telegraph = pattern
      telegraphEl.classList.toggle('bx-telegraph--on', pattern !== null)
      if (pattern) {
        const copy = DEFENCE_COPY[pattern]
        warnLabel.textContent = copy.label
        warnMove.textContent = copy.move
        warnEl.dataset.pattern = pattern
      }
      // Removing then re-adding the class restarts the pop and charge animations.
      warnEl.classList.remove('bx-warn--on')
      if (pattern) replay(warnEl, 'bx-warn--on')
    },

    setCombo(count) {
      if (count === combo) return
      const up = count > combo
      combo = count
      const on = count >= 2
      if (on) comboN.textContent = String(count)
      comboEl.classList.toggle('bx-combo--on', on)
      if (on && up) replay(comboEl, 'bx-combo--pop')
    },

    setKeyboardMode(on) {
      if (on === kbOn) return
      kbOn = on
      kbModeEl.classList.toggle('bx-kbmode--on', on)
    },

    showRoundEnd(result: RoundResult, onAgain, onHome) {
      const { outcome, counts } = result
      endKicker.textContent = outcome === 'time' ? 'Final bell' : 'Knockout'
      endTitle.textContent = outcome === 'ko-win' ? 'KO!' : outcome === 'ko-loss' ? 'Down!' : 'Time'
      wrap.dataset.outcome = outcome
      if (outcome === 'ko-win') endLine.textContent = `You dropped ${DRONE_NAME}. Clean work.`
      else if (outcome === 'ko-loss') endLine.textContent = `${DRONE_NAME} got through. Keep that guard higher.`
      else if (result.droneHp < result.playerHp) endLine.textContent = 'You win on points.'
      else if (result.droneHp > result.playerHp) endLine.textContent = `${DRONE_NAME} takes it on points.`
      else endLine.textContent = 'Dead even. Run it back.'

      stats.replaceChildren()
      stat('Punches', String(counts.total))
      stat('Landed', String(counts.landed))
      stat('Accuracy', `${Math.round(result.accuracyPct)}%`)
      stat('Best speed', result.bestSpeed.toFixed(1))
      stat('Blocks', String(result.blocks))
      stat('Dodges', String(result.dodges))
      stat('Hits taken', String(result.hitsTaken))
      stat('Best combo', String(result.maxCombo))

      onAgainFn = onAgain
      onHomeFn = onHome
      againBtn.disabled = false
      homeBtn.disabled = false
      homeBtn.hidden = onHome === null
      setView('ended')
      againBtn.focus({ preventScroll: true })
    },

    setCoachCard(card) {
      coachEl.classList.toggle('bx-coach--ready', card !== null)
      if (!card) return
      coachBadge.textContent = card.badge
      coachSrc.textContent = SOURCE_TAG[card.source]
      coachEl.dataset.source = card.source
      coachHeadline.textContent = card.headline
      card.tips.forEach((tip, i) => {
        const li = coachTips[i]
        if (li) li.textContent = tip
      })
      coachDrill.textContent = card.drill
    },

    setCameraActive(on) {
      document.body.classList.toggle(NO_CAM_CLASS, !on)
    },

    get playerName() {
      return nameInput.value.trim().slice(0, NAME_MAX)
    },

    dispose() {
      onStartFn = onKbFn = onRetryFn = onAgainFn = onHomeFn = null
      document.body.classList.remove(NO_CAM_CLASS)
      // Every listener lives on an element inside wrap, so removing it drops them all.
      wrap.remove()
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
  }
}
