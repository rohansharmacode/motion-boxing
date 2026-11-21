// Draws the tracked arms on the unflipped overlay canvas above the mirrored webcam preview.
import { LM } from './types.ts'
import type { Joint, PoseFrame } from './types.ts'

export interface PoseOverlay {
  resize(width: number, height: number): void
  /** highlight: wrists use the secondary accent (for example while the guard is up). */
  draw(frame: PoseFrame | null, highlight: boolean): void
}

const MIN_VISIBILITY = 0.5

const ARMS = [
  [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST],
] as const

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

  const visible = (p: Joint | undefined): p is Joint => p !== undefined && p.visibility >= MIN_VISIBILITY

  const line = (pts: (Joint | undefined)[]): void => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      if (!visible(a) || !visible(b)) continue
      ctx.beginPath()
      ctx.moveTo(a.x * canvas.width, a.y * canvas.height)
      ctx.lineTo(b.x * canvas.width, b.y * canvas.height)
      ctx.stroke()
    }
  }

  const dot = (p: Joint | undefined, r: number): void => {
    if (!visible(p)) return
    ctx.beginPath()
    ctx.arc(p.x * canvas.width, p.y * canvas.height, r, 0, Math.PI * 2)
    ctx.fill()
  }

  return {
    resize(width, height) {
      canvas.width = width
      canvas.height = height
    },

    draw(frame, highlight) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (!frame) return
      const pts = frame.image
      // 1 unit is 1/100 of the shorter side: 4.8 px at 640x480, 7.2 px at 1280x720.
      const unit = Math.min(canvas.width, canvas.height) / 100

      ctx.lineCap = 'round'
      ctx.strokeStyle = text
      ctx.fillStyle = text
      ctx.globalAlpha = 0.85
      ctx.lineWidth = unit * 0.8
      line([pts[LM.L_SHOULDER], pts[LM.R_SHOULDER]])
      for (const arm of ARMS) line(arm.map((i) => pts[i]))
      for (const arm of ARMS) {
        dot(pts[arm[0]], unit * 1.1)
        dot(pts[arm[1]], unit * 1.1)
      }

      // Wrists: filled circle with a light rim.
      ctx.globalAlpha = 1
      ctx.fillStyle = highlight ? accent2 : accent
      ctx.lineWidth = unit * 0.6
      for (const arm of ARMS) {
        const wrist = pts[arm[2]]
        if (!visible(wrist)) continue
        dot(wrist, unit * 4)
        ctx.stroke()
      }
    },
  }
}
