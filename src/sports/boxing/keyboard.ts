import type { Hand } from '../../pose/types.ts'
import type { BoxingActions, KeyboardFallback, Punch, PunchKind, SlipKind } from './types.ts'

/** Plausible numbers so keyboard punches look like pose punches downstream. */
const PUNCH_FEEL: Record<PunchKind, { peakVelocity: number; elbowAngle: number }> = {
  jab: { peakVelocity: 6, elbowAngle: 170 },
  cross: { peakVelocity: 6, elbowAngle: 170 },
  hook: { peakVelocity: 5, elbowAngle: 100 },
  uppercut: { peakVelocity: 5.5, elbowAngle: 90 },
}

const GUARD_KEYS = ['ShiftLeft', 'ShiftRight', 'ArrowUp']

function isTyping(e: Event): boolean {
  const el = e.target
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  )
}

export function createKeyboardFallback(target: Window = window): KeyboardFallback {
  let enabled = false
  let queue: Punch[] = []
  const held = new Set<string>()
  let hookHand: Hand = 'left'
  let upperHand: Hand = 'left'
  let straightHand: Hand = 'left'

  function queuePunch(kind: PunchKind, hand: Hand): void {
    queue.push({ kind, hand, t: performance.now(), ...PUNCH_FEEL[kind], source: 'keyboard' })
  }

  function straight(): void {
    queuePunch(straightHand === 'left' ? 'jab' : 'cross', straightHand)
    straightHand = straightHand === 'left' ? 'right' : 'left'
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!enabled || e.repeat || isTyping(e) || e.code === 'KeyD') return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    switch (e.code) {
      case 'KeyJ':
        queuePunch('jab', 'left')
        break
      case 'KeyK':
        queuePunch('cross', 'right')
        break
      case 'KeyH':
        queuePunch('hook', hookHand)
        hookHand = hookHand === 'left' ? 'right' : 'left'
        break
      case 'KeyU':
        queuePunch('uppercut', upperHand)
        upperHand = upperHand === 'left' ? 'right' : 'left'
        break
      case 'Space':
        straight()
        break
      case 'ShiftLeft':
      case 'ShiftRight':
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowDown':
        held.add(e.code)
        break
      default:
        return
    }
    e.preventDefault()
  }

  function onKeyUp(e: KeyboardEvent): void {
    held.delete(e.code)
  }

  function onMouseDown(e: MouseEvent): void {
    if (!enabled || e.button !== 0) return
    // Clicks on real buttons (start, again) are UI, not punches.
    if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea')) return
    straight()
  }

  function onBlur(): void {
    held.clear()
  }

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('mousedown', onMouseDown)
  target.addEventListener('blur', onBlur)

  function currentSlip(): SlipKind | null {
    if (held.has('ArrowDown')) return 'duck'
    if (held.has('ArrowLeft')) return 'left'
    if (held.has('ArrowRight')) return 'right'
    return null
  }

  function setEnabled(on: boolean): void {
    enabled = on
    if (!on) {
      queue = []
      held.clear()
    }
  }

  return {
    get enabled() {
      return enabled
    },

    setEnabled,

    toggle() {
      setEnabled(!enabled)
      return enabled
    },

    poll(): BoxingActions {
      if (!enabled) return { punches: [], guard: false, slip: null, debug: {} }
      const punches = queue
      queue = []
      const guard = GUARD_KEYS.some((k) => held.has(k))
      return { punches, guard, slip: currentSlip(), debug: { kbHeld: held.size } }
    },

    dispose() {
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('mousedown', onMouseDown)
      target.removeEventListener('blur', onBlur)
      queue = []
      held.clear()
    },
  }
}
