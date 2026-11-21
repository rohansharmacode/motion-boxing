// Live "we can't see you" banner for play. Feeds on raw PoseFrames and tells the player, in plain words, why
// their moves are not registering: nobody in view, too close, or a fist out of frame. Hides as soon as it is fixed.
import { LM } from './types.ts'
import type { PoseFrame } from './types.ts'

export interface TrackingHint {
  /** Feed every pipeline frame (null = no pose). */
  push(frame: PoseFrame | null): void
  /** Hide and stop showing (for example on the start or end screen). */
  setActive(on: boolean): void
  dispose(): void
}

type Problem = 'lost' | 'too-close' | 'hands' | null

const COPY: Record<Exclude<Problem, null>, string> = {
  lost: "Can't see you. Step back into view",
  'too-close': 'Too close. Take a step back',
  hands: 'Keep both fists in view',
}

/** A problem must last this long before the banner shows, so a single dropped frame never flickers it. */
const SHOW_AFTER_MS = 600
const MIN_VISIBILITY = 0.35
const MAX_SHOULDER = 0.55
const EDGE = 0.01

function problemOf(frame: PoseFrame | null): Problem {
  if (!frame || frame.image.length < 33) return 'lost'
  const p = frame.image
  const l = p[LM.L_SHOULDER]
  const r = p[LM.R_SHOULDER]
  if (l.visibility < MIN_VISIBILITY && r.visibility < MIN_VISIBILITY) return 'lost'
  if (Math.abs(l.x - r.x) > MAX_SHOULDER) return 'too-close'
  const out = (i: number): boolean => {
    const w = p[i]
    return w.visibility < MIN_VISIBILITY || w.x < EDGE || w.x > 1 - EDGE || w.y < EDGE || w.y > 1 - EDGE
  }
  if (out(LM.L_WRIST) || out(LM.R_WRIST)) return 'hands'
  return null
}

export function createTrackingHint(parent: HTMLElement): TrackingHint {
  const root = document.createElement('div')
  root.className = 'pose-hint'
  root.setAttribute('role', 'status')
  root.setAttribute('aria-live', 'polite')
  Object.assign(root.style, {
    position: 'fixed',
    left: '50%',
    bottom: '96px',
    zIndex: '6',
    padding: '10px 18px',
    borderRadius: '999px',
    background: 'rgba(255, 64, 64, 0.92)',
    color: '#fff',
    font: '700 18px/1.2 var(--font-body, system-ui, sans-serif)',
    boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
    pointerEvents: 'none',
    transform: 'translateX(-50%)',
    transition: 'opacity 160ms ease',
    opacity: '0',
  })
  parent.append(root)

  let active = false
  let current: Problem = null
  let since = 0
  let shown: Problem = null

  const show = (p: Problem): void => {
    if (p === shown) return
    shown = p
    if (p) root.textContent = COPY[p]
    root.style.opacity = p ? '1' : '0'
  }

  return {
    push(frame) {
      if (!active) return
      const now = performance.now()
      const p = problemOf(frame)
      if (p !== current) {
        current = p
        since = now
      }
      show(p !== null && now - since >= SHOW_AFTER_MS ? p : null)
    },
    setActive(on) {
      active = on
      current = null
      if (!on) show(null)
    },
    dispose() {
      root.remove()
    },
  }
}
