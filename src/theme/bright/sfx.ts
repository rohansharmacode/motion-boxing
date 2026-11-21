// Bright theme sounds: cheerful, bouncy, ORIGINAL synthesised tones (WebAudio, no files).
// One shared AudioContext is created lazily on first use; every call is a silent no-op when
// WebAudio is unavailable. All voices disconnect themselves when they end.

export interface UiSfx {
  hover(): void
  select(): void
  back(): void
  denied(): void
}

export interface BoxingSfx {
  punchWhoosh(): void
  hit(strength: number, counter: boolean): void
  block(): void
  playerHit(): void
  telegraph(): void
  bell(): void
  ko(): void
  win(): void
  lose(): void
  crowdCheer(intensity?: number): void
  countdownTick(final?: boolean): void
  setMuted(m: boolean): void
  dispose(): void
}

// ---------------------------------------------------------------- shared engine

interface Engine {
  ctx: AudioContext
  master: GainNode
  noise: AudioBuffer
}

let engine: Engine | null = null
let engineFailed = false

function getEngine(): Engine | null {
  if (engineFailed) return null
  if (!engine) {
    try {
      const AC: typeof AudioContext | undefined =
        typeof window !== 'undefined'
          ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined
      if (!AC) {
        engineFailed = true
        return null
      }
      const ctx = new AC()
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -18
      comp.knee.value = 12
      comp.ratio.value = 3
      comp.attack.value = 0.004
      comp.release.value = 0.2
      const master = ctx.createGain()
      master.gain.value = 0.6
      master.connect(comp).connect(ctx.destination)
      const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate)
      const d = noise.getChannelData(0)
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
      engine = { ctx, master, noise }
    } catch {
      engineFailed = true
      return null
    }
  }
  if (engine.ctx.state === 'suspended') engine.ctx.resume().catch(() => {})
  return engine
}

/** Exponential attack/decay envelope that starts and ends near silence (no clicks). */
function env(p: AudioParam, t0: number, attack: number, peak: number, decay: number): void {
  p.setValueAtTime(0.0001, t0)
  p.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + Math.max(0.002, attack))
  p.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.002, attack) + Math.max(0.01, decay))
}

function cleanup(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  src.onended = () => {
    src.disconnect()
    for (const n of nodes) n.disconnect()
  }
}

interface ToneOpts {
  type?: OscillatorType
  f0: number
  f1?: number
  /** Seconds the pitch glides from f0 to f1. Defaults to the full decay. */
  glide?: number
  attack?: number
  decay: number
  peak: number
  delay?: number
  /** Vibrato depth in Hz and rate in Hz. */
  vib?: [number, number]
}

function tone(e: Engine, out: AudioNode, o: ToneOpts): void {
  const { ctx } = e
  const t0 = ctx.currentTime + (o.delay ?? 0)
  const attack = o.attack ?? 0.005
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(o.f0, t0)
  if (o.f1 !== undefined && o.f1 !== o.f0) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + (o.glide ?? attack + o.decay))
  }
  env(g.gain, t0, attack, o.peak, o.decay)
  const extra: AudioNode[] = [g]
  if (o.vib) {
    const lfo = ctx.createOscillator()
    const lg = ctx.createGain()
    lfo.frequency.value = o.vib[1]
    lg.gain.value = o.vib[0]
    lfo.connect(lg).connect(osc.frequency)
    lfo.start(t0)
    lfo.stop(t0 + attack + o.decay + 0.05)
    cleanup(lfo, [lg])
  }
  osc.connect(g).connect(out)
  osc.start(t0)
  osc.stop(t0 + attack + o.decay + 0.05)
  cleanup(osc, extra)
}

/** Marimba-ish pluck: sine body + quiet octave partial, fast decay. */
function pluck(e: Engine, out: AudioNode, freq: number, peak: number, decay: number, delay = 0): void {
  tone(e, out, { type: 'sine', f0: freq, attack: 0.004, decay, peak, delay })
  tone(e, out, { type: 'triangle', f0: freq * 2, attack: 0.003, decay: decay * 0.45, peak: peak * 0.22, delay })
  tone(e, out, { type: 'sine', f0: freq * 4.01, attack: 0.002, decay: decay * 0.18, peak: peak * 0.08, delay })
}

