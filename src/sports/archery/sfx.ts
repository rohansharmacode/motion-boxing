// Aero Bow sound: synthesised WebAudio (no files, original sounds). Bow creak, string twang, arrow
// whoosh, target thunk, bullseye chime, crowd cheer, wind bed. The AudioContext is created on the
// first sound (browsers block audio before a gesture). Every call is a safe no-op without WebAudio.

export interface ArcherySfx {
  /** Bow stretch creak: call every frame with tension 0..1 while drawing; 0 silences it. */
  setDraw(tension: number): void
  /** String twang + whoosh on release, power 0..1. */
  twang(power: number): void
  /** Arrow lands on the target. score 0..10; higher = brighter thunk, 10 adds a sparkling chime. */
  hit(score: number): void
  /** Arrow lands short / misses the face. */
  miss(): void
  /** Crowd cheer swell for a bullseye. */
  cheer(): void
  /** Ambient wind noise level 0..1 (0 off). */
  setWind(level: number): void
  /** Soft tick when a new arrow is nocked. */
  nock(): void
  /** Round end sting: good = rising, else gentle. */
  fanfare(good: boolean): void
  setMuted(muted: boolean): void
  /** Close the AudioContext. */
  dispose(): void
}

const MASTER = 0.8

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

export function createArcherySfx(): ArcherySfx {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let noise: AudioBuffer | null = null
  let muted = false
  let disposed = false
  let failed = false

  // Sustained draw creak: sawtooth through a resonant band-pass, plus a slow wobble.
  let drawGain: GainNode | null = null
  let drawOsc: OscillatorNode | null = null
  let drawFilter: BiquadFilterNode | null = null
  let drawLevel = 0
  // Wind bed: looped noise through a swept low-pass.
  let windGain: GainNode | null = null
  let windFilter: BiquadFilterNode | null = null
  let windLevel = 0
  const loops: AudioScheduledSourceNode[] = []

  function audio(): AudioContext | null {
    if (disposed || failed) return null
    if (!ctx) {
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctor) {
          failed = true
          return null
        }
        ctx = new Ctor()
        master = ctx.createGain()
        master.gain.value = muted ? 0 : MASTER
        master.connect(ctx.destination)
        noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
        const data = noise.getChannelData(0)
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      } catch {
        failed = true
        ctx = null
        return null
      }
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    return ctx
  }

  function env(g: GainNode, t0: number, attack: number, peak: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay)
  }

  function tone(type: OscillatorType, f0: number, f1: number, ms: number, peak: number, delay = 0): void {
    const a = audio()
    if (!a || !master) return
    try {
      const t0 = a.currentTime + delay
      const osc = a.createOscillator()
      const g = a.createGain()
      osc.type = type
      osc.frequency.setValueAtTime(f0, t0)
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + ms / 1000)
      env(g, t0, 0.004, peak, ms / 1000)
      osc.connect(g).connect(master)
      osc.start(t0)
      osc.stop(t0 + ms / 1000 + 0.05)
    } catch {
      // Ignore audio graph errors.
    }
  }

  /** Filtered noise burst, optional filter sweep to f1. */
  function hiss(type: BiquadFilterType, f0: number, f1: number, q: number, attack: number, decay: number, peak: number, delay = 0): void {
    const a = audio()
    if (!a || !master || !noise) return
    try {
      const t0 = a.currentTime + delay
      const src = a.createBufferSource()
      src.buffer = noise
      src.loop = true
      const f = a.createBiquadFilter()
      f.type = type
      f.Q.value = q
      f.frequency.setValueAtTime(f0, t0)
      f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + attack + decay)
      const g = a.createGain()
      env(g, t0, attack, peak, decay)
      src.connect(f).connect(g).connect(master)
      src.start(t0, Math.random())
      src.stop(t0 + attack + decay + 0.05)
    } catch {
      // Ignore audio graph errors.
    }
  }

  function ensureDraw(a: AudioContext): void {
    if (drawGain || !master) return
    drawOsc = a.createOscillator()
    drawOsc.type = 'sawtooth'
    drawOsc.frequency.value = 70
    const lfo = a.createOscillator()
    lfo.frequency.value = 11
    const lfoDepth = a.createGain()
    lfoDepth.gain.value = 6
    lfo.connect(lfoDepth).connect(drawOsc.frequency)
    drawFilter = a.createBiquadFilter()
    drawFilter.type = 'bandpass'
    drawFilter.frequency.value = 600
    drawFilter.Q.value = 6
    drawGain = a.createGain()
    drawGain.gain.value = 0
    drawOsc.connect(drawFilter).connect(drawGain).connect(master)
    drawOsc.start()
    lfo.start()
    loops.push(drawOsc, lfo)
  }

  function ensureWind(a: AudioContext): void {
    if (windGain || !master || !noise) return
    const src = a.createBufferSource()
    src.buffer = noise
    src.loop = true
    windFilter = a.createBiquadFilter()
    windFilter.type = 'lowpass'
    windFilter.frequency.value = 400
    windFilter.Q.value = 1.2
    // Slow gusting on the filter.
    const lfo = a.createOscillator()
    lfo.frequency.value = 0.23
    const lfoDepth = a.createGain()
    lfoDepth.gain.value = 180
    lfo.connect(lfoDepth).connect(windFilter.frequency)
    windGain = a.createGain()
    windGain.gain.value = 0
    src.connect(windFilter).connect(windGain).connect(master)
    src.start()
    lfo.start()
    loops.push(src, lfo)
  }

  /** Crowd voice swell: several band-passed noise layers with a rising centre. */
  function crowd(fromHz: number, toHz: number, attack: number, decay: number, peak: number, delay = 0): void {
    const a = audio()
    if (!a || !master || !noise) return
    for (const detune of [0.75, 1, 1.35]) {
      hiss('bandpass', fromHz * detune, toHz * detune, 1.3, attack, decay, peak / 3, delay)
    }
  }

  return {
    setDraw(tension) {
      const t = clamp01(tension)
      // Cheap per-frame path: nothing to do while silent and already silent.
      if (t <= 0.001 && drawLevel <= 0.001) return
      const a = t > 0 ? audio() : ctx
      if (!a || disposed) return
      try {
        ensureDraw(a)
        if (!drawGain || !drawOsc || !drawFilter) return
        const now = a.currentTime
        drawLevel = t
        drawGain.gain.setTargetAtTime(t > 0.001 ? 0.012 + 0.03 * t : 0, now, t > 0.001 ? 0.05 : 0.03)
        drawOsc.frequency.setTargetAtTime(60 + 55 * t, now, 0.06)
        drawFilter.frequency.setTargetAtTime(500 + 900 * t, now, 0.06)
        if (t <= 0.001) drawLevel = 0
      } catch {
        // Ignore audio graph errors.
      }
    },

    twang(power) {
      const p = Math.max(0.25, clamp01(power))
      // Silence the creak at once.
      if (drawGain && ctx) drawGain.gain.setTargetAtTime(0, ctx.currentTime, 0.01)
      drawLevel = 0
      // String: plucked low triangle with a fast pitch drop plus a short buzzy overtone.
      tone('triangle', 260 + 90 * p, 110, 260, 0.28 * p)
      tone('square', 520 + 160 * p, 300, 70, 0.05 * p)
      // Whoosh: band-passed noise sweeping down as the arrow leaves.
      hiss('bandpass', 2600, 700, 1.1, 0.02, 0.32, 0.16 * p, 0.02)
    },

    hit(score) {
      const s = Math.min(10, Math.max(0, Math.round(Number.isFinite(score) ? score : 0)))
      const b = s / 10
      // Thunk: body tone higher and tighter for better rings, plus a straw-boss crunch.
      tone('sine', 140 + 120 * b, 55 + 40 * b, 150 - 40 * b, 0.42)
      hiss('lowpass', 900 + 2600 * b, 400, 0.8, 0.002, 0.09, 0.22)
      if (s >= 8) tone('triangle', 660 + 220 * b, 660 + 220 * b, 160, 0.05)
      if (s === 10) {
        // Sparkling chime: quick rising arpeggio with a shimmer tail.
        const notes = [1319, 1568, 1976, 2637]
        notes.forEach((f, i) => tone('sine', f, f, 380, 0.07, 0.06 + i * 0.07))
        hiss('highpass', 7000, 9000, 0.7, 0.05, 0.6, 0.03, 0.08)
      }
    },

    miss() {
      // Dull thud into turf and a soft low drop.
      tone('sine', 95, 45, 180, 0.3)
      hiss('lowpass', 600, 200, 0.7, 0.004, 0.16, 0.16)
      tone('triangle', 330, 220, 260, 0.04, 0.12)
    },

    cheer() {
      crowd(480, 950, 0.18, 1.8, 0.4)
      // A few claps scattered on top.
      for (let i = 0; i < 8; i++) hiss('bandpass', 1800, 1500, 2, 0.002, 0.04, 0.05, 0.25 + Math.random() * 1.1)
    },

    setWind(level) {
      const l = clamp01(level)
      if (l <= 0.001 && windLevel <= 0.001) return
      const a = l > 0 ? audio() : ctx
      if (!a || disposed) return
      try {
        ensureWind(a)
        if (!windGain || !windFilter) return
        const now = a.currentTime
        windLevel = l
        windGain.gain.setTargetAtTime(l > 0.001 ? 0.03 + 0.07 * l : 0, now, 0.4)
        windFilter.frequency.setTargetAtTime(300 + 700 * l, now, 0.4)
        if (l <= 0.001) windLevel = 0
      } catch {
        // Ignore audio graph errors.
      }
    },

    nock() {
      tone('sine', 1800, 1200, 35, 0.06)
      hiss('highpass', 4000, 3000, 0.8, 0.001, 0.03, 0.04)
    },

    fanfare(good) {
      if (good) {
        const notes = [523, 659, 784, 1047]
        notes.forEach((f, i) => tone('triangle', f, f, 240, 0.08, i * 0.14))
        tone('sine', 1047, 1047, 700, 0.05, notes.length * 0.14)
        crowd(500, 950, 0.3, 2, 0.32, 0.2)
      } else {
        const notes = [440, 392, 349]
        notes.forEach((f, i) => tone('sine', f, f, 320, 0.06, i * 0.2))
      }
    },

    setMuted(m) {
      muted = m
      if (ctx && master) {
        try {
          master.gain.setTargetAtTime(m ? 0 : MASTER, ctx.currentTime, 0.05)
        } catch {
          // Ignore.
        }
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const n of loops) {
        try {
          n.stop()
        } catch {
          // Already stopped.
        }
      }
      loops.length = 0
      drawGain = null
      windGain = null
      if (ctx) void ctx.close().catch(() => undefined)
      ctx = null
      master = null
    },
  }
}
