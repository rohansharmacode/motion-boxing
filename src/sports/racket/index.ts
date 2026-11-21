// Shared swing-to-hit racket sport (table tennis, tennis). One engine, two configs.
// Camera: move your hitting hand left/right to place the paddle, swing it fast as the ball arrives.
// Swing speed sets power, the sideways direction of the swing and its timing set the aim.
// Mouse: move to place the paddle, click to swing. Keyboard: arrows move, Space swings.
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
import { createScore } from './rules.ts'
import type { ScoreKind } from './rules.ts'
import { buildNeonArena } from '../shared/neonArena.ts'
import './racket.css'

const CYAN = 0x22e5ff
const PINK = 0xff2e88
const DARK = 0x070a17
const G = 9.81
const STEP = 1 / 240

export interface RacketConfig {
  id: 'tabletennis' | 'tennis'
  title: string
  kicker: string
  blurb: string
  /** Playing surface (table top or court), metres. */
  length: number
  width: number
  /** Height of the surface above the floor. */
  surfaceY: number
  netH: number
  ballR: number
  /** Time scale so arcade rallies are readable. */
  slowmo: number
  /** Shot flight time range, s (fast to slow, before slowmo). */
  flight: [number, number]
  /** Paddle reach, m (centre to ball). */
  reach: number
  /** Racket travel half width, m. */
  travel: number
  /** Ball apex over the net, m above surface. */
  arc: number
  /** Bounce restitution. */
  bounce: number
  camera: { y: number; back: number; lookZ: number; fov: number }
  /** AI lateral speed, m/s. */
  aiSpeed: number
  /** Chance the AI fluffs an easy ball, raised by player power. */
  aiError: number
  score: ScoreKind
  surfaceColor: number
  floorColor: number
}

let uiSfx: Sfx | null = null

interface Ball {
  p: THREE.Vector3
  v: THREE.Vector3
  live: boolean
  /** Who hit it last: 1 player, -1 AI. */
  by: 1 | -1
  bounces: number
  /** Hit and still flying toward the receiver. */
  inPlay: boolean
}

