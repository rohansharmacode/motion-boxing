// Neon Lanes bowling for the shell: startBowling(ctx) builds the game inside ctx.host.
// Camera: swing your arm forward and up like an underarm bowl; swing speed sets ball speed, sideways
// drift of the wrist sets the angle, stepping left/right moves the start spot.
// Mouse: drag up on the lane and let go. Keyboard: arrows aim, Space bowls.
import * as THREE from 'three'
import { startPosePipeline } from '../../pose/pipeline.ts'
import type { PosePipeline } from '../../pose/pipeline.ts'
import { createCalibrator } from '../../pose/calibration.ts'
import { createBodyTracker } from '../../pose/body.ts'
import type { BodyTracker } from '../../pose/body.ts'
import { LM, StartupError } from '../../pose/types.ts'
import type { BodyFrame } from '../../pose/types.ts'
import type { GameContext, GameSession } from '../../shell/types.ts'
import { createSfx } from '../../shell/sfx.ts'
import type { Sfx } from '../../shell/sfx.ts'
import {
  BALL_R,
  FRAMES,
  GUTTER_HALF,
  HEAD_PIN_Z,
  LANE_HALF,
  frameMarks,
  frameTotals,
  laneSettled,
  makePins,
  rackPins,
  recordRoll,
  stepLane,
} from './game.ts'
import type { Ball, Frames } from './game.ts'
import './bowling.css'

const CYAN = 0x22e5ff
const PINK = 0xff2e88
const DARK = 0x070a17
const STEP = 1 / 240
const LANE_START = 1.2
const LANE_END = -20.2

// Desk-safe pendulum swing (GDD 4.2). Body units are shoulder widths (SW), y down.
/** Wrist this far below the shoulder line, held still, arms the swing. */
const ARM_BELOW_SW = 0.35
/** Arming hold: wrist slower than this (SW/s) for ARM_HOLD_MS. */
const ARM_STILL_SW = 1.0
const ARM_HOLD_MS = 100
/** Release: upward speed above this (SW/s) while crossing this line below the shoulders. */
const RELEASE_VY_SW = 1.8
const RELEASE_BELOW_SW = 0.15
/** Ball speed from peak swing speed, m/s. */
const speedFromSwing = (peak: number): number => Math.max(5.2, Math.min(10.2, 4.8 + peak * 1.45))
/** Release angle clamp, degrees. */
const MAX_ANGLE = 8
/** Approach width the torso can slide the ball across, m. */
const ALIGN_HALF = 0.45

let uiSfx: Sfx | null = null

interface Throw {
  /** m/s down the lane. */
  speed: number
  /** Degrees, + to the right. */
  angle: number
}

