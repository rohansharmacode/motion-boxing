// Tiny synthesised UI sounds (WebAudio, no files). Original tones.
import { isBright } from '../theme/index.ts'
import { createBrightUiSfx } from '../theme/bright/sfx.ts'

export interface Sfx {
  hover(): void
  select(): void
  back(): void
  denied(): void
}

export function createSfx(): Sfx {
  if (isBright()) return createBrightUiSfx()
  let ctx: AudioContext | null = null

  function audio(): AudioContext | null {
    if (!ctx) {
      try {
        ctx = new AudioContext()
      } catch {
        return null
      }
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }

  function tone(freq: number, endFreq: number, ms: number, gain: number, type: OscillatorType = 'sine', delayMs = 0): void {
    const a = audio()
    if (!a) return
    const t0 = a.currentTime + delayMs / 1000
    const t1 = t0 + ms / 1000
    const osc = a.createOscillator()
    const g = a.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t0)
    osc.frequency.exponentialRampToValueAtTime(endFreq, t1)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t1)
    osc.connect(g).connect(a.destination)
    osc.start(t0)
    osc.stop(t1 + 0.02)
  }

  return {
    hover: () => tone(880, 1320, 70, 0.04, 'triangle'),
    select() {
      tone(520, 780, 110, 0.08, 'triangle')
      tone(780, 1560, 180, 0.06, 'sine', 90)
    },
    back: () => tone(700, 350, 140, 0.06, 'triangle'),
    denied: () => tone(220, 180, 160, 0.06, 'square'),
  }
}
