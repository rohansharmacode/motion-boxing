// Synthesized boxing sound effects (Web Audio only, no audio files).
import type { AttackPattern, BoxingSfx, PunchKind } from './types.ts'

const MAX_VOICES = 12
const MASTER_VOL = 0.8

interface Voice {
  /** Seconds after now. */
  at?: number
  dur: number
  vol: number
  /** Seconds to reach full volume. Long attacks make risers. */
  attack?: number
  /** Optional filter with a frequency sweep. */
  filter?: { type: BiquadFilterType; f0: number; f1?: number; q?: number }
}

interface ToneVoice extends Voice {
  type: OscillatorType
  f0: number
  f1?: number
}

export function createBoxingSfx(): BoxingSfx {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let noiseBuf: AudioBuffer | null = null
  let muted = false
  let disposed = false
  let voices = 0

  /** Wire source -> (filter) -> envelope -> master, schedule, and clean up when done. */
  function play(src: AudioScheduledSourceNode, v: Voice): void {
    if (!ctx || !master) return
    const t = ctx.currentTime + (v.at ?? 0)
    const end = t + v.dur
    const env = ctx.createGain()
    const attack = Math.min(v.attack ?? 0.005, v.dur * 0.95)
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(v.vol, t + attack)
    env.gain.exponentialRampToValueAtTime(0.0001, end)
    const nodes: AudioNode[] = [src, env]
    let head: AudioNode = env
    if (v.filter) {
      const f = ctx.createBiquadFilter()
      f.type = v.filter.type
      f.Q.value = v.filter.q ?? 1
      f.frequency.setValueAtTime(v.filter.f0, t)
      if (v.filter.f1) f.frequency.exponentialRampToValueAtTime(v.filter.f1, end)
      f.connect(env)
      nodes.push(f)
      head = f
    }
    src.connect(head)
    env.connect(master)
    voices++
    src.onended = () => {
      voices--
      for (const n of nodes) n.disconnect()
    }
    src.start(t)
    src.stop(end + 0.02)
  }

  function ready(): boolean {
    return !!ctx && !disposed && voices < MAX_VOICES
  }

  function tone(v: ToneVoice): void {
    if (!ready() || !ctx) return
    const osc = ctx.createOscillator()
    osc.type = v.type
    const t = ctx.currentTime + (v.at ?? 0)
    osc.frequency.setValueAtTime(v.f0, t)
    if (v.f1) osc.frequency.exponentialRampToValueAtTime(v.f1, t + v.dur)
    play(osc, v)
  }

  function noise(v: Voice): void {
    if (!ready() || !ctx || !noiseBuf) return
    const src = ctx.createBufferSource()
    src.buffer = noiseBuf
    src.loop = true
    play(src, v)
  }

  return {
    unlock() {
      if (disposed) return
      try {
        if (!ctx) {
          ctx = new AudioContext()
          const comp = ctx.createDynamicsCompressor()
          comp.threshold.value = -14
          comp.knee.value = 12
          comp.ratio.value = 4
          comp.attack.value = 0.003
          comp.release.value = 0.15
          master = ctx.createGain()
          master.gain.value = muted ? 0 : MASTER_VOL
          master.connect(comp)
          comp.connect(ctx.destination)
          noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
          const data = noiseBuf.getChannelData(0)
          for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
        }
        if (ctx.state === 'suspended') void ctx.resume()
      } catch {
        ctx = null
      }
    },

    punch(kind: PunchKind, landed: boolean, counter: boolean) {
      const heavy = kind === 'cross' || kind === 'uppercut'
      noise({ dur: 0.12, vol: 0.25, filter: { type: 'bandpass', f0: 500, f1: 2200, q: 1.2 } })
      if (!landed) return
      tone({ type: 'sine', f0: heavy ? 120 : 160, f1: heavy ? 38 : 55, dur: heavy ? 0.22 : 0.14, vol: heavy ? 0.9 : 0.65, at: 0.04 })
      noise({ dur: 0.06, vol: 0.4, at: 0.04, filter: { type: 'lowpass', f0: heavy ? 1200 : 1800 } })
      if (counter) {
        tone({ type: 'triangle', f0: 1760, f1: 2640, dur: 0.18, vol: 0.18, at: 0.06 })
        tone({ type: 'triangle', f0: 2640, f1: 3520, dur: 0.22, vol: 0.14, at: 0.12 })
      }
    },

    combo(count: number) {
      // Rise one whole tone per hit, capped at an octave and a half.
      const f = 660 * Math.pow(2, Math.min(Math.max(count - 2, 0) * 2, 18) / 12)
      tone({ type: 'sine', f0: f, dur: 0.25, vol: 0.2 })
      tone({ type: 'triangle', f0: f * 1.5, dur: 0.2, vol: 0.08, at: 0.03 })
    },

    telegraph(pattern: AttackPattern) {
      const dur = 0.6
      if (pattern === 'straight') {
        tone({ type: 'square', f0: 330, f1: 1320, dur, vol: 0.09, attack: 0.5, filter: { type: 'lowpass', f0: 800, f1: 4000 } })
      } else if (pattern === 'hook') {
        tone({ type: 'sawtooth', f0: 110, f1: 330, dur, vol: 0.12, attack: 0.5, filter: { type: 'bandpass', f0: 300, f1: 1500, q: 4 } })
        tone({ type: 'sawtooth', f0: 113, f1: 337, dur, vol: 0.08, attack: 0.5, filter: { type: 'lowpass', f0: 900 } })
      } else {
        tone({ type: 'sine', f0: 60, f1: 240, dur, vol: 0.35, attack: 0.5 })
        noise({ dur, vol: 0.12, attack: 0.55, filter: { type: 'highpass', f0: 400, f1: 3000 } })
      }
    },

    block() {
      tone({ type: 'square', f0: 950, dur: 0.12, vol: 0.12, filter: { type: 'bandpass', f0: 1400, q: 6 } })
      tone({ type: 'square', f0: 1430, dur: 0.09, vol: 0.08, filter: { type: 'bandpass', f0: 2100, q: 6 } })
      noise({ dur: 0.05, vol: 0.3, filter: { type: 'highpass', f0: 2500 } })
    },

    dodge() {
      noise({ dur: 0.2, vol: 0.3, attack: 0.06, filter: { type: 'bandpass', f0: 2400, f1: 500, q: 2 } })
    },

    playerHit() {
      tone({ type: 'sine', f0: 95, f1: 35, dur: 0.32, vol: 0.95 })
      noise({ dur: 0.18, vol: 0.45, filter: { type: 'lowpass', f0: 900, f1: 200 } })
    },

    bell() {
      for (const at of [0, 0.35]) {
        tone({ type: 'sine', f0: 880, dur: 1.2, vol: 0.3, at })
        tone({ type: 'sine', f0: 2430, dur: 0.6, vol: 0.08, at })
      }
    },

    ko(win: boolean) {
      if (win) {
        const notes = [523, 659, 784, 1047]
        notes.forEach((f, i) => {
          const last = i === notes.length - 1
          tone({ type: 'triangle', f0: f, dur: last ? 0.9 : 0.16, vol: 0.25, at: i * 0.12 })
        })
        tone({ type: 'sine', f0: 1568, dur: 0.8, vol: 0.08, at: 0.36 })
      } else {
        tone({ type: 'sawtooth', f0: 440, f1: 90, dur: 1.1, vol: 0.18, filter: { type: 'lowpass', f0: 2000, f1: 300 } })
        tone({ type: 'sine', f0: 80, f1: 30, dur: 0.6, vol: 0.8, at: 0.9 })
      }
    },

    setMuted(m: boolean) {
      muted = m
      if (!ctx || !master) return
      const g = master.gain
      g.cancelScheduledValues(ctx.currentTime)
      g.setTargetAtTime(m ? 0 : MASTER_VOL, ctx.currentTime, 0.04)
    },

    dispose() {
      disposed = true
      if (ctx) void ctx.close().catch(() => {})
      ctx = null
      master = null
      noiseBuf = null
    },
  }
}
