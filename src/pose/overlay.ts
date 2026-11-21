// Draws the tracked body on the unflipped overlay canvas above the mirrored webcam preview, so players can
// see exactly what the camera reads: an upper-body skeleton, big fist markers, a flash when a punch registers,
// and (while framing) a guide box showing where to stand.
import { LM } from './types.ts'
import type { Hand, Joint, PoseFrame } from './types.ts'

export interface PoseOverlay {
  resize(width: number, height: number): void
  /** highlight: wrists use the secondary accent (for example while the guard is up). */
  draw(frame: PoseFrame | null, highlight: boolean): void
  /** Flash a burst on one fist (a punch registered). label is drawn next to it, for example "JAB". */
  flash(hand: Hand, label?: string): void
  /** Show or hide the framing guide (head and shoulders zone) while calibrating. */
  setGuide(on: boolean): void
}

/** Joints below this are drawn faded; below HIDE_VISIBILITY not at all. */
const MIN_VISIBILITY = 0.5
const HIDE_VISIBILITY = 0.25
const FLASH_MS = 320
const L_HIP = 23
const R_HIP = 24
const L_INDEX = 19
const R_INDEX = 20

const BONES: ReadonlyArray<readonly [number, number]> = [
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_SHOULDER, LM.L_ELBOW],
  [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW],
  [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_SHOULDER, L_HIP],
  [LM.R_SHOULDER, R_HIP],
  [L_HIP, R_HIP],
  [LM.L_WRIST, L_INDEX],
  [LM.R_WRIST, R_INDEX],
]

const WRISTS: Record<Hand, number> = { left: LM.L_WRIST, right: LM.R_WRIST }

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback
}

export function createPoseOverlay(canvas: HTMLCanvasElement): PoseOverlay {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')

  const style = getComputedStyle(document.documentElement)
  const accent = cssVar(style, '--accent', '#ff5a1f')
  const accent2 = cssVar(style, '--accent-2', '#38c8ff')
  const text = cssVar(style, '--text', '#f4f4f0')

  const flashes: Array<{ hand: Hand; label: string; start: number }> = []
  let guide = false

  const alphaOf = (p: Joint | undefined): number =>
    p === undefined || !(p.visibility >= HIDE_VISIBILITY) ? 0 : p.visibility >= MIN_VISIBILITY ? 1 : 0.4

  const px = (p: Joint): [number, number] => [p.x * canvas.width, p.y * canvas.height]

  const drawGuide = (unit: number): void => {
    // Head-and-shoulders zone: where the player should be for good tracking (about 1.5 to 2 m back).
    const w = canvas.width
    const h = canvas.height
    ctx.save()
    ctx.globalAlpha = 0.7
    ctx.strokeStyle = text
    ctx.lineWidth = unit * 0.5
    ctx.setLineDash([unit * 2, unit * 1.5])
    const zoneW = h * 0.62
    const left = (w - zoneW) / 2
    ctx.strokeRect(left, h * 0.12, zoneW, h * 0.8)
    ctx.beginPath()
    ctx.arc(w / 2, h * 0.3, h * 0.09, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  return {
    resize(width, height) {
      canvas.width = width
      canvas.height = height
    },

    flash(hand, label = '') {
      flashes.push({ hand, label, start: performance.now() })
      if (flashes.length > 6) flashes.shift()
    },

    setGuide(on) {
      guide = on
    },

    draw(frame, highlight) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      // 1 unit is 1/100 of the shorter side: 4.8 px at 640x480, 7.2 px at 1280x720.
      const unit = Math.min(canvas.width, canvas.height) / 100
      if (guide) drawGuide(unit)
      if (!frame) return
      const pts = frame.image
      const now = performance.now()

      ctx.lineCap = 'round'
      ctx.strokeStyle = text
      ctx.fillStyle = text
      ctx.lineWidth = unit * 0.9
      for (const [a, b] of BONES) {
        const pa = pts[a]
        const pb = pts[b]
        const al = Math.min(alphaOf(pa), alphaOf(pb))
        if (al === 0 || !pa || !pb) continue
        ctx.globalAlpha = 0.8 * al
        ctx.beginPath()
        ctx.moveTo(...px(pa))
        ctx.lineTo(...px(pb))
        ctx.stroke()
      }
      for (const i of [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_ELBOW, LM.R_ELBOW, L_HIP, R_HIP]) {
        const p = pts[i]
        const al = alphaOf(p)
        if (al === 0 || !p) continue
        ctx.globalAlpha = 0.9 * al
        ctx.beginPath()
        ctx.arc(...px(p), unit * 1.2, 0, Math.PI * 2)
        ctx.fill()
      }

      // Head: a ring around the nose so players see the slip and duck reference.
      const nose = pts[LM.NOSE]
      if (nose && alphaOf(nose) > 0) {
        ctx.globalAlpha = 0.7 * alphaOf(nose)
        ctx.lineWidth = unit * 0.6
        ctx.beginPath()
        ctx.arc(...px(nose), unit * 5, 0, Math.PI * 2)
        ctx.stroke()
      }

      // Fists: big filled circles with a light rim. Faded fists tell the player that hand is not tracked.
      ctx.fillStyle = highlight ? accent2 : accent
      ctx.lineWidth = unit * 0.6
      for (const hand of ['left', 'right'] as const) {
        const wrist = pts[WRISTS[hand]]
        const al = alphaOf(wrist)
        if (al === 0 || !wrist) continue
        ctx.globalAlpha = al
        ctx.beginPath()
        ctx.arc(...px(wrist), unit * 4.5, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }

      // Punch bursts: expanding ring plus the punch name, so the player knows the camera caught it.
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i]
        const k = (now - f.start) / FLASH_MS
        if (k >= 1) {
          flashes.splice(i, 1)
          continue
        }
        const wrist = pts[WRISTS[f.hand]]
        if (!wrist || alphaOf(wrist) === 0) continue
        const [x, y] = px(wrist)
        ctx.globalAlpha = 1 - k
        ctx.strokeStyle = accent2
        ctx.lineWidth = unit * (1.6 - k)
        ctx.beginPath()
        ctx.arc(x, y, unit * (5 + 9 * k), 0, Math.PI * 2)
        ctx.stroke()
        if (f.label) {
          ctx.fillStyle = text
          ctx.font = `800 ${Math.round(unit * 6)}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillText(f.label, x, y - unit * (9 + 6 * k))
        }
        ctx.strokeStyle = text
      }
      ctx.globalAlpha = 1
    },
  }
}
