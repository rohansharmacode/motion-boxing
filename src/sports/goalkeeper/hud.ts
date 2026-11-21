// Reflex Keeper DOM HUD. Implements KeeperHud from ./types.ts.
// Views: start, loading, error, calibration, play, end. Plus callouts and a debug panel.
import './hud.css'
import type {
  CalibrationStatus,
  InputMode,
  KeeperHud,
  KeeperPart,
  KickResult,
  ShootoutResult,
} from './types.ts'
import { DIFFICULTIES } from './difficulty.ts'
import type { Difficulty } from './difficulty.ts'
import type { SaveGrade } from './grading.ts'
import type { ShotType } from './shots.ts'

type View = 'start' | 'loading' | 'error' | 'calibration' | 'play' | 'end'

const CALIB_COPY: Record<CalibrationStatus, { title: string; sub: string }> = {
  'no-pose': { title: 'Step into view', sub: 'Stand back until the camera sees you.' },
  'shoulders-hidden': { title: 'Show both shoulders', sub: 'Face the camera, upper body in frame.' },
  'too-close': { title: 'Too close', sub: 'Take a big step back so your arms fit.' },
  'hands-hidden': { title: 'Hands up', sub: 'Raise both hands so we can see them.' },
  holding: { title: 'Hold still…', sub: 'Ready stance, hands up.' },
  done: { title: 'Ready!', sub: 'Here comes the striker.' },
}

const PART_LABEL: Record<KeeperPart, string> = { left: 'L glove', right: 'R glove', torso: 'Body' }
const ROW_LABEL = ['Top', 'Mid', 'Low'] as const
const COL_LABEL = ['left', 'centre', 'right'] as const

const GRADE_WORD: Record<SaveGrade, string> = { perfect: 'PERFECT!', good: 'GOOD SAVE', fingertip: 'FINGERTIP!', miss: 'MISSED' }

const GRADE_LABEL: Record<SaveGrade, string> = { perfect: 'Perfect', good: 'Good', fingertip: 'Fingertip', miss: 'Miss' }
const SHOT_LABEL: Record<ShotType, string> = { straight: 'Straight', curl: 'Curler', dip: 'Dipper', skimmer: 'Skimmer', topCorner: 'Top corner' }

const RING_R = 34
const RING_C = 2 * Math.PI * RING_R
const CALLOUT_MS = 1100

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
  const b = el('button', ghost ? 'gk-btn gk-btn--ghost' : 'gk-btn', label)
  b.type = 'button'
  return b
}

function zoneLabel(zone: number): string {
  const row = Math.floor(zone / 3)
  const col = zone % 3
  return `${ROW_LABEL[row] ?? '?'} ${COL_LABEL[col] ?? '?'}`
}

