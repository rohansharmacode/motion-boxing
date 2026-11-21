// 15 second practice before the first fight: punch, guard, dodge. Each step ticks off as the camera sees it,
// so the player learns what reads as a punch before anything can hit them. Skippable, and shown once per browser.
import './tutorial.css'
import type { BoxingActions } from './types.ts'

export interface BoxingTutorial {
  /** Feed every detector result while the tutorial runs. t is BodyFrame time or performance.now(), ms. */
  onActions(actions: BoxingActions, t: number): void
  /** Ends now and calls onDone. Safe to call twice. */
  skip(): void
  dispose(): void
}

export interface TutorialOptions {
  onDone(): void
  /** Called as each step completes (for a sound). */
  onStep?(): void
}

const STORAGE_KEY = 'motion-sports.boxing-tutorial-done'
const PUNCHES_NEEDED = 3
const GUARD_HOLD_MS = 500
const DONE_PAUSE_MS = 900

interface Step {
  title: string
  hint: string
}

const STEPS: Step[] = [
  { title: `Throw ${PUNCHES_NEEDED} punches`, hint: 'Punch straight at the screen, either hand. Snap it back after.' },
  { title: 'Guard up', hint: 'Both fists up by your cheeks. Hold it.' },
  { title: 'Dodge', hint: 'Lean your head left or right, or duck down.' },
]

/** True when this browser has not finished (or skipped) the tutorial yet. */
export function tutorialNeeded(): boolean {
  try {
    if (new URLSearchParams(location.search).has('tutorial')) return true
    return localStorage.getItem(STORAGE_KEY) !== '1'
  } catch {
    return false
  }
}

function markDone(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // Private mode: the tutorial just shows again next time.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function createBoxingTutorial(parent: HTMLElement, opts: TutorialOptions): BoxingTutorial {
  const root = el('div', 'bx-tut')
  root.setAttribute('role', 'status')
  root.setAttribute('aria-live', 'polite')
  const kicker = el('div', 'bx-tut-kicker', 'PRACTICE')
  const title = el('div', 'bx-tut-title')
  const hint = el('div', 'bx-tut-hint')
  const dots = el('ol', 'bx-tut-steps')
  const dotEls = STEPS.map((s) => {
    const li = el('li', 'bx-tut-step', s.title)
    dots.append(li)
    return li
  })
  const meter = el('div', 'bx-tut-meter')
  const meterFill = el('div', 'bx-tut-meter-fill')
  meter.append(meterFill)
  const skipBtn = el('button', 'bx-tut-skip', 'Skip practice (Enter)')
  skipBtn.type = 'button'
  root.append(kicker, title, hint, meter, dots, skipBtn)
  parent.append(root)

  let step = 0
  let punches = 0
  let guardSince: number | null = null
  let finished = false
  let doneTimer = 0

  function render(progress: number): void {
    const s = STEPS[step]
    if (s) {
      title.textContent = s.title
      hint.textContent = s.hint
    }
    meterFill.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`
    dotEls.forEach((d, i) => {
      d.classList.toggle('bx-tut-step--done', i < step)
      d.classList.toggle('bx-tut-step--now', i === step)
    })
  }

  function advance(): void {
    step++
    opts.onStep?.()
    root.classList.remove('bx-tut--pop')
    void root.offsetWidth
    root.classList.add('bx-tut--pop')
    if (step >= STEPS.length) {
      title.textContent = "You're ready!"
      hint.textContent = 'Block with your guard, dodge the drone, punch back.'
      meterFill.style.transform = 'scaleX(1)'
      dotEls.forEach((d) => d.classList.add('bx-tut-step--done'))
      doneTimer = window.setTimeout(finish, DONE_PAUSE_MS)
      return
    }
    render(0)
  }

  function finish(): void {
    if (finished) return
    finished = true
    clearTimeout(doneTimer)
    markDone()
    opts.onDone()
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Enter' || e.code === 'Escape') {
      e.preventDefault()
      finish()
    }
  }
  skipBtn.addEventListener('click', finish)
  window.addEventListener('keydown', onKey)
  render(0)

  return {
    onActions(a, t) {
      if (finished || step >= STEPS.length) return
      if (step === 0) {
        punches += a.punches.length
        render(punches / PUNCHES_NEEDED)
        if (punches >= PUNCHES_NEEDED) advance()
      } else if (step === 1) {
        if (a.guard) guardSince ??= t
        else guardSince = null
        const held = guardSince === null ? 0 : t - guardSince
        render(held / GUARD_HOLD_MS)
        if (held >= GUARD_HOLD_MS) advance()
      } else if (step === 2) {
        if (a.slip !== null) advance()
      }
    },
    skip: finish,
    dispose() {
      finished = true
      clearTimeout(doneTimer)
      window.removeEventListener('keydown', onKey)
      root.remove()
    },
  }
}