interface NoiseOpts {
  filter: BiquadFilterType
  f0: number
  f1?: number
  q?: number
  attack: number
  decay: number
  peak: number
  delay?: number
}

function noiseBurst(e: Engine, out: AudioNode, o: NoiseOpts): void {
  const { ctx } = e
  const t0 = ctx.currentTime + (o.delay ?? 0)
  const src = ctx.createBufferSource()
  src.buffer = e.noise
  src.loop = true
  const f = ctx.createBiquadFilter()
  f.type = o.filter
  f.Q.value = o.q ?? 1
  f.frequency.setValueAtTime(o.f0, t0)
  if (o.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.attack + o.decay)
  const g = ctx.createGain()
  env(g.gain, t0, o.attack, o.peak, o.decay)
  src.connect(f).connect(g).connect(out)
  src.start(t0, Math.random() * 1.5)
  src.stop(t0 + o.attack + o.decay + 0.05)
  cleanup(src, [f, g])
}

/** Note frequency from semitones above A4 (440 Hz). */
const st = (n: number): number => 440 * Math.pow(2, n / 12)

// ---------------------------------------------------------------- UI

export function createBrightUiSfx(): UiSfx {
  let lastHover = 0
  const run = (fn: (e: Engine) => void): void => {
    const e = getEngine()
    if (!e) return
    try {
      fn(e)
    } catch {
      /* never throw from a sound */
    }
  }
  return {
    hover() {
      run((e) => {
        // Throttle so sweeping across many buttons does not pile up.
        if (e.ctx.currentTime - lastHover < 0.04) return
        lastHover = e.ctx.currentTime
        pluck(e, e.master, st(15), 0.07, 0.09) // C6
      })
    },
    select() {
      run((e) => {
        pluck(e, e.master, st(10), 0.16, 0.16) // G5
        pluck(e, e.master, st(17), 0.15, 0.32, 0.075) // D6
        tone(e, e.master, { type: 'sine', f0: st(29), attack: 0.004, decay: 0.25, peak: 0.025, delay: 0.075 })
      })
    },
    back() {
      run((e) => {
        tone(e, e.master, { type: 'triangle', f0: st(12), f1: st(5), glide: 0.12, attack: 0.005, decay: 0.15, peak: 0.12 })
        tone(e, e.master, { type: 'sine', f0: st(24), f1: st(17), glide: 0.12, attack: 0.004, decay: 0.07, peak: 0.02 })
      })
    },
    denied() {
      run((e) => {
        tone(e, e.master, { type: 'triangle', f0: st(-5), f1: st(-6), attack: 0.008, decay: 0.09, peak: 0.16 })
        tone(e, e.master, { type: 'triangle', f0: st(-8), f1: st(-9), attack: 0.008, decay: 0.13, peak: 0.16, delay: 0.13 })
      })
    },
  }
}

// ---------------------------------------------------------------- boxing