function fmtMs(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms)}`
}

export interface KeeperHudOptions {
  /** Adds Home buttons (start, error, end, play corner) that call this. */
  onHome?: () => void
  /** Called on every HUD button press (UI click sound). */
  onButton?: () => void
  /** Also show a Home pill in the play corner. Off inside the shell, which has its own. Default true. */
  cornerHome?: boolean
}

export function createKeeperHud(root: HTMLElement, opts: KeeperHudOptions = {}): KeeperHud {
  function homeButton(): HTMLButtonElement {
    const b = button('Home', true)
    b.addEventListener('click', () => opts.onHome?.())
    return b
  }
  const hud = el('div', 'gk-hud')
  hud.addEventListener('click', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('button')) opts.onButton?.()
  })
  hud.dataset.view = 'start'
  const backdrop = el('div', 'gk-backdrop')

  // ---------- start ----------
  const start = el('section', 'gk-panel gk-start')
  start.setAttribute('aria-labelledby', 'gk-start-title')
  const startKicker = el('p', 'gk-kicker')
  startKicker.append(el('span', 'gk-dot'), document.createTextNode('Motion sports · Penalty shootout'))
  const title = el('h1', 'gk-wordmark', 'Reflex Keeper')
  title.id = 'gk-start-title'
  const howTo = el('p', 'gk-copy', 'Stand back so your shoulders and hands are in view. Reach to block 5 penalties.')
  const startActions = el('div', 'gk-actions')
  const startCamera = button('Play with camera')
  const startMouse = button('Play with mouse', true)
  startActions.append(startCamera, startMouse)
  if (opts.onHome) startActions.append(homeButton())
  const startNote = el('p', 'gk-note')
  startNote.append(
    el('span', 'gk-kbd', 'D'),
    document.createTextNode(' mouse mode  '),
    el('span', 'gk-kbd', 'R'),
    document.createTextNode(' restart  '),
    el('span', 'gk-kbd', 'P'),
    document.createTextNode(' practice  '),
    el('span', 'gk-kbd', '`'),
    document.createTextNode(' debug'),
  )
  // Difficulty picker: a radio group of three pills, shared by the start and end screens.
  const LEVEL_LABEL: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' }
  let onLevel: (level: Difficulty) => void = () => {}
  let currentLevel: Difficulty = 'normal'
  const levelPickers: HTMLElement[] = []
  function levelPicker(): HTMLElement {
    const group = el('div', 'gk-levels')
    group.setAttribute('role', 'radiogroup')
    group.setAttribute('aria-label', 'Difficulty')
    for (const level of DIFFICULTIES) {
      const b = el('button', 'gk-level', LEVEL_LABEL[level])
      b.type = 'button'
      b.dataset.level = level
      b.setAttribute('role', 'radio')
      b.addEventListener('click', () => {
        if (level === currentLevel) return
        markLevel(level)
        onLevel(level)
      })
      group.append(b)
    }
    levelPickers.push(group)
    return group
  }
  function markLevel(level: Difficulty): void {
    currentLevel = level
    levelTag.textContent = LEVEL_LABEL[level]
    levelTag.dataset.level = level
    for (const g of levelPickers) {
      for (const b of g.children) {
        if (b instanceof HTMLElement) b.setAttribute('aria-checked', String(b.dataset.level === level))
      }
    }
  }
  const practiceLabel = el('label', 'gk-practice-choice')
  const practiceBox = el('input')
  practiceBox.type = 'checkbox'
  let onPracticeChoice: (on: boolean) => void = () => {}
  practiceBox.addEventListener('change', () => onPracticeChoice(practiceBox.checked))
  practiceLabel.append(practiceBox, document.createTextNode(' Practice first (20 s, 3 slow shots)'))
  start.append(startKicker, title, howTo, levelPicker(), practiceLabel, startActions, startNote)

  // ---------- loading ----------
  const loading = el('section', 'gk-panel gk-loading')
  loading.setAttribute('role', 'status')
  loading.setAttribute('aria-live', 'polite')
  const loadingText = el('p', 'gk-loading-text', 'Loading…')
  loading.append(el('div', 'gk-spinner'), loadingText)

  // ---------- error ----------
  const error = el('section', 'gk-panel gk-error')
  error.setAttribute('role', 'alert')
  const errKicker = el('p', 'gk-kicker gk-kicker--bad', 'Camera problem')
  const errMsg = el('p', 'gk-error-msg')
  const errActions = el('div', 'gk-actions')
  const errRetry = button('Retry')
  const errMouse = button('Play with mouse', true)
  errActions.append(errRetry, errMouse)
  if (opts.onHome) errActions.append(homeButton())
  error.append(errKicker, errMsg, errActions)

  // ---------- calibration ----------
  const calib = el('section', 'gk-panel gk-calib')
  calib.setAttribute('role', 'status')
  calib.setAttribute('aria-live', 'polite')
  const svgNS = 'http://www.w3.org/2000/svg'
  const ring = document.createElementNS(svgNS, 'svg')
  ring.setAttribute('class', 'gk-ring')
  ring.setAttribute('viewBox', '0 0 84 84')
  ring.setAttribute('aria-hidden', 'true')
  const track = document.createElementNS(svgNS, 'circle')
  const fill = document.createElementNS(svgNS, 'circle')
  for (const c of [track, fill]) {
    c.setAttribute('cx', '42')
    c.setAttribute('cy', '42')
    c.setAttribute('r', String(RING_R))
  }
  track.setAttribute('class', 'gk-ring-track')
  fill.setAttribute('class', 'gk-ring-fill')
  fill.setAttribute('stroke-dasharray', String(RING_C))
  fill.setAttribute('stroke-dashoffset', String(RING_C))
  ring.append(track, fill)
  const calibText = el('div')
  const calibStatus = el('p', 'gk-calib-status')
  const calibSub = el('p', 'gk-calib-sub')
  calibText.append(calibStatus, calibSub)
  calib.append(ring, calibText)

  // ---------- play overlay ----------
  const play = el('div', 'gk-play')
  const topbar = el('div', 'gk-topbar')
  const pips = el('ol', 'gk-pips')
  pips.setAttribute('aria-label', 'Kicks')
  const counter = el('p', 'gk-counter', 'KICK 1/5')
  counter.setAttribute('aria-live', 'polite')
  // Slim corner HUD: KICK n/5 + pips, then combo, level and input mode on one small line.
  const comboTag = el('span', 'gk-combo-tag')
  const levelTag = el('span', 'gk-level-tag')
  const badge = el('span', 'gk-badge', 'CAMERA')
  badge.dataset.mode = 'camera'
  const metaRow = el('div', 'gk-meta')
  metaRow.append(comboTag, levelTag, badge)
  const kickRow = el('div', 'gk-kickrow')
  kickRow.append(counter, pips)
  topbar.append(kickRow, metaRow)
  play.append(topbar)
  if (opts.onHome && opts.cornerHome !== false) {
    const corner = homeButton()
    corner.className = 'gk-home-corner'
    corner.textContent = '⌂ Home'
    corner.setAttribute('aria-label', 'Home')
    play.append(corner)
  }
  // Practice prompt: one line at a time, bottom centre (clear of the webcam preview), with Skip.
  const practiceBar = el('div', 'gk-practice')
  practiceBar.hidden = true
  const practiceText = el('p', 'gk-practice-text')
  practiceText.setAttribute('aria-live', 'polite')
  const practiceSkip = button('Skip practice', true)
  practiceSkip.classList.add('gk-practice-skip')
  practiceSkip.append(' ', el('span', 'gk-kbd', 'S'))
  practiceBar.append(el('span', 'gk-practice-tag', 'PRACTICE'), practiceText, practiceSkip)
  play.append(practiceBar)
  let onSkip: () => void = () => {}
  practiceSkip.addEventListener('click', () => onSkip())
  const telegraph = el('div', 'gk-telegraph')
  telegraph.setAttribute('aria-hidden', 'true')
  play.append(telegraph)

  const callouts = el('div', 'gk-callouts')
  callouts.setAttribute('aria-live', 'assertive')

  // ---------- end ----------
  const end = el('section', 'gk-panel gk-end')
  end.setAttribute('aria-labelledby', 'gk-end-title')
  const endKicker = el('p', 'gk-kicker', 'Full time')
  // Header: big letter grade beside SAVES n/5.
  const endHead = el('div', 'gk-end-head')
  const endGrade = el('p', 'gk-end-grade')
  endGrade.setAttribute('aria-label', 'Grade')
  const endSaves = el('h2', 'gk-end-saves')
  endSaves.id = 'gk-end-title'
  endHead.append(endGrade, endSaves)
  const stats = el('dl', 'gk-stats')
  const kicksTable = el('table', 'gk-kicks')
  const endActions = el('div', 'gk-actions')
  const again = button('Rematch')
  endActions.append(again)
  if (opts.onHome) endActions.append(homeButton())
  // Buttons sit right under the stats so they are visible without scrolling on a 768 px laptop;
  // the per-kick table and level picker follow.
  const endMore = el('div', 'gk-end-more')
  endMore.append(levelPicker(), kicksTable)
  end.append(endKicker, endHead, stats, endActions, endMore)

  // ---------- debug ----------
  const debug = el('aside', 'gk-debug')
  debug.setAttribute('aria-label', 'Debug values')
  const debugList = el('dl')
  debug.append(debugList)
  let debugOpen = false

  hud.append(backdrop, play, callouts, start, loading, error, calib, end, debug)
  root.append(hud)

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

  function setView(view: View, focus?: HTMLElement): void {
    const changed = hud.dataset.view !== view
    hud.dataset.view = view
    if (changed && focus) {
      // Focus after display flips so the button is focusable.
      requestAnimationFrame(() => focus.focus({ preventScroll: true }))
    }
  }

  function setScoreboard(results: readonly KickResult[], total: number): void {
    const byKick = new Map<number, KickResult>()
    for (const r of results) byKick.set(r.kick, r)
    const current = results.length < total ? results.length : -1
    pips.replaceChildren()
    for (let i = 0; i < total; i++) {
      const pip = el('li', 'gk-pip')
      const r = byKick.get(i)
      if (r) {
        pip.dataset.state = r.outcome
        pip.textContent = r.outcome === 'save' ? '✓' : '✗'
        pip.setAttribute('aria-label', `Kick ${i + 1}: ${r.outcome === 'save' ? 'saved' : 'goal'}`)
      } else if (i === current) {
        pip.dataset.state = 'current'
        pip.setAttribute('aria-label', `Kick ${i + 1}: now`)
      } else {
        pip.dataset.state = 'pending'
        pip.setAttribute('aria-label', `Kick ${i + 1}: pending`)
      }
      pips.append(pip)
    }
    const shown = Math.min(results.length + 1, total)
    counter.textContent = `KICK ${shown}/${total}`
    const combo = results.length > 0 ? (results[results.length - 1].combo ?? 0) : 0
    comboTag.textContent = combo > 1 ? `x${combo} COMBO` : ''
    comboTag.hidden = combo <= 1
  }

  function stat(label: string, value: string, unit?: string): HTMLElement {
    const wrap = el('div', 'gk-stat')
    const dd = el('dd', undefined, value)
    if (unit) dd.append(' ', el('small', undefined, unit))
    wrap.append(el('dt', undefined, label), dd)
    return wrap
  }

  const api: KeeperHud = {
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
      calib.dataset.status = status
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

    callout(text, tone) {
      const node = el('div', `gk-callout gk-callout--${tone}`, text)
      // One callout at a time: the newest replaces any still fading.
      callouts.replaceChildren(node)
      const id = window.setTimeout(() => {
        timers.delete(id)
        node.remove()
      }, CALLOUT_MS)
      timers.add(id)
    },

    setPracticeChoice(on: boolean, onChange: (on: boolean) => void) {
      practiceBox.checked = on
      onPracticeChoice = onChange
    },

    setPractice(prompt: string | null, skip?: () => void) {
      if (skip) onSkip = skip
      practiceBar.hidden = prompt === null
      if (prompt !== null && practiceText.textContent !== prompt) {
        practiceText.textContent = prompt
        practiceText.classList.remove('gk-practice-in')
        void practiceText.offsetWidth // restart the fade-in for each new line
        practiceText.classList.add('gk-practice-in')
      }
    },

    gradePopup(grade: SaveGrade, combo: number, points: number) {
      const node = el('div', `gk-grade gk-grade--${grade}`)
      node.append(el('span', 'gk-grade-word', GRADE_WORD[grade]))
      if (grade !== 'miss') {
        const sub = el('span', 'gk-grade-sub', `+${points.toLocaleString('en-US')}`)
        if (combo > 1) sub.prepend(el('b', undefined, `x${combo} COMBO `))
        node.append(sub)
      }
      callouts.replaceChildren(node)
      const id = window.setTimeout(() => {
        timers.delete(id)
        node.remove()
      }, CALLOUT_MS + 200)
      timers.add(id)
    },

    setTelegraph(on: boolean) {
      telegraph.classList.toggle('gk-on', on)
    },

    setDifficulty(level: Difficulty, onChange: (level: Difficulty) => void) {
      onLevel = onChange
      markLevel(level)
    },

    setInputMode(mode: InputMode) {
      badge.dataset.mode = mode
      badge.textContent = mode === 'mouse' ? 'MOUSE · D' : 'CAMERA'
    },

    showEnd(result: ShootoutResult, againCb) {
      onAgain = againCb
      const total = result.kicks.length
      endSaves.replaceChildren('SAVES ', el('span', undefined, `${result.saves}/${total}`))
      const grade = result.grade ?? 'C'
      endGrade.textContent = grade
      endGrade.dataset.grade = grade
      const pct = result.savePct ?? (total > 0 ? Math.round((result.saves / total) * 100) : 0)
      stats.replaceChildren(
        stat('Save %', `${pct}`, '%'),
        stat('Best combo', `x${result.bestCombo ?? 0}`),
        stat('Avg reaction', fmtMs(result.avgReactionMs), result.avgReactionMs === null ? undefined : 'ms'),
        stat('Score', result.score.toLocaleString('en-US')),
      )
      const head = el('thead')
      const hr = el('tr')
      for (const h of ['#', 'Result', 'Shot', 'Zone', 'React ms']) hr.append(el('th', undefined, h))
      head.append(hr)
      const body = el('tbody')
      for (const k of result.kicks) {
        const tr = el('tr')
        const outcome =
          k.outcome === 'save'
            ? el('td', 'gk-ok', `✓ ${k.grade ? GRADE_LABEL[k.grade] : k.part ? PART_LABEL[k.part] : 'Wide'}`)
            : el('td', 'gk-no', '✗ Goal')
        tr.append(
          el('td', undefined, String(k.kick + 1)),
          outcome,
          el('td', undefined, k.shot ? SHOT_LABEL[k.shot] : '—'),
          el('td', undefined, zoneLabel(k.zone)),
          el('td', undefined, fmtMs(k.reactionMs)),
        )
        body.append(tr)
      }
      kicksTable.replaceChildren(head, body)
      setScoreboard(result.kicks, total)
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
      debug.classList.toggle('gk-open', debugOpen)
    },

    dispose() {
      for (const id of timers) window.clearTimeout(id)
      timers.clear()
      hud.remove()
    },
  }

  setScoreboard([], 5)
  return api
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (Number.isInteger(v)) return String(v)
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)
}