export async function startBowling(ctx: GameContext): Promise<GameSession> {
  if (ctx.signal.aborted) return { dispose() {} }
  uiSfx ??= createSfx()

  // ---------- DOM ----------
  const root = document.createElement('div')
  root.className = 'bw-root'
  root.innerHTML = `
    <div class="bw-stage"></div>
    <video class="bw-cam" playsinline muted></video>
    <div class="bw-top">
      <div class="bw-title">NEON LANES</div>
      <div class="bw-board"></div>
    </div>
    <div class="bw-left">
      <div class="bw-pins"></div>
      <div class="bw-state">ALIGN</div>
      <div class="bw-speed"></div>
    </div>
    <div class="bw-hint"></div>
    <div class="bw-callout"></div>
    <div class="bw-card"></div>`
  ctx.host.append(root)
  const q = <T extends HTMLElement>(s: string): T => root.querySelector(s) as T
  const stageEl = q<HTMLDivElement>('.bw-stage')
  const video = q<HTMLVideoElement>('.bw-cam')
  video.muted = true
  const boardEl = q<HTMLDivElement>('.bw-board')
  const pinsEl = q<HTMLDivElement>('.bw-pins')
  const stateEl = q<HTMLDivElement>('.bw-state')
  const speedEl = q<HTMLDivElement>('.bw-speed')
  const hintEl = q<HTMLDivElement>('.bw-hint')
  const calloutEl = q<HTMLDivElement>('.bw-callout')
  const cardEl = q<HTMLDivElement>('.bw-card')

  // ---------- scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  stageEl.append(renderer.domElement)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(DARK)
  scene.fog = new THREE.Fog(DARK, 14, 34)
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 80)
  scene.add(new THREE.HemisphereLight(0x8fb6ff, 0x120a24, 0.9))
  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(1.5, 6, 2)
  scene.add(key)
  const deckLight = new THREE.PointLight(PINK, 1.6, 4, 1.5)
  deckLight.position.set(0, 1.2, HEAD_PIN_Z - 1.2)
  scene.add(deckLight)

  const disposables: { dispose(): void }[] = []
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x)
    return x
  }
  const laneLen = LANE_START - LANE_END
  const laneMid = (LANE_START + LANE_END) / 2
  // Lane: dark lacquer with a canvas texture of boards, arrows and dots.
  const tex = track(new THREE.CanvasTexture(laneCanvas()))
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const lane = new THREE.Mesh(
    track(new THREE.PlaneGeometry(LANE_HALF * 2, laneLen)),
    track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.1 })),
  )
  lane.rotation.x = -Math.PI / 2
  lane.position.z = laneMid
  scene.add(lane)
  const gutterMat = track(new THREE.MeshStandardMaterial({ color: 0x0d1230, roughness: 0.6 }))
  const gutterGeo = track(new THREE.PlaneGeometry(GUTTER_HALF - LANE_HALF, laneLen))
  for (const s of [-1, 1]) {
    const g = new THREE.Mesh(gutterGeo, gutterMat)
    g.rotation.x = -Math.PI / 2
    g.position.set(s * (LANE_HALF + (GUTTER_HALF - LANE_HALF) / 2), -0.04, laneMid)
    scene.add(g)
  }
  // Neon rails along both edges and both gutters.
  const railGeo = track(new THREE.BoxGeometry(0.025, 0.025, laneLen))
  const cyanMat = track(new THREE.MeshBasicMaterial({ color: CYAN }))
  const pinkMat = track(new THREE.MeshBasicMaterial({ color: PINK }))
  for (const s of [-1, 1]) {
    const inner = new THREE.Mesh(railGeo, cyanMat)
    inner.position.set(s * LANE_HALF, 0.005, laneMid)
    const outer = new THREE.Mesh(railGeo, pinkMat)
    outer.position.set(s * (GUTTER_HALF + 0.02), 0.06, laneMid)
    scene.add(inner, outer)
  }
  // Foul line.
  const foul = new THREE.Mesh(track(new THREE.BoxGeometry(LANE_HALF * 2, 0.01, 0.03)), pinkMat)
  foul.position.set(0, 0.005, 0)
  scene.add(foul)
  // Back wall: masking panel with a neon frame and a grid.
  const wallZ = LANE_END - 0.2
  const wall = new THREE.Mesh(track(new THREE.PlaneGeometry(8, 3.4)), track(new THREE.MeshBasicMaterial({ color: 0x0b0f26 })))
  wall.position.set(0, 1.3, wallZ)
  scene.add(wall)
  const grid = new THREE.GridHelper(8, 16, PINK, 0x3a1d5c)
  grid.rotation.x = Math.PI / 2
  grid.position.set(0, 1.3, wallZ + 0.01)
  ;(grid.material as THREE.Material).transparent = true
  ;(grid.material as THREE.Material).opacity = 0.35
  scene.add(grid)
  track(grid.geometry)
  const frameBar = track(new THREE.BoxGeometry(2.2, 0.05, 0.05))
  for (const y of [0.9, 1.75]) {
    const b = new THREE.Mesh(frameBar, y > 1 ? cyanMat : pinkMat)
    b.position.set(0, y, wallZ + 0.05)
    scene.add(b)
  }
  // Pins: lathe profile, white body with a pink neck band.
  const pinPts = [
    [0, 0], [0.03, 0], [0.05, 0.05], [0.06, 0.13], [0.055, 0.2], [0.03, 0.26], [0.022, 0.29], [0.028, 0.33], [0.032, 0.36], [0.02, 0.38], [0, 0.385],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  const pinGeo = track(new THREE.LatheGeometry(pinPts, 14))
  const pinMat = track(new THREE.MeshStandardMaterial({ color: 0xf4f6ff, roughness: 0.3, emissive: 0x222844 }))
  const bandGeo = track(new THREE.CylinderGeometry(0.024, 0.026, 0.02, 14, 1, true))
  const bandMat = track(new THREE.MeshBasicMaterial({ color: PINK, side: THREE.DoubleSide }))
  const pins = makePins()
  // Pin-leave diagram, back row on top like the deck seen from the approach.
  pinsEl.innerHTML = pins
    .map((p, i) => `<i data-pin="${i + 1}" style="left:${50 + (p.home.x / 0.305) * 24}%;top:${(3 - Math.round((HEAD_PIN_Z - p.home.z) / 0.264)) * 26}%"></i>`)
    .join('')
  const pinMeshes = pins.map(() => {
    const g = new THREE.Group()
    g.add(new THREE.Mesh(pinGeo, pinMat))
    const band = new THREE.Mesh(bandGeo, bandMat)
    band.position.y = 0.275
    g.add(band)
    scene.add(g)
    return g
  })

  // Ball: glossy dark sphere with cyan glow ring.
  const ballGroup = new THREE.Group()
  const ballMesh = new THREE.Mesh(
    track(new THREE.SphereGeometry(BALL_R, 28, 20)),
    track(new THREE.MeshStandardMaterial({ color: 0x1b2bff, emissive: 0x0a3a66, roughness: 0.15, metalness: 0.3 })),
  )
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(BALL_R * 1.01, 0.008, 6, 32)), cyanMat)
  ballMesh.add(ring)
  ballGroup.add(ballMesh)
  const ballMat = ballMesh.material as THREE.MeshStandardMaterial
  /** Armed swing: the ball glows cyan. */
  const ballGlow = (on: boolean): void => {
    ballMat.emissive.setHex(on ? CYAN : 0x0a3a66)
    ballMat.emissiveIntensity = on ? 0.8 : 1
  }
  scene.add(ballGroup)
  // Aim guide: a dotted line ahead of the ball.
  const guideGeo = track(new THREE.BufferGeometry())
  guideGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 24), 3))
  const guide = new THREE.Points(guideGeo, track(new THREE.PointsMaterial({ color: CYAN, size: 0.05, transparent: true, opacity: 0.8 })))
  scene.add(guide)

  // ---------- state ----------
  const ball: Ball = { x: 0, z: -0.5, vx: 0, vz: 0, hook: 0, gutter: false, rolling: false }
  let frames: Frames = []
  let rackBalls = 0
  let rackStanding = 10
  let phase: 'menu' | 'calib' | 'ready' | 'rolling' | 'settle' | 'over' = 'menu'
  let settleT = 0
  let startX = 0
  let aimKey = 0
  let strikeRun = 0
  let disposed = false
  let pipeline: PosePipeline | null = null
  let ownsPipeline = false
  let unsubscribe: (() => void) | null = null
  let tracker: BodyTracker | null = null
  let mode: 'camera' | 'mouse' = 'mouse'
  const timers = new Set<number>()
  const later = (ms: number, fn: () => void): void => {
    const id = window.setTimeout(() => {
      timers.delete(id)
      if (!disposed) fn()
    }, ms)
    timers.add(id)
  }

  // ---------- audio (tiny synth) ----------
  let ac: AudioContext | null = null
  const audio = (): AudioContext | null => {
    try {
      ac ??= new AudioContext()
      return ac
    } catch {
      return null
    }
  }
  function noise(dur: number, freq: number, gain: number): void {
    const a = audio()
    if (!a) return
    const len = Math.floor(a.sampleRate * dur)
    const buf = a.createBuffer(1, len, a.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2
    const src = a.createBufferSource()
    src.buffer = buf
    const f = a.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = freq
    const g = a.createGain()
    g.gain.value = gain
    src.connect(f).connect(g).connect(a.destination)
    src.start()
  }
  function blip(freqs: number[], step = 0.09): void {
    const a = audio()
    if (!a) return
    freqs.forEach((fq, i) => {
      const o = a.createOscillator()
      o.type = 'square'
      o.frequency.value = fq
      const g = a.createGain()
      const t = a.currentTime + i * step
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, t + step * 1.6)
      o.connect(g).connect(a.destination)
      o.start(t)
      o.stop(t + step * 2)
    })
  }

  // ---------- HUD ----------
  function renderBoard(): void {
    const totals = frameTotals(frames)
    let html = ''
    for (let f = 0; f < FRAMES; f++) {
      const marks = frameMarks(frames[f], f === FRAMES - 1)
      const slots = f === FRAMES - 1 ? 3 : 2
      const cells = Array.from({ length: slots }, (_, i) => {
        const m = marks[i] ?? ''
        return `<span class="${m === 'X' ? 'bw-x' : m === '/' ? 'bw-sp' : ''}">${m}</span>`
      }).join('')
      const cur = phase !== 'over' && f === Math.min(currentFrame(), FRAMES - 1) ? ' bw-cur' : ''
      html += `<div class="bw-frame${cur}"><div class="bw-fn">${f + 1}</div><div class="bw-rolls">${cells}</div><div class="bw-ft">${totals[f] ?? ''}</div></div>`
    }
    const total = [...totals].reverse().find((t) => t !== null) ?? 0
    html += `<div class="bw-frame bw-total"><div class="bw-fn">TOTAL</div><div class="bw-ft">${total}</div></div>`
    boardEl.innerHTML = html
  }
  /** Pin-leave diagram: standing pins lit, downed pins dark. */
  function renderPins(): void {
    // pins[] order is rows front to back: 1 | 2 3 | 4 5 6 | 7 8 9 10
    pins.forEach((p, i) => {
      const el = pinsEl.querySelector(`[data-pin="${i + 1}"]`) as HTMLElement | null
      if (el) el.classList.toggle('bw-down', !p.live || p.down)
    })
  }
  function currentFrame(): number {
    const last = frames.length - 1
    if (last < 0) return 0
    const r = frames[last]
    const done = last < FRAMES - 1 ? r[0] === 10 || r.length === 2 : false
    return done ? last + 1 : last
  }
  let calloutTimer = 0
  function callout(text: string, tone: 'big' | 'info' | 'bad' | 'amber' = 'big'): void {
    calloutEl.textContent = text
    calloutEl.className = `bw-callout bw-${tone}`
    void calloutEl.offsetWidth
    calloutEl.classList.add('bw-show')
    window.clearTimeout(calloutTimer)
    calloutTimer = window.setTimeout(() => calloutEl.classList.remove('bw-show'), 1400)
  }
  function hint(): void {
    hintEl.textContent =
      phase === 'ready'
        ? mode === 'camera'
          ? 'Hold your hand at waist height until the ball glows, then swing up in front of your chest. Lean left or right to line up.'
          : 'Drag up on the lane and let go. Or ← → to aim and Space to bowl.'
        : ''
  }
  function showCard(html: string, buttons: { label: string; cls?: string; fn: () => void }[]): void {
    cardEl.innerHTML = `<div class="bw-card-in">${html}<div class="bw-btns"></div></div>`
    const wrap = cardEl.querySelector('.bw-btns') as HTMLElement
    for (const b of buttons) {
      const el = document.createElement('button')
      el.className = `bw-btn ${b.cls ?? ''}`
      el.textContent = b.label
      el.addEventListener('click', () => {
        uiSfx?.select()
        b.fn()
      })
      wrap.append(el)
    }
    cardEl.classList.add('bw-open')
  }
  const hideCard = (): void => cardEl.classList.remove('bw-open')

  // ---------- game flow ----------
  function newGame(): void {
    frames = []
    rackBalls = 0
    rackStanding = 10
    rackPins(pins, true)
    hideCard()
    readyBall()
    renderBoard()
    callout('FRAME 1', 'info')
  }
  function readyBall(): void {
    ball.x = startX
    ball.z = -0.5
    ball.vx = ball.vz = ball.hook = 0
    ball.gutter = false
    ball.rolling = false
    phase = 'ready'
    setState('ALIGN')
    renderPins()
    hint()
  }
  function bowl(t: Throw): void {
    if (phase !== 'ready') return
    const speed = Math.max(5.2, Math.min(10.2, t.speed))
    const ang = (Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, t.angle)) * Math.PI) / 180
    const p = (speed - 5.2) / 5
    ball.vz = -speed * Math.cos(ang)
    ball.vx = speed * Math.sin(ang) * 0.55
    ball.hook = -Math.sin(ang) * 0.5 // dry back end pulls it back toward the pocket
    speedEl.textContent = `${Math.round(speed * 3.6)} KM/H · ${Math.abs(t.angle) < 1 ? 'STRAIGHT' : `${t.angle < 0 ? 'L' : 'R'} ${Math.abs(Math.round(t.angle))}°`}`
    setState('ROLLING')
    ball.rolling = true
    phase = 'rolling'
    settleT = 0
    hint()
    noise(0.35, 300, 0.4)
    blip([220 + p * 200], 0.05)
  }
  function finishRoll(): void {
    const knocked = pins.filter((p) => p.live && p.down).length
    const res = recordRoll(frames, knocked, rackBalls, rackStanding, ball.gutter)
    renderBoard()
    renderPins()
    strikeRun = res.kind === 'strike' ? strikeRun + 1 : 0
    if (res.kind === 'strike' && strikeRun >= 3) {
      callout(`TURKEY! ${strikeRun}X`, 'amber')
      blip([659, 831, 988, 1319, 988, 1319], 0.1)
    } else if (res.kind === 'strike') {
      callout('STRIKE!')
      blip([659, 831, 988, 1319], 0.12)
    } else if (res.kind === 'spare') {
      callout('SPARE!', 'amber')
      blip([523, 784, 1047])
    } else if (res.kind === 'gutter') {
      callout('GUTTER', 'bad')
      blip([260, 130, 92], 0.14)
    } else callout(`+${knocked} PIN${knocked === 1 ? '' : 'S'}`, 'info')
    phase = 'settle'
    later(1300, () => {
      if (res.gameOver) return gameOver()
      if (res.resetPins) {
        rackPins(pins, true)
        rackBalls = 0
        rackStanding = 10
      } else {
        rackPins(pins, false)
        rackBalls++
        rackStanding -= knocked
      }
      readyBall()
      const f = currentFrame()
      if (res.resetPins && frames[f] === undefined) callout(f === FRAMES - 1 ? 'FINAL FRAME' : `FRAME ${f + 1}`, 'info')
    })
  }
  function gameOver(): void {
    phase = 'over'
    hint()
    renderBoard()
    const totals = frameTotals(frames)
    const total = totals[FRAMES - 1] ?? 0
    const strikes = frames.flat().filter((v) => v === 10).length
    const rating = total >= 105 ? 'LASER TOUR MASTER' : total >= 80 ? 'SYNTH SPORT PRO' : total >= 55 ? 'NEON HOUSE CHAMP' : 'KEEP ROLLING'
    blip([392, 523, 659, 784, 1047], 0.12)
    showCard(
      `<div class="bw-kicker">GAME OVER</div><div class="bw-big">${total}</div><div class="bw-sub">${rating} · ${strikes} strike${strikes === 1 ? '' : 's'}</div>`,
      [
        { label: 'Play again', cls: 'bw-primary', fn: newGame },
        { label: 'Home', fn: () => ctx.exit() },
      ],
    )
  }

  // ---------- camera ----------
  type WristState = { x: number; y: number; t: number; stillSince: number }
  const wrists: Record<'left' | 'right', WristState | null> = { left: null, right: null }
  let armed: 'left' | 'right' | null = null
  let peak = 0
  function onBody(b: BodyFrame): void {
    const ls = b.body[LM.L_SHOULDER]
    const rs = b.body[LM.R_SHOULDER]
    const sY = (ls.y + rs.y) / 2
    const cX = (ls.x + rs.x) / 2
    // Align: torso slides the ball (+-0.65 SW -> +-0.45 m); locked once a swing is armed.
    if (phase === 'ready' && !armed && ls.visibility > 0.5 && rs.visibility > 0.5)
      startX = Math.max(-ALIGN_HALF, Math.min(ALIGN_HALF, (cX / 0.65) * ALIGN_HALF))
    for (const side of ['left', 'right'] as const) {
      const w = b.body[side === 'left' ? LM.L_WRIST : LM.R_WRIST]
      const prev = wrists[side]
      if (w.visibility < 0.5) {
        wrists[side] = null
        if (armed === side) disarm()
        continue
      }
      const st: WristState = { x: w.x, y: w.y, t: b.t, stillSince: prev?.stillSince ?? b.t }
      wrists[side] = st
      if (!prev) continue
      const dt = (b.t - prev.t) / 1000
      if (dt <= 0 || dt > 0.2) continue
      const vx = (w.x - prev.x) / dt
      const vy = (w.y - prev.y) / dt
      if (Math.hypot(vx, vy) > ARM_STILL_SW) st.stillSince = b.t
      if (phase !== 'ready') {
        if (armed) disarm()
        continue
      }
      // Arm: wrist below the shoulder line (desk-safe, chest to waist) and held still briefly.
      if (!armed && w.y > sY + ARM_BELOW_SW && b.t - st.stillSince >= ARM_HOLD_MS) {
        armed = side
        peak = 0
        setState('SWING ARMED')
        blip([880], 0.04)
      }
      if (armed !== side) continue
      if (-vy > peak) peak = -vy
      if (vy < -RELEASE_VY_SW && w.y <= sY + RELEASE_BELOW_SW) {
        const angle = (Math.atan2(vx, -vy) * 180) / Math.PI
        armed = null
        bowl({ speed: speedFromSwing(peak), angle })
      } else if (w.y < sY - 0.3) disarm() // hand came up without a real swing
    }
  }
  function disarm(): void {
    armed = null
    peak = 0
    if (phase === 'ready') setState('ALIGN')
  }
  function setState(text: 'ALIGN' | 'SWING ARMED' | 'ROLLING'): void {
    stateEl.textContent = text
    stateEl.dataset.state = text === 'ALIGN' ? 'align' : text === 'SWING ARMED' ? 'armed' : 'rolling'
    ballGlow(text === 'SWING ARMED')
  }

  function stopCamera(): void {
    unsubscribe?.()
    unsubscribe = null
    if (pipeline && ownsPipeline) pipeline.stop()
    pipeline = null
    tracker = null
    if (video.srcObject) video.srcObject = null
    video.classList.remove('bw-live')
  }

  async function startCamera(): Promise<void> {
    mode = 'camera'
    phase = 'calib'
    showCard('<div class="bw-kicker">CAMERA</div><div class="bw-sub">Starting camera…</div>', [{ label: 'Use mouse instead', fn: startMouse }])
    try {
      const p = await startPosePipeline(video)
      if (disposed || mode !== 'camera') {
        if (p.video === video) p.stop()
        return
      }
      pipeline = p
      ownsPipeline = p.video === video
      if (!ownsPipeline && p.video.srcObject instanceof MediaStream) {
        video.srcObject = p.video.srcObject
        void video.play().catch(() => {})
      }
      video.classList.add('bw-live')
      const calibrator = createCalibrator({ requireHands: false })
      const aspect = p.videoWidth > 0 && p.videoHeight > 0 ? p.videoWidth / p.videoHeight : 4 / 3
      showCard('<div class="bw-kicker">STAND BACK</div><div class="bw-sub">Face the camera with your shoulders in view.</div><div class="bw-meter"><i></i></div>', [
        { label: 'Use mouse instead', fn: startMouse },
      ])
      unsubscribe = p.subscribe((frame) => {
        if (disposed || mode !== 'camera') return
        if (tracker) {
          const b = tracker.push(frame)
          if (b) onBody(b)
          return
        }
        const c = calibrator.push(frame, aspect)
        const bar = cardEl.querySelector('.bw-meter i') as HTMLElement | null
        if (bar) bar.style.width = `${Math.round(c.progress * 100)}%`
        if (c.status === 'done' && c.calibration) {
          tracker = createBodyTracker(c.calibration, { minCutoff: 1.6, beta: 0.2, dCutoff: 1.5 })
          newGame()
        }
      })
    } catch (err) {
      if (disposed || mode !== 'camera') return
      const msg = err instanceof StartupError ? err.message : 'The camera could not start.'
      console.warn('[bowling] camera failed', err)
      showCard(`<div class="bw-kicker">NO CAMERA</div><div class="bw-sub">${escapeHtml(msg)}</div>`, [
        { label: 'Retry', cls: 'bw-primary', fn: () => void startCamera() },
        { label: 'Use mouse', fn: startMouse },
      ])
    }
  }
  function startMouse(): void {
    mode = 'mouse'
    stopCamera()
    newGame()
  }

  // ---------- mouse + keys ----------
  const canvas = renderer.domElement
  let drag: { x: number; y: number; t: number; samples: { x: number; y: number; t: number }[] } | null = null
  function onDown(e: PointerEvent): void {
    if (phase !== 'ready' || mode !== 'mouse') return
    drag = { x: e.clientX, y: e.clientY, t: e.timeStamp, samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] }
    canvas.setPointerCapture(e.pointerId)
  }
  function onMove(e: PointerEvent): void {
    if (!drag) return
    drag.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp })
    while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > 90) drag.samples.shift()
    const s0 = drag.samples[0]
    const dt = Math.max(1, e.timeStamp - s0.t) / 1000
    const h = canvas.clientHeight || 600
    void h
    void dt
  }
  function onUp(e: PointerEvent): void {
    if (!drag) return
    const s0 = drag.samples[0]
    const dt = Math.max(1, e.timeStamp - s0.t) / 1000
    const h = canvas.clientHeight || 600
    const vy = (s0.y - e.clientY) / h / dt
    const dx = e.clientX - drag.x
    const dy = Math.max(20, drag.y - e.clientY)
    drag = null
    if (vy < 0.4) return // a tap or a downward drag is not a throw
    bowl({ speed: 4.8 + vy * 1.6, angle: (Math.atan2(dx, dy) * 180) / Math.PI })
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  function onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.code === 'ArrowLeft') aimKey = Math.max(-1, aimKey - 0.15)
    else if (e.code === 'ArrowRight') aimKey = Math.min(1, aimKey + 0.15)
    else if (e.code === 'Space' && !e.repeat) {
      if (phase === 'ready') {
        e.preventDefault()
        bowl({ speed: 8.6, angle: (Math.random() - 0.5) * 3 })
      }
    } else if (e.code === 'KeyR' && !e.repeat && phase !== 'menu' && phase !== 'calib') newGame()
  }
  window.addEventListener('keydown', onKey)

  // ---------- sizing ----------
  function resize(): void {
    const r = stageEl.getBoundingClientRect()
    const w = Math.max(1, Math.round(r.width))
    const h = Math.max(1, Math.round(r.height))
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.fov = w / h < 1 ? 62 : 48
    camera.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(stageEl)
  resize()

  // ---------- loop ----------
  let raf = 0
  let last = performance.now()
  let acc = 0
  const camPos = new THREE.Vector3(0, 1.38, 2.6)
  const camLook = new THREE.Vector3(0, 0.1, -10)
  const tmpPos = new THREE.Vector3()
  const tmpLook = new THREE.Vector3()
  function frame(now: number): void {
    if (disposed) return
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
    last = now
    if (phase === 'ready' && mode === 'mouse') startX = aimKey * 0.3
    if (phase === 'ready') {
      ball.x += (startX - ball.x) * Math.min(1, dt * 10)
    }
    if (phase === 'rolling' || phase === 'settle') {
      acc += dt
      while (acc >= STEP) {
        stepLane(ball, pins, STEP)
        acc -= STEP
      }
      if (phase === 'rolling') {
        settleT += dt
        if ((ball.z < HEAD_PIN_Z - 1.2 && laneSettled(ball, pins)) || settleT > 6) finishRoll()
      }
    } else acc = 0

    // ball
    ballGroup.position.set(ball.x, BALL_R + (ball.gutter ? -0.05 : 0), ball.z)
    ballGroup.visible = ball.z > LANE_END + 0.3
    if (ball.rolling) {
      ballMesh.rotation.x -= (ball.vz * dt) / BALL_R
      ballMesh.rotation.z -= (ball.vx * dt) / BALL_R
    }
    // pins
    pins.forEach((p, i) => {
      const m = pinMeshes[i]
      m.visible = p.live
      m.position.set(p.x, 0, p.z)
      const tilt = p.fall * (Math.PI / 2) * 0.96
      m.rotation.set(0, 0, 0)
      if (tilt > 0) {
        m.rotation.y = p.fallYaw
        m.rotateX(tilt)
      }
    })
    // aim guide
    const pos = guideGeo.getAttribute('position') as THREE.BufferAttribute
    const aimNow = mode === 'mouse' ? aimKey : 0
    guide.visible = phase === 'ready'
    if (guide.visible) {
      for (let i = 0; i < 24; i++) {
        const z = -0.4 - i * 0.6
        pos.setXYZ(i, ball.x + aimNow * 0.45 * (-z / 8) + ((i * 7) % 3) * 0, 0.01, z)
      }
      pos.needsUpdate = true
    }
    // camera follows the ball down the lane, then holds on the pins
    const chasing = phase === 'rolling' || phase === 'settle'
    if (chasing) {
      const z = Math.max(ball.z + 3.4, -12.6)
      const t = Math.min(1, -z / 12.6)
      tmpPos.set(ball.x * 0.55, 1.38 - 0.5 * t, z)
      tmpLook.set(ball.x * 0.3, 0.3, HEAD_PIN_Z)
    } else {
      tmpPos.set(startX * 0.65, 1.38, 2.6)
      tmpLook.set(startX * 0.35, 0.42, -14)
    }
    const fovWant = (camera.aspect < 1 ? 62 : 48) - (chasing ? 8 * Math.min(1, -ball.z / 12.6) : 0)
    if (Math.abs(camera.fov - fovWant) > 0.05) {
      camera.fov += (fovWant - camera.fov) * (1 - Math.exp(-6.5 * dt))
      camera.updateProjectionMatrix()
    }
    const k = 1 - Math.exp(-6.5 * dt)
    camPos.lerp(tmpPos, k)
    camLook.lerp(tmpLook, k)
    camera.position.copy(camPos)
    camera.lookAt(camLook)
    renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(frame)

  // ---------- start ----------
  renderBoard()
  showCard(
    `<div class="bw-kicker">10 PINS · ${FRAMES} FRAMES</div><div class="bw-big bw-logo">NEON LANES</div><div class="bw-sub">Hold your hand at waist height, then swing it up in front of your chest. Desk-safe. Faster swing, faster ball.</div>`,
    [
      { label: 'Play with camera', cls: 'bw-primary', fn: () => void startCamera() },
      { label: 'Play with mouse', fn: startMouse },
    ],
  )

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(raf)
    for (const id of timers) window.clearTimeout(id)
    window.clearTimeout(calloutTimer)
    window.removeEventListener('keydown', onKey)
    ctx.signal.removeEventListener('abort', dispose)
    ro.disconnect()
    stopCamera()
    for (const d of disposables) d.dispose()
    renderer.dispose()
    void ac?.close().catch(() => {})
    root.remove()
  }
  ctx.signal.addEventListener('abort', dispose, { once: true })
  return { dispose }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

/** Lane texture: boards, aiming arrows and approach dots, in the neon palette. */
function laneCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 2048
  const g = c.getContext('2d')
  if (!g) return c
  const grad = g.createLinearGradient(0, 0, 0, c.height)
  grad.addColorStop(0, '#1a1440')
  grad.addColorStop(1, '#0e1838')
  g.fillStyle = grad
  g.fillRect(0, 0, c.width, c.height)
  // 39 boards
  for (let i = 0; i < 39; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)'
    g.fillRect((i * c.width) / 39, 0, c.width / 39, c.height)
  }
  // Canvas y=0 is the far end (pins). Lane spans 21.4 m over 2048 px.
  const yAt = (z: number): number => ((z - LANE_END) / (LANE_START - LANE_END)) * c.height
  // arrows about 4.6 m past the foul line
  g.fillStyle = '#ff2e88'
  for (let k = -3; k <= 3; k++) {
    const x = c.width / 2 + k * (c.width / 39) * 5
    const y = yAt(-4.6 + Math.abs(k) * 0.3)
    g.beginPath()
    g.moveTo(x, y - 22)
    g.lineTo(x - 7, y + 10)
    g.lineTo(x + 7, y + 10)
    g.closePath()
    g.fill()
  }
  // dots
  g.fillStyle = '#22e5ff'
  for (const z of [-2.1, -2.2]) {
    for (let k = -2; k <= 2; k++) {
      if (k === 0) continue
      g.beginPath()
      g.arc(c.width / 2 + k * (c.width / 39) * 5, yAt(z), 3, 0, Math.PI * 2)
      g.fill()
    }
  }
  // pin deck spots
  g.fillStyle = 'rgba(255,255,255,0.18)'
  for (let row = 0; row < 4; row++)
    for (let i = 0; i <= row; i++) {
      const x = c.width / 2 + ((i - row / 2) * 0.305 * c.width) / (LANE_HALF * 2)
      g.beginPath()
      g.arc(x, yAt(HEAD_PIN_Z - row * 0.264), 4, 0, Math.PI * 2)
      g.fill()
    }
  return c
}