export function createBrightBoxingSfx(): BoxingSfx {
  let bus: GainNode | null = null
  let muted = false
  let disposed = false
  let lastWhoosh = 0

  function out(): { e: Engine; o: GainNode } | null {
    if (disposed) return null
    const e = getEngine()
    if (!e) return null
    if (!bus) {
      bus = e.ctx.createGain()
      bus.gain.value = muted ? 0 : 1
      bus.connect(e.master)
    }
    return { e, o: bus }
  }

  const run = (fn: (e: Engine, o: GainNode) => void): void => {
    if (muted) return
    const r = out()
    if (!r) return
    try {
      fn(r.e, r.o)
    } catch {
      /* never throw from a sound */
    }
  }

  function clap(e: Engine, o: GainNode, delay: number, peak: number): void {
    noiseBurst(e, o, { filter: 'bandpass', f0: 1100 + Math.random() * 900, q: 1.8, attack: 0.002, decay: 0.05 + Math.random() * 0.03, peak, delay })
  }

  function cheer(e: Engine, o: GainNode, intensity: number): void {
    const k = Math.min(1, Math.max(0, intensity))
    const len = 0.9 + 1.1 * k
    for (const m of [0.75, 1, 1.35]) {
      noiseBurst(e, o, { filter: 'bandpass', f0: 500 * m, f1: (800 + 500 * k) * m, q: 1.3, attack: 0.25 + 0.2 * k, decay: len, peak: (0.06 + 0.08 * k) / 1.6 })
    }
    const claps = Math.round(6 + 16 * k)
    for (let i = 0; i < claps; i++) clap(e, o, Math.random() * (len + 0.2), 0.05 + Math.random() * 0.07 * (0.5 + k))
  }

  function woodblock(e: Engine, o: GainNode, freq: number, peak: number, delay = 0): void {
    tone(e, o, { type: 'sine', f0: freq * 1.15, f1: freq, glide: 0.01, attack: 0.001, decay: 0.07, peak, delay })
    tone(e, o, { type: 'triangle', f0: freq * 2.7, attack: 0.001, decay: 0.03, peak: peak * 0.3, delay })
    noiseBurst(e, o, { filter: 'bandpass', f0: freq * 3, q: 4, attack: 0.001, decay: 0.015, peak: peak * 0.5, delay })
  }

  return {
    punchWhoosh() {
      run((e, o) => {
        if (e.ctx.currentTime - lastWhoosh < 0.06) return
        lastWhoosh = e.ctx.currentTime
        const up = 1 + Math.random() * 0.3
        noiseBurst(e, o, { filter: 'bandpass', f0: 380 * up, f1: 2400 * up, q: 2.2, attack: 0.06, decay: 0.12, peak: 0.22 })
        noiseBurst(e, o, { filter: 'highpass', f0: 2500, f1: 5000, q: 0.7, attack: 0.05, decay: 0.06, peak: 0.04 })
      })
    },

    hit(strength, counter) {
      run((e, o) => {
        const s = Math.min(1, Math.max(0, strength))
        const base = 150 - 50 * s
        // Soft "pomf": low sine thump with a pitch drop.
        tone(e, o, { type: 'sine', f0: base * 2.2, f1: base * 0.6, glide: 0.12, attack: 0.003, decay: 0.16 + 0.1 * s, peak: 0.3 + 0.15 * s })
        tone(e, o, { type: 'triangle', f0: base * 3.5, f1: base * 1.5, glide: 0.06, attack: 0.002, decay: 0.07, peak: 0.08 })
        noiseBurst(e, o, { filter: 'lowpass', f0: 2600, f1: 500, q: 0.8, attack: 0.002, decay: 0.08 + 0.05 * s, peak: 0.16 + 0.12 * s })
        if (counter) {
          // Sparkly high bell on top.
          for (const [n, d] of [[27, 0.03], [31, 0.08], [34, 0.13]] as const) {
            tone(e, o, { type: 'sine', f0: st(n), attack: 0.003, decay: 0.4, peak: 0.07, delay: d })
            tone(e, o, { type: 'sine', f0: st(n) * 2.76, attack: 0.002, decay: 0.15, peak: 0.02, delay: d })
          }
        }
      })
    },

    block() {
      run((e, o) => {
        // Padded thud...
        tone(e, o, { type: 'sine', f0: 210, f1: 120, glide: 0.08, attack: 0.003, decay: 0.1, peak: 0.28 })
        noiseBurst(e, o, { filter: 'lowpass', f0: 900, q: 0.7, attack: 0.002, decay: 0.06, peak: 0.12 })
        // ...plus a wood click.
        woodblock(e, o, 1250, 0.12, 0.004)
      })
    },

    playerHit() {
      run((e, o) => {
        // Boingy downward wobble.
        tone(e, o, { type: 'triangle', f0: 520, f1: 130, glide: 0.38, attack: 0.006, decay: 0.42, peak: 0.24, vib: [40, 14] })
        tone(e, o, { type: 'sine', f0: 140, f1: 70, glide: 0.12, attack: 0.003, decay: 0.14, peak: 0.25 })
        noiseBurst(e, o, { filter: 'lowpass', f0: 1500, f1: 400, q: 0.7, attack: 0.002, decay: 0.07, peak: 0.1 })
      })
    },

    telegraph() {
      run((e, o) => {
        // Short rising slide-whistle wind-up.
        tone(e, o, { type: 'sine', f0: 600, f1: 1400, glide: 0.24, attack: 0.04, decay: 0.24, peak: 0.12, vib: [12, 7] })
        noiseBurst(e, o, { filter: 'bandpass', f0: 900, f1: 2200, q: 6, attack: 0.04, decay: 0.22, peak: 0.025 })
      })
    },

    bell() {
      run((e, o) => {
        // Bright original ring: inharmonic partials, two quick strikes.
        const f = 1040
        for (const d of [0, 0.2]) {
          tone(e, o, { type: 'sine', f0: f, attack: 0.002, decay: 1.1, peak: 0.16, delay: d })
          tone(e, o, { type: 'sine', f0: f * 2.32, attack: 0.002, decay: 0.6, peak: 0.07, delay: d })
          tone(e, o, { type: 'sine', f0: f * 3.17, attack: 0.002, decay: 0.35, peak: 0.04, delay: d })
          tone(e, o, { type: 'sine', f0: f * 0.5, attack: 0.003, decay: 0.8, peak: 0.06, delay: d })
          noiseBurst(e, o, { filter: 'highpass', f0: 3000, q: 0.7, attack: 0.001, decay: 0.03, peak: 0.06, delay: d })
        }
      })
    },

    ko() {
      run((e, o) => {
        // Cheerful ascending arpeggio (C major, up two octaves) + crowd swell.
        const notes = [3, 7, 10, 15, 19, 22, 27]
        notes.forEach((n, i) => pluck(e, o, st(n), 0.15, i === notes.length - 1 ? 0.6 : 0.2, i * 0.07))
        cheer(e, o, 1)
      })
    },

    win() {
      run((e, o) => {
        // Own little major fanfare: G4 C5 E5 . G5 (held) with a soft bass.
        const seq: Array<[number, number, number]> = [
          [-2, 0, 0.14],
          [3, 0.12, 0.14],
          [7, 0.24, 0.14],
          [10, 0.4, 0.2],
          [15, 0.56, 0.7],
        ]
        for (const [n, d, len] of seq) {
          tone(e, o, { type: 'triangle', f0: st(n), attack: 0.01, decay: len, peak: 0.16, delay: d, vib: len > 0.5 ? [4, 5.5] : undefined })
          tone(e, o, { type: 'sine', f0: st(n + 12), attack: 0.006, decay: len * 0.5, peak: 0.04, delay: d })
        }
        tone(e, o, { type: 'sine', f0: st(-21), attack: 0.01, decay: 0.8, peak: 0.12, delay: 0.56 })
      })
    },

    lose() {
      run((e, o) => {
        // Gentle descending "aww": two soft sliding notes.
        tone(e, o, { type: 'triangle', f0: st(3), f1: st(2), attack: 0.04, decay: 0.3, peak: 0.13, vib: [3, 5] })
        tone(e, o, { type: 'triangle', f0: st(-1), f1: st(-4), glide: 0.6, attack: 0.05, decay: 0.65, peak: 0.13, delay: 0.32, vib: [4, 4.5] })
      })
    },

    crowdCheer(intensity = 0.6) {
      run((e, o) => cheer(e, o, intensity))
    },

    countdownTick(final = false) {
      run((e, o) => {
        if (final) {
          woodblock(e, o, 1300, 0.22)
          pluck(e, o, st(22), 0.1, 0.3, 0.01)
        } else {
          woodblock(e, o, 880, 0.2)
        }
      })
    },

    setMuted(m) {
      muted = m
      if (bus && engine) {
        const t = engine.ctx.currentTime
        bus.gain.cancelScheduledValues(t)
        bus.gain.setTargetAtTime(m ? 0 : 1, t, 0.03)
      }
    },

    dispose() {
      disposed = true
      if (bus) {
        try {
          bus.disconnect()
        } catch {
          /* already gone */
        }
        bus = null
      }
    },
  }
}
