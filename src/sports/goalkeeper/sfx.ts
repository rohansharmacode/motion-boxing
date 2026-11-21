// Reflex Keeper sound: synthesised WebAudio (no files, original sounds). Crowd bed, referee whistle,
// kick thump, glove smack, net swish, crowd roar and groan. UI clicks reuse the shell's createSfx.
// Every call is a no-op until the first user gesture has unlocked audio (browsers block it before).

export interface KeeperSfx {
  /** Start the low crowd murmur (call after a click / key press). */
  startCrowd(): void
  /** Crowd tension while the striker runs up: 0 calm, 1 peak. */
  setTension(level: number): void
  whistle(): void
  kick(power: number): void
  /** Glove or body contact; punch adds a sharper crack. */
  save(punch: boolean): void
  /** Ball hits the net. */
  net(): void
  /** Big home-crowd cheer (save). intensity 1 = normal, up to 1.6 for a perfect or sudden-death save. */
  roar(intensity?: number): void
  /** Disappointed crowd (goal). */
  groan(): void
  /** Save-grade sting: perfect = bright rising chime, good = two notes, fingertip = soft tick. Combo lifts the pitch. */
  grade(grade: 'perfect' | 'good' | 'fingertip', combo: number): void
  /** Kickoff countdown beep: steps 0..2 are the 3-2-1 blips, the last step is the higher GO tone. */
  countdown(step: number, last: boolean): void
  /** End-of-shootout fanfare, good = more saves than goals. */
  fullTime(good: boolean): void
  setMuted(muted: boolean): void
  dispose(): void
}