export async function startRacket(ctx: GameContext, cfg: RacketConfig): Promise<GameSession> {
  if (ctx.signal.aborted) return { dispose() {} }
  uiSfx ??= createSfx()
  const L2 = cfg.length / 2
  const W2 = cfg.width / 2
  const top = cfg.surfaceY
  /** z of the hitting planes (player near +z). */
  const zHit = L2 + cfg.length * 0.06
  /** Depth before the hit plane where a swing can connect; its first half aims left (early), past the plane aims right (late). */
  const zone = cfg.length * 0.12
  /** Serve contact height above the surface. */
  const serveH = cfg.id === 'tennis' ? 1.4 : 0.3

  // ---------- DOM ----------
  const root = document.createElement('div')
  root.className = `rk-root rk-${cfg.id}`
  root.innerHTML = `
    <div class="rk-stage"></div>
    <video class="rk-cam" playsinline muted></video>
    <div class="rk-top"><div class="rk-title"></div><div class="rk-board"></div></div>
    <div class="rk-power"><div class="rk-power-fill"></div></div>
    <div class="rk-hint"></div>
    <div class="rk-callout"></div>
    <div class="rk-card"></div>`
  ctx.host.append(root)
  const q = <T extends HTMLElement>(s: string): T => root.querySelector(s) as T
  const stageEl = q<HTMLDivElement>('.rk-stage')
  const video = q<HTMLVideoElement>('.rk-cam')
  video.muted = true
  q<HTMLDivElement>('.rk-title').textContent = cfg.title
  const boardEl = q<HTMLDivElement>('.rk-board')
  const powerFill = q<HTMLDivElement>('.rk-power-fill')
  const hintEl = q<HTMLDivElement>('.rk-hint')
  const calloutEl = q<HTMLDivElement>('.rk-callout')
  const cardEl = q<HTMLDivElement>('.rk-card')

  // ---------- scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  stageEl.append(renderer.domElement)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(DARK)
  scene.fog = new THREE.Fog(DARK, cfg.length * 2.5, cfg.length * 6)
  const camera = new THREE.PerspectiveCamera(cfg.camera.fov, 16 / 9, 0.05, 200)
  camera.position.set(0, cfg.camera.y, L2 + cfg.camera.back)
  camera.lookAt(0, top, cfg.camera.lookZ)
  scene.add(new THREE.HemisphereLight(0x8fb6ff, 0x120a24, 1.0))
  const key = new THREE.DirectionalLight(0xffffff, 1.2)
  key.position.set(2, 8, 4)
  scene.add(key)

  const disposables: { dispose(): void }[] = []
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x)
    return x
  }
  const cyanMat = track(new THREE.MeshBasicMaterial({ color: CYAN }))
  const pinkMat = track(new THREE.MeshBasicMaterial({ color: PINK }))
  // Hall: glossy grid floor, panelled walls, racing light pulses, arches, crowd, back display.
  const tennis = cfg.id === 'tennis'
  const arena = buildNeonArena(
    tennis
      ? { width: 22, length: 44, centerZ: -2, height: 7, crowd: 320, arches: 7, title: cfg.title }
      : { width: 8, length: 13, centerZ: -1.2, height: 4.4, crowd: 220, arches: 5, title: cfg.title },
  )
  scene.add(arena.group)
  // Surface.
  const surf = new THREE.Mesh(
    track(new THREE.BoxGeometry(cfg.width, cfg.id === 'tennis' ? 0.01 : 0.04, cfg.length)),
    track(new THREE.MeshStandardMaterial({ color: cfg.surfaceColor, roughness: 0.55 })),
  )
  surf.position.y = top - (cfg.id === 'tennis' ? 0.005 : 0.02)
  scene.add(surf)
  if (cfg.id === 'tabletennis') {
    const legGeo = track(new THREE.BoxGeometry(0.05, top, 0.05))
    const legMat = track(new THREE.MeshStandardMaterial({ color: 0x1a2040 }))
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, legMat)
        leg.position.set(sx * (W2 - 0.1), top / 2, sz * (L2 - 0.2))
        scene.add(leg)
      }
  }
  // Lines: edges in cyan, centre line in pink.
  const lw = cfg.id === 'tennis' ? 0.06 : 0.02
  const lineY = top + 0.004
  const line = (w: number, l: number, x: number, z: number, mat: THREE.Material): void => {
    const m = new THREE.Mesh(track(new THREE.BoxGeometry(w, 0.004, l)), mat)
    m.position.set(x, lineY, z)
    scene.add(m)
  }
  line(lw, cfg.length, -W2 + lw / 2, 0, cyanMat)
  line(lw, cfg.length, W2 - lw / 2, 0, cyanMat)
  line(cfg.width, lw, 0, -L2 + lw / 2, cyanMat)
  line(cfg.width, lw, 0, L2 - lw / 2, cyanMat)
  if (cfg.id === 'tennis') {
    const svc = 6.4
    line(cfg.width, lw, 0, -svc, cyanMat)
    line(cfg.width, lw, 0, svc, cyanMat)
    line(lw, svc * 2, 0, 0, pinkMat)
  } else line(lw / 2, cfg.length, 0, 0, pinkMat)
  // Net.
  const net = new THREE.Mesh(
    track(new THREE.PlaneGeometry(cfg.width + (cfg.id === 'tennis' ? 1 : 0.3), cfg.netH)),
    track(new THREE.MeshBasicMaterial({ color: PINK, transparent: true, opacity: 0.28, side: THREE.DoubleSide })),
  )
  net.position.set(0, top + cfg.netH / 2, 0)
  scene.add(net)
  const tape = new THREE.Mesh(track(new THREE.BoxGeometry(cfg.width + (cfg.id === 'tennis' ? 1 : 0.3), cfg.netH * 0.08, 0.01)), pinkMat)
  tape.position.set(0, top + cfg.netH, 0)
  scene.add(tape)

  // Ball + ground shadow.
  const ballMesh = new THREE.Mesh(track(new THREE.SphereGeometry(cfg.ballR, 16, 12)), track(new THREE.MeshBasicMaterial({ color: cfg.id === 'tennis' ? 0xe8ff5a : 0xffffff })))
  scene.add(ballMesh)
  const shadow = new THREE.Mesh(track(new THREE.CircleGeometry(cfg.ballR * 1.4, 16)), track(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 })))
  shadow.rotation.x = -Math.PI / 2
  scene.add(shadow)
  // Trail.
  const TRAIL = 14
  const trailGeo = track(new THREE.BufferGeometry())
  trailGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(TRAIL * 3), 3))
  const trail = new THREE.Line(trailGeo, track(new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.6 })))
  trail.frustumCulled = false
  scene.add(trail)

  // Rackets: a glowing disc on a handle.
  const racketScale = cfg.id === 'tennis' ? 1 : 0.38
  function buildRacket(color: number): THREE.Group {
    const g = new THREE.Group()
    const head = new THREE.Mesh(track(new THREE.TorusGeometry(0.16 * racketScale, 0.02 * racketScale, 6, 24)), color === CYAN ? cyanMat : pinkMat)
    const face = new THREE.Mesh(
      track(new THREE.CircleGeometry(0.16 * racketScale, 24)),
      track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, side: THREE.DoubleSide })),
    )
    const handle = new THREE.Mesh(track(new THREE.CylinderGeometry(0.018 * racketScale, 0.022 * racketScale, 0.22 * racketScale)), color === CYAN ? cyanMat : pinkMat)
    handle.position.y = -0.27 * racketScale
    g.add(head, face, handle)
    return g
  }
  const myRacket = buildRacket(CYAN)
  scene.add(myRacket)
  // Opponent: neon robot (capsule body, round head with a visor) holding a pink racket.
  const ai = new THREE.Group()
  const bodyH = cfg.id === 'tennis' ? 1.0 : 0.7
  const aiBody = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.2, bodyH * 0.6, 4, 12)), track(new THREE.MeshStandardMaterial({ color: 0x1b1f4a, emissive: 0x1a0a30, roughness: 0.4 })))
  aiBody.position.y = bodyH * 0.55
  const aiHead = new THREE.Mesh(track(new THREE.SphereGeometry(0.17, 16, 12)), track(new THREE.MeshStandardMaterial({ color: 0x24285a, roughness: 0.3 })))
  aiHead.position.y = bodyH * 1.1
  const visor = new THREE.Mesh(track(new THREE.BoxGeometry(0.22, 0.05, 0.02)), pinkMat)
  visor.position.set(0, bodyH * 1.12, 0.16)
  const aiRacket = buildRacket(PINK)
  aiRacket.position.set(0.32, bodyH * 0.75, 0.1)
  ai.add(aiBody, aiHead, visor, aiRacket)
  ai.position.set(0, cfg.id === 'tennis' ? 0 : top - bodyH * 0.55, -zHit - 0.25)
  if (cfg.id === 'tennis') ai.scale.setScalar(1.8)
  scene.add(ai)

  // ---------- state ----------
  const ball: Ball = { p: new THREE.Vector3(), v: new THREE.Vector3(), live: false, by: 1, bounces: 0, inPlay: false }
  const score = createScore(cfg.score)
  let phase: 'menu' | 'calib' | 'serve' | 'rally' | 'point' | 'over' = 'menu'
  let server: 1 | -1 = 1
  let racketX = 0
  let targetX = 0
  let aiX = 0
  let aiTarget = 0
  let livePower = 0
  let swingAt = -1e9
  let swingPower = 0
  let swingAim = 0
  let simT = 0
  let rally = 0
  /** ?rkauto: the racket follows the ball (demo and headless tests). */
  const autoAim = new URLSearchParams(location.search).has('rkauto')
  /** Rolled per shot: the AI fluffs this ball when it is below the error chance. */
  let aiMiss = 1
  let disposed = false
  let mode: 'camera' | 'mouse' = 'mouse'
  let pipeline: PosePipeline | null = null
  let ownsPipeline = false
  let unsubscribe: (() => void) | null = null
  let tracker: BodyTracker | null = null
  const timers = new Set<number>()
  const later = (ms: number, fn: () => void): void => {
    const id = window.setTimeout(() => {
      timers.delete(id)
      if (!disposed) fn()
    }, ms)
    timers.add(id)
  }

  // ---------- audio ----------
  let ac: AudioContext | null = null
  function tone(freqs: number[], step = 0.08, type: OscillatorType = 'square', gain = 0.07): void {
    try {
      ac ??= new AudioContext()
    } catch {
      return
    }
    const a = ac
    freqs.forEach((fq, i) => {
      const o = a.createOscillator()
      o.type = type
      o.frequency.value = fq
      const g = a.createGain()
      const t = a.currentTime + i * step
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(gain, t + 0.005)
      g.gain.exponentialRampToValueAtTime(0.0001, t + step * 1.5)
      o.connect(g).connect(a.destination)
      o.start(t)
      o.stop(t + step * 2)
    })
  }
  const pok = (): void => tone([cfg.id === 'tennis' ? 420 : 900], 0.05, 'triangle', 0.15)
  const tick = (): void => tone([cfg.id === 'tennis' ? 260 : 1300], 0.03, 'triangle', 0.08)

  // ---------- HUD ----------
  function renderBoard(): void {
    const s = score.view()
    boardEl.innerHTML = `
      <div class="rk-side rk-you"><span>YOU</span><b>${s.you}</b>${s.youSets !== null ? `<i>${s.youSets}</i>` : ''}</div>
      <div class="rk-sep">${s.label}</div>
      <div class="rk-side rk-cpu"><span>CPU</span><b>${s.cpu}</b>${s.cpuSets !== null ? `<i>${s.cpuSets}</i>` : ''}</div>`
  }
  let calloutTimer = 0
  function callout(text: string, tone: 'big' | 'info' | 'bad' = 'big'): void {
    calloutEl.textContent = text
    calloutEl.className = `rk-callout rk-${tone}`
    void calloutEl.offsetWidth
    calloutEl.classList.add('rk-show')
    window.clearTimeout(calloutTimer)
    calloutTimer = window.setTimeout(() => calloutEl.classList.remove('rk-show'), 1200)
  }
  function hint(): void {
    hintEl.textContent =
      phase === 'serve' && server === 1
        ? mode === 'camera'
          ? 'Your serve: swing your hand fast. Sideways swing aims it.'
          : 'Your serve: click (or Space) to swing.'
        : phase === 'rally' || phase === 'serve'
          ? mode === 'camera'
            ? 'Move your hand to the ball, swing as it reaches you.'
            : 'Mouse to move, click to swing. Swing early to aim left, late to aim right.'
          : ''
  }
  function showCard(html: string, buttons: { label: string; cls?: string; fn: () => void }[]): void {
    cardEl.innerHTML = `<div class="rk-card-in">${html}<div class="rk-btns"></div></div>`
    const wrap = cardEl.querySelector('.rk-btns') as HTMLElement
    for (const b of buttons) {
      const el = document.createElement('button')
      el.className = `rk-btn ${b.cls ?? ''}`
      el.textContent = b.label
      el.addEventListener('click', () => {
        uiSfx?.select()
        b.fn()
      })
      wrap.append(el)
    }
    cardEl.classList.add('rk-open')
  }
  const hideCard = (): void => cardEl.classList.remove('rk-open')

  // ---------- shots ----------
  /** Launch from p toward a landing spot on the far side of `to` (1 = player side, -1 = AI side). */
  function launch(from: THREE.Vector3, to: 1 | -1, power: number, aim: number, by: 1 | -1): void {
    const p = Math.max(0, Math.min(1, power))
    const land = new THREE.Vector3(aim * W2 * 0.8, top + cfg.ballR, to * L2 * (0.35 + 0.5 * p))
    const T = cfg.flight[1] + (cfg.flight[0] - cfg.flight[1]) * p
    ball.p.copy(from)
    ball.v.set((land.x - from.x) / T, 0, (land.z - from.z) / T)
    // vy so the ball lands at time T; keep the net clear by lifting the arc if needed.
    let vy = (land.y - from.y + 0.5 * G * T * T) / T
    const tNet = Math.abs(from.z / ball.v.z)
    const yNet = from.y + vy * tNet - 0.5 * G * tNet * tNet
    const want = top + cfg.netH + cfg.arc * (1 - p * 0.6)
    if (yNet < want) vy += (want - yNet) / tNet
    ball.v.y = vy
    ball.live = true
    ball.inPlay = true
    ball.by = by
    ball.bounces = 0
    aiMiss = Math.random()
  }

  function point(winner: 1 | -1, why: string): void {
    if (phase !== 'rally' && phase !== 'serve') return
    if (autoAim) console.info(`[${cfg.id}] point`, winner, why, 'rally', rally, 'ball', ball.p.toArray().map((v) => v.toFixed(2)).join(','), 'bounces', ball.bounces, 'aiX', aiX.toFixed(2))
    phase = 'point'
    ball.inPlay = false
    const res = score.point(winner)
    renderBoard()
    const word = winner === 1 ? (rally >= 6 ? 'GREAT RALLY!' : why === 'ace' ? 'ACE!' : why === 'miss' ? 'WINNER!' : 'POINT!') : why === 'net' ? 'NET!' : why === 'out' ? 'OUT!' : 'MISSED!'
    callout(res.matchOver ? (winner === 1 ? 'YOU WIN!' : 'CPU WINS') : res.call ?? word, winner === 1 ? 'big' : 'bad')
    tone(winner === 1 ? [523, 659, 784] : [330, 247], winner === 1 ? 0.08 : 0.14)
    if (winner === 1) arena.pulse(rally >= 6 ? 0xffd166 : 0x22e5ff)
    if (res.matchOver) {
      later(1400, () => matchOver(winner))
      return
    }
    server = res.server
    later(1300, startPoint)
  }

  function startPoint(): void {
    rally = 0
    phase = 'serve'
    hint()
    if (server === 1) {
      ball.live = true
      ball.inPlay = false
      ball.v.set(0, 0, 0)
      ball.p.set(racketX, top + serveH, zHit)
    } else {
      aiX = (Math.random() - 0.5) * W2
      ball.live = true
      ball.inPlay = false
      ball.p.set(aiX, top + serveH, -zHit)
      later(900, () => {
        if (phase !== 'serve') return
        phase = 'rally'
        pok()
        launch(new THREE.Vector3(aiX, top + serveH, -zHit), 1, 0.25 + Math.random() * 0.3, (Math.random() - 0.5) * 1.4, -1)
        hint()
      })
    }
  }

  function newMatch(): void {
    score.reset()
    server = 1
    hideCard()
    renderBoard()
    callout('PLAY!', 'info')
    startPoint()
  }

  function matchOver(winner: 1 | -1): void {
    phase = 'over'
    ball.live = false
    hint()
    const s = score.view()
    tone(winner === 1 ? [392, 523, 659, 784, 1047] : [392, 330, 262], 0.12)
    showCard(
      `<div class="rk-kicker">${winner === 1 ? 'MATCH WON' : 'MATCH LOST'}</div><div class="rk-big">${s.final}</div><div class="rk-sub">${winner === 1 ? 'The robot bows to you.' : 'The robot takes it. Rematch?'}</div>`,
      [
        { label: 'Rematch', cls: 'rk-primary', fn: newMatch },
        { label: 'Home', fn: () => ctx.exit() },
      ],
    )
  }

  // ---------- swing ----------
  /** Window around the ball reaching the hit plane in which a swing connects, s (sim time). */
  const WINDOW = 0.28
  function swing(power: number, aim: number): void {
    swingAt = simT
    swingPower = power
    swingAim = aim
    livePower = Math.max(livePower, power)
    if (phase === 'serve' && server === 1) {
      phase = 'rally'
      pok()
      launch(new THREE.Vector3(racketX, top + serveH, zHit), -1, 0.3 + power * 0.6, aim, 1)
      rally = 0
      hint()
    }
  }

  /** Called every step while the ball approaches the player. */
  function tryPlayerHit(): void {
    if (ball.by !== -1 || !ball.inPlay || ball.bounces < 1) return
    // ball reaching the hit plane
    if (ball.p.z < zHit - zone) return
    const dt = simT - swingAt
    if (dt < 0 || dt > WINDOW) return
    const dx = Math.abs(ball.p.x - racketX)
    if (dx > cfg.reach) return
    // Timing: early (ball still short of the plane) pulls left, late pushes right.
    const timing = Math.max(-1, Math.min(1, (ball.p.z - zHit) / zone))
    const perfect = Math.abs(timing) < 0.25 && swingPower > 0.55
    const aim = Math.max(-1, Math.min(1, swingAim * 0.8 + timing * 0.6))
    swingAt = -1e9
    rally++
    if (autoAim) console.info(`[${cfg.id}] player hit point rally`, rally, 'timing', timing.toFixed(2))
    pok()
    if (perfect) callout('PERFECT!', 'info')
    else if (rally === 5) callout('RALLY x5', 'info')
    launch(ball.p.clone(), -1, 0.25 + swingPower * 0.75, aim, 1)
  }

  function aiHit(): void {
    if (ball.by !== 1 || !ball.inPlay || ball.bounces < 1 || ball.p.z < -zHit) return
    if (ball.p.z > -zHit + Math.max(0.15, cfg.length * 0.02)) return
    const dx = Math.abs(ball.p.x - aiX)
    const hard = Math.min(1, ball.v.length() / (cfg.length / cfg.flight[0]))
    const err = cfg.aiError + hard * 0.15 + Math.min(rally, 10) * 0.01
    if (dx > cfg.reach * 1.1 || aiMiss < err) return // too far, or fluffs it: the ball flies past
    rally++
    pok()
    if (autoAim) console.info(`[${cfg.id}] ai hit point rally`, rally)
    const aim = Math.random() < 0.5 ? (Math.random() - 0.5) * 1.8 : -Math.sign(racketX || 1) * (0.4 + Math.random() * 0.5)
    launch(ball.p.clone(), 1, 0.3 + Math.random() * 0.45 + Math.min(rally, 10) * 0.02, aim, -1)
  }

  // ---------- physics ----------
  function step(dt: number): void {
    simT += dt
    if (!ball.live || !ball.inPlay) return
    const prevZ = ball.p.z
    ball.v.y -= G * dt
    ball.p.addScaledVector(ball.v, dt)
    // net
    if (Math.sign(prevZ) !== Math.sign(ball.p.z) && ball.p.y < top + cfg.netH + cfg.ballR * 0.5) {
      tick()
      return point(ball.by === 1 ? -1 : 1, 'net')
    }
    // bounce on the surface
    if (ball.p.y <= top + cfg.ballR && ball.v.y < 0) {
      const onSurface = Math.abs(ball.p.x) <= W2 + cfg.ballR && Math.abs(ball.p.z) <= L2 + cfg.ballR
      const rightSide = Math.sign(ball.p.z) === -ball.by
      if (cfg.id === 'tabletennis' && !onSurface) {
        // fell past the table
        return point(ball.bounces === 0 ? (ball.by === 1 ? -1 : 1) : ball.by, ball.bounces === 0 ? 'out' : 'miss')
      }
      if (ball.bounces === 0 && (!onSurface || !rightSide)) return point(ball.by === 1 ? -1 : 1, 'out')
      if (ball.bounces >= 1) return point(ball.by, rally === 0 && ball.by === 1 ? 'ace' : 'miss')
      ball.p.y = top + cfg.ballR
      ball.v.y = -ball.v.y * cfg.bounce
      ball.bounces++
      tick()
    }
    if (cfg.id === 'tabletennis' && ball.p.y < top - 0.3) return point(ball.bounces === 0 ? (ball.by === 1 ? -1 : 1) : ball.by, 'miss')
    tryPlayerHit()
    aiHit()
    // passed a player
    if (ball.p.z > zHit + 0.9 && ball.by === -1) return point(-1, 'miss')
    if (ball.p.z < -zHit - 0.9 && ball.by === 1) return point(1, 'miss')
  }

  // ---------- camera input ----------
  let lastW: Record<'left' | 'right', { x: number; y: number; t: number } | null> = { left: null, right: null }
  let hand: 'left' | 'right' = 'right'
  let lastSwingT = 0
  function onBody(b: BodyFrame): void {
    let best = 0
    let bestV = { x: 0, y: 0 }
    for (const side of ['left', 'right'] as const) {
      const w = b.body[side === 'left' ? LM.L_WRIST : LM.R_WRIST]
      const prev = lastW[side]
      lastW[side] = { x: w.x, y: w.y, t: b.t }
      if (!prev || w.visibility < 0.3) continue
      const dt = (b.t - prev.t) / 1000
      if (dt <= 0 || dt > 0.2) continue
      const vx = (w.x - prev.x) / dt
      const vy = (w.y - prev.y) / dt
      const sp = Math.hypot(vx, vy)
      if (sp > best) {
        best = sp
        bestV = { x: vx, y: vy }
        if (sp > 3) hand = side
      }
    }
    const w = b.body[hand === 'left' ? LM.L_WRIST : LM.R_WRIST]
    // Hand x in body units (about -2.5..2.5 across a normal frame) maps onto the racket travel.
    targetX = Math.max(-1, Math.min(1, w.x / 2)) * cfg.travel
    livePower = Math.max(livePower, Math.min(1, (best - 3) / 9))
    if (best > 4.5 && b.t - lastSwingT > 350) {
      lastSwingT = b.t
      swing(Math.min(1, (best - 3) / 9), Math.max(-1, Math.min(1, bestV.x / Math.max(best, 1))))
    }
  }

  function stopCamera(): void {
    unsubscribe?.()
    unsubscribe = null
    if (pipeline && ownsPipeline) pipeline.stop()
    pipeline = null
    tracker = null
    if (video.srcObject) video.srcObject = null
    video.classList.remove('rk-live')
  }

  async function startCamera(): Promise<void> {
    mode = 'camera'
    phase = 'calib'
    showCard('<div class="rk-kicker">CAMERA</div><div class="rk-sub">Starting camera…</div>', [{ label: 'Use mouse instead', fn: startMouse }])
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
      video.classList.add('rk-live')
      const calibrator = createCalibrator({ requireHands: false })
      const aspect = p.videoWidth > 0 && p.videoHeight > 0 ? p.videoWidth / p.videoHeight : 4 / 3
      showCard('<div class="rk-kicker">STAND BACK</div><div class="rk-sub">Face the camera with your shoulders in view.</div><div class="rk-meter"><i></i></div>', [
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
        const bar = cardEl.querySelector('.rk-meter i') as HTMLElement | null
        if (bar) bar.style.width = `${Math.round(c.progress * 100)}%`
        if (c.status === 'done' && c.calibration) {
          tracker = createBodyTracker(c.calibration, { minCutoff: 1.8, beta: 0.25, dCutoff: 1.5 })
          newMatch()
        }
      })
    } catch (err) {
      if (disposed || mode !== 'camera') return
      const msg = err instanceof StartupError ? err.message : 'The camera could not start.'
      console.warn(`[${cfg.id}] camera failed`, err)
      showCard(`<div class="rk-kicker">NO CAMERA</div><div class="rk-sub">${escapeHtml(msg)}</div>`, [
        { label: 'Retry', cls: 'rk-primary', fn: () => void startCamera() },
        { label: 'Use mouse', fn: startMouse },
      ])
    }
  }
  function startMouse(): void {
    mode = 'mouse'
    stopCamera()
    newMatch()
  }

  // ---------- mouse + keys ----------
  const canvas = renderer.domElement
  let mouseVX = 0
  let lastMouse: { x: number; t: number } | null = null
  function onMove(e: PointerEvent): void {
    if (mode !== 'mouse') return
    const r = canvas.getBoundingClientRect()
    const nx = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1
    targetX = Math.max(-1, Math.min(1, nx * 1.4)) * cfg.travel
    if (lastMouse) mouseVX = (e.clientX - lastMouse.x) / Math.max(1, e.timeStamp - lastMouse.t)
    lastMouse = { x: e.clientX, t: e.timeStamp }
  }
  function onDown(): void {
    if (mode !== 'mouse' || (phase !== 'rally' && phase !== 'serve')) return
    swing(0.75, Math.max(-1, Math.min(1, mouseVX)))
  }
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerdown', onDown)
  const keys = new Set<string>()
  function onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.type === 'keyup') {
      keys.delete(e.code)
      return
    }
    keys.add(e.code)
    if (e.code === 'Space' && !e.repeat && (phase === 'rally' || phase === 'serve')) {
      e.preventDefault()
      const dir = keys.has('ArrowLeft') ? -1 : keys.has('ArrowRight') ? 1 : 0
      swing(0.75, dir * 0.8)
    } else if (e.code === 'KeyR' && !e.repeat && phase !== 'menu' && phase !== 'calib') newMatch()
  }
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)

  // ---------- sizing ----------
  function resize(): void {
    const r = stageEl.getBoundingClientRect()
    const w = Math.max(1, Math.round(r.width))
    const h = Math.max(1, Math.round(r.height))
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.fov = w / h < 1 ? cfg.camera.fov * 1.3 : cfg.camera.fov
    camera.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(stageEl)
  resize()

  // ---------- loop ----------
  let raf = 0
  let last = performance.now()
  let acc = 0
  const trailPts: THREE.Vector3[] = Array.from({ length: TRAIL }, () => new THREE.Vector3())
  let swingAnim = 0
  function frame(now: number): void {
    if (disposed) return
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
    last = now
    // keyboard movement
    if (keys.has('ArrowLeft')) targetX = Math.max(-cfg.travel, targetX - cfg.travel * 1.6 * dt)
    if (keys.has('ArrowRight')) targetX = Math.min(cfg.travel, targetX + cfg.travel * 1.6 * dt)
    if (autoAim && ball.inPlay) targetX = Math.max(-cfg.travel, Math.min(cfg.travel, ball.p.x))
    racketX += (targetX - racketX) * Math.min(1, dt * 14)
    if (phase === 'serve' && server === 1) ball.p.set(racketX + 0.05, top + serveH + Math.abs(Math.sin(now / 300)) * 0.12, zHit)
    acc += dt * cfg.slowmo
    while (acc >= STEP) {
      step(STEP)
      // AI runs toward where the ball will cross its plane.
      if (ball.inPlay && ball.by === 1 && ball.v.z < 0) {
        const t = (-zHit - ball.p.z) / ball.v.z
        aiTarget = Math.max(-cfg.travel, Math.min(cfg.travel, ball.p.x + ball.v.x * Math.max(0, t)))
      } else if (phase !== 'serve') aiTarget *= 0.995
      const d = aiTarget - aiX
      aiX += Math.sign(d) * Math.min(Math.abs(d), cfg.aiSpeed * STEP)
      acc -= STEP
    }
    // draw
    ballMesh.visible = ball.live
    shadow.visible = ball.live
    ballMesh.position.copy(ball.p)
    shadow.position.set(ball.p.x, Math.abs(ball.p.x) <= W2 && Math.abs(ball.p.z) <= L2 ? top + 0.003 : 0.003, ball.p.z)
    const tv = trailPts.pop() as THREE.Vector3
    trailPts.unshift(tv.copy(ball.p))
    const pos = trailGeo.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < TRAIL; i++) pos.setXYZ(i, trailPts[i].x, trailPts[i].y, trailPts[i].z)
    pos.needsUpdate = true
    trail.visible = ball.inPlay
    swingAnim = simT - swingAt < 0.25 ? 1 : swingAnim * 0.85
    myRacket.position.set(racketX, top + (cfg.id === 'tennis' ? 0.9 : 0.16), zHit + 0.05)
    myRacket.rotation.set(-0.3, 0, swingAnim * 0.9 * (swingAim >= 0 ? -1 : 1))
    ai.position.x = aiX - 0.3 * ai.scale.x
    aiRacket.rotation.z = Math.sin(now / 250) * 0.15
    // camera eases a little with the player's racket
    camera.position.x += (racketX * 0.25 - camera.position.x) * Math.min(1, dt * 3)
    camera.lookAt(0, top, cfg.camera.lookZ)
    livePower *= 0.92
    powerFill.style.transform = `scaleY(${livePower.toFixed(3)})`
    arena.update(now / 1000)
    renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(frame)

  // ---------- start ----------
  renderBoard()
  showCard(
    `<div class="rk-kicker">${cfg.kicker}</div><div class="rk-big rk-logo">${cfg.title}</div><div class="rk-sub">${cfg.blurb}</div>`,
    [
      { label: 'Play with camera', cls: 'rk-primary', fn: () => void startCamera() },
      { label: 'Play with mouse', fn: startMouse },
    ],
  )

  function dispose(): void {
    if (disposed) return
    disposed = true
    arena.dispose()
    cancelAnimationFrame(raf)
    for (const id of timers) window.clearTimeout(id)
    window.clearTimeout(calloutTimer)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('keyup', onKey)
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