export function createKeeperSfx(): KeeperSfx {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let noise: AudioBuffer | null = null
  let crowdGain: GainNode | null = null
  let crowdFilter: BiquadFilterNode | null = null
  let crowdSrc: AudioBufferSourceNode | null = null
  let muted = false
  let disposed = false

  function audio(): AudioContext | null {
    if (disposed) return null
    if (!ctx) {
      try {
        ctx = new AudioContext()
      } catch {
        return null
      }
      master = ctx.createGain()
      master.gain.value = muted ? 0 : 0.8
      master.connect(ctx.destination)
      // 2 s of white noise, reused by every noisy sound.
      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
      const data = noise.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }

  function env(g: GainNode, t0: number, attack: number, peak: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay)
  }

  function tone(type: OscillatorType, f0: number, f1: number, ms: number, peak: number, delay = 0): void {
    const a = audio()
    if (!a || !master) return
    const t0 = a.currentTime + delay
    const osc = a.createOscillator()
    const g = a.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(f0, t0)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + ms / 1000)
    env(g, t0, 0.005, peak, ms / 1000)
    osc.connect(g).connect(master)
    osc.start(t0)
    osc.stop(t0 + ms / 1000 + 0.05)
  }

  /** Filtered noise burst. */
  function hiss(type: BiquadFilterType, freq: number, q: number, attack: number, decay: number, peak: number, delay = 0): void {
    const a = audio()
    if (!a || !master || !noise) return
    const t0 = a.currentTime + delay
    const src = a.createBufferSource()
    src.buffer = noise
    src.loop = true
    const f = a.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    const g = a.createGain()
    env(g, t0, attack, peak, decay)
    src.connect(f).connect(g).connect(master)
    src.start(t0, Math.random())
    src.stop(t0 + attack + decay + 0.05)
  }

  /** Crowd voice swell: band-passed noise with a moving centre, sounds like many voices. */
  function crowdSwell(fromHz: number, toHz: number, attack: number, decay: number, peak: number): void {
    const a = audio()
    if (!a || !master || !noise) return
    const t0 = a.currentTime
    for (const detune of [0.8, 1, 1.3]) {
      const src = a.createBufferSource()
      src.buffer = noise
      src.loop = true
      const f = a.createBiquadFilter()
      f.type = 'bandpass'
      f.Q.value = 1.4
      f.frequency.setValueAtTime(fromHz * detune, t0)
      f.frequency.exponentialRampToValueAtTime(toHz * detune, t0 + attack + decay * 0.6)
      const g = a.createGain()
      env(g, t0, attack, peak / 3, decay)
      src.connect(f).connect(g).connect(master)
      src.start(t0, Math.random())
      src.stop(t0 + attack + decay + 0.05)
    }
  }

  return {
    startCrowd() {
      const a = audio()
      if (!a || !master || !noise || crowdSrc) return
      crowdSrc = a.createBufferSource()
      crowdSrc.buffer = noise
      crowdSrc.loop = true
      crowdFilter = a.createBiquadFilter()
      crowdFilter.type = 'bandpass'
      crowdFilter.frequency.value = 520
      crowdFilter.Q.value = 0.7
      crowdGain = a.createGain()
      crowdGain.gain.value = 0.0001
      crowdGain.gain.exponentialRampToValueAtTime(0.05, a.currentTime + 1.2)
      crowdSrc.connect(crowdFilter).connect(crowdGain).connect(master)
      crowdSrc.start()
    },

    setTension(level) {
      if (!ctx || !crowdGain || !crowdFilter) return
      const l = Math.min(1, Math.max(0, level))
      const t = ctx.currentTime
      crowdGain.gain.setTargetAtTime(0.05 + 0.07 * l, t, 0.25)
      crowdFilter.frequency.setTargetAtTime(520 + 380 * l, t, 0.25)
    },

    whistle() {
      // Pea whistle: high square-ish tone with fast warble, two short blasts.
      const a = audio()
      if (!a || !master) return
      for (const [delay, ms] of [
        [0, 0.16],
        [0.22, 0.42],
      ] as const) {
        const t0 = a.currentTime + delay
        const osc = a.createOscillator()
        const lfo = a.createOscillator()
        const lfoGain = a.createGain()
        const g = a.createGain()
        osc.type = 'triangle'
        osc.frequency.value = 2900
        lfo.frequency.value = 32
        lfoGain.gain.value = 140
        lfo.connect(lfoGain).connect(osc.frequency)
        g.gain.setValueAtTime(0.0001, t0)
        g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.015)
        g.gain.setValueAtTime(0.09, t0 + ms - 0.03)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms)
        osc.connect(g).connect(master)
        osc.start(t0)
        lfo.start(t0)
        osc.stop(t0 + ms + 0.02)
        lfo.stop(t0 + ms + 0.02)
      }
    },

    kick(power) {
      const p = Math.min(1, Math.max(0.3, power))
      tone('sine', 150, 45, 160, 0.5 * p)
      hiss('lowpass', 1800, 0.7, 0.002, 0.06, 0.25 * p)
    },

    save(punch) {
      tone('sine', 220, 70, 120, 0.45)
      hiss('bandpass', 1400, 1.2, 0.002, 0.09, 0.35)
      if (punch) hiss('highpass', 3200, 0.8, 0.001, 0.05, 0.3)
    },

    grade(grade, combo) {
      const lift = Math.pow(2, Math.min(6, Math.max(0, combo - 1)) / 12) // up a semitone per combo step
      if (grade === 'perfect') {
        ;[784, 988, 1175, 1568].forEach((f, i) => tone('triangle', f * lift, f * lift, 140, 0.11, i * 0.055))
        hiss('highpass', 6000, 0.7, 0.002, 0.25, 0.06, 0.05)
      } else if (grade === 'good') {
        tone('triangle', 659 * lift, 659 * lift, 120, 0.1)
        tone('triangle', 880 * lift, 880 * lift, 160, 0.1, 0.07)
      } else {
        tone('sine', 520 * lift, 380 * lift, 90, 0.08)
      }
    },

    net() {
      hiss('bandpass', 2600, 0.9, 0.02, 0.35, 0.18)
      tone('sine', 110, 60, 180, 0.2)
    },

    roar(intensity = 1) {
      const k = Math.min(1.6, Math.max(0.5, intensity))
      crowdSwell(500 * (0.9 + 0.1 * k), 900 * (0.9 + 0.1 * k), 0.12, 1.3 + 0.5 * k, 0.5 * k)
    },

    countdown(step, last) {
      if (last) tone('square', 880, 880, 260, 0.07)
      else tone('square', 440, 440, 110, 0.06 + 0.005 * step)
    },

    groan() {
      crowdSwell(600, 260, 0.08, 1.1, 0.32)
    },

    fullTime(good) {
      // Three-blast full-time whistle, then a short tune.
      this.whistle()
      const notes = good ? [523, 659, 784, 1047] : [392, 349, 311]
      notes.forEach((f, i) => tone('triangle', f, f, 220, 0.08, 0.8 + i * 0.16))
      if (good) crowdSwell(500, 950, 0.3, 2.2, 0.45)
      else crowdSwell(600, 240, 0.1, 1.4, 0.3) // full-time groan
    },

    setMuted(m) {
      muted = m
      if (ctx && master) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.05)
    },

    dispose() {
      if (disposed) return
      disposed = true
      try {
        crowdSrc?.stop()
      } catch {
        // Already stopped.
      }
      crowdSrc = null
      void ctx?.close()
      ctx = null
    },
  }
}
