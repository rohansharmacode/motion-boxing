// First-person boxing scene: tracked neon gloves, a low-poly cyber-drone, telegraphed attacks, bloom and impact feel.
// main.ts drives update() and render() from its own requestAnimationFrame.
import {
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { BufferGeometry, Material } from 'three'
import { LM } from '../../pose/types.ts'
import type { BodyFrame, Hand, Joint } from '../../pose/types.ts'
import type { AttackPattern, BoxingScene, BotStance, GuardMeterView, HitResult, HitTarget, PunchKind, QualityLevel, SlipKind } from './types.ts'
import { createGuardRing } from './guardRings.ts'
import {
  COLORS,
  DRONE,
  HALO_OPACITY,
  NEON,
  buildArena,
  buildDrone,
  buildGlove,
  buildPlayerBody,
  createGlowTexture,
  createSparks,
  createVignetteTexture,
  hdr,
} from './sceneParts.ts'
import type { DroneHitPart, GloveParts } from './sceneParts.ts'
import { STRIKE_TIMING, WIND_MS, blendAttackPose, createPose } from './sceneAttack.ts'
import { createRenderPipeline } from './scenePost.ts'
import { brightBoxingLook } from '../../theme/bright/boxing.ts'
import { buildHumanoid } from '../../theme/bright/avatar.ts'

/** Bright theme look (island arena, bean opponent, cartoon gloves), null under ?theme=neon. */
const look = brightBoxingLook()
/** Calm, readable fight: fewer sparks, gentler shake, and the drone lunges less far so it never fills the camera. */
const FX = 0.35
const SHAKE = 0.45
const LUNGE_REACH = 0.6

/** Bot dodge and guard pose, metres and radians. */
const BOT_SWAY_M = 0.45
const BOT_DUCK_M = 0.4
const BOT_SWAY_ROLL = 0.35
/** Tell: a small wind-up the other way before the bot commits. */
const BOT_TELL_SHARE = 0.22
/** Guard rings next to the bot head (drone root space) and the player's head (rig space, rig origin = eyes). */
const BOT_RING = { x: 0.44, y: DRONE.headY + 0.1, z: 0.12, radius: 0.1 }
const PLAYER_RING = { x: -0.36, y: 0.14, z: 0.05, radius: 0.06 }

const EYE_Y = 1.6
/**
 * Over-the-shoulder camera in rig metres: behind and above the player's right shoulder, so the
 * player's own robot sits in the lower left and the opponent stays centred. Hit tests still use
 * the rig (the player's eyes), so aiming and hit rates do not change with the view.
 */
/** Bright theme: the player is a toy figure seen from behind, feet on the floor (rig origin = eyes). */
function buildBrightPlayer(): Group {
  const fig = buildHumanoid({ seed: 3, height: 1.4 }).root
  fig.rotation.y = Math.PI
  fig.position.set(0, -EYE_Y, 0.12)
  return fig
}

const VIEW = { x: 0.1, y: 0.85, z: 1.5, pitch: -0.34, yaw: 0.025 } as const
const MAX_DT_MS = 50
/** Critically damped glove spring (rad/s). 60 settles in about 75 ms; untracked gloves ease slower. */
const TRACK_OMEGA = 60
const IDLE_OMEGA = 18
const PUNCH_OUT_MS = 90
const PUNCH_BACK_MS = 160
/** Arcade hit radius = visual sphere radius times this. */
const HIT_RADIUS_SCALE = 1.6
const SLIP_LEAN_M = 0.12
const DUCK_DROP_M = 0.15
/** Untracked glove poses in rig metres (x is mirrored per side). These drive aiming, so hit rates stay put. */
const GUARD_REST = { x: 0.2, y: -0.2, z: -0.6 }
const GUARD_HELD = { x: 0.15, y: -0.14, z: -0.55 }
/** Display-only glove offset (outward, down) so the gloves frame the drone. Halved while guarding. */
const VIEW_OFFSET = { x: 0.05, y: -0.07 }
/** Shoulder widths to rig metres for tracked wrists. */
const SW_TO_M = 0.6
/** Elbow angle (deg) to reach: 0 at 70, 1 at 175. */
const REACH_MIN_DEG = 70
const REACH_MAX_DEG = 175
/** How far a missed punch flies along the view ray, metres. A landed punch stops on the armour. */
const STRIKE_DEPTH: Record<PunchKind, number> = { jab: 1.6, cross: 1.75, hook: 1.45, uppercut: 1.4 }
/** Fist radius after the glove scale, metres. */
const GLOVE_RADIUS = 0.065
/** Extra rotation at full extension for the LEFT glove; the right glove mirrors yaw and roll. */
const PUNCH_TWIST: Record<PunchKind, { pitch: number; yaw: number; roll: number }> = {
  jab: { pitch: -0.2, yaw: 0, roll: -0.5 },
  cross: { pitch: -0.2, yaw: -0.15, roll: -0.7 },
  hook: { pitch: -0.2, yaw: -0.7, roll: 1.3 },
  uppercut: { pitch: 0.8, yaw: 0, roll: 0 },
}
/** A charge with no strike this long after it ends was cancelled: the drone eases back. */
const TELEGRAPH_GRACE_MS = 350
/**
 * Peak opacity of the red took-a-hit edge, kept low because the HUD has its own telegraph edge.
 * The composer blends in linear light, which reads about twice as strong as the plain sRGB render.
 */
const HIT_VIGNETTE: Record<QualityLevel, number> = { high: 0.07, low: 0.18 }
/** KO choreography, scene time. The first ~300 ms play in slow motion, so the key beats land there. */
const KO = {
  gravity: 9.8,
  launchUp: 2.1,
  launchBack: 1.0,
  launchSide: 0.5,
  /** rad/s: negative tumbles backward, away from the player. */
  tumble: -3.4,
  roll: 2.2,
  /** Visor and core flicker out over this long; the head shorts out with a pop at popMs. */
  darkMs: 280,
  popMs: 130,
  bounce: 0.32,
  trailMs: 45,
  emberMs: 420,
  sparksUntilMs: 3500,
} as const

const WHITE = new Color(0xffffff)
const RED = new Color(COLORS.telegraph)
const GOLD = new Color(COLORS.counter)
const ACCENT = new Color(COLORS.drone)
/** Drone trim and cores tint toward this while an attack charges. */
const RED_GLOW = hdr(COLORS.telegraph, 2.2)
/** Dead visor glass. */
const DEAD = new Color(0x0c0a14)
const GLOVE_COLOR: Record<Hand, Color> = { left: new Color(COLORS.left), right: new Color(COLORS.right) }
const SPRAY_OUT = new Vector3(0, 0.25, 0.6)
const SPRAY_UP = new Vector3(0, 0.5, 0.2)
/** KO burst: mostly up and out, so few sparks fly into the lens. */
const SPRAY_KO = new Vector3(0, 0.6, 0.1)
const NO_BIAS = new Vector3()

interface PunchAnim {
  kind: PunchKind
  ms: number
  /** Rig-local start, apex and quadratic Bezier control point. */
  from: Vector3
  strike: Vector3
  control: Vector3
}

interface Glove {
  hand: Hand
  /** -1 for the left glove (screen left), 1 for the right. */
  side: number
  parts: GloveParts
  joints: { shoulder: number; elbow: number; wrist: number }
  tracked: boolean
  /** Rig-local target from the body, valid while tracked. */
  track: Vector3
  /** Spring state and the final displayed position (spring plus punch animation). */
  pos: Vector3
  vel: Vector3
  shown: Vector3
  punch: PunchAnim | null
  glow: number
}

/** One drone attack from telegraph to recovery. */
interface Attack {
  pattern: AttackPattern
  /** Hook side: -1 swings in from screen left, 1 from screen right. */
  side: number
  /** Scene ms since the telegraph started, and the charge length. */
  ms: number
  duration: number
  /** Scene ms since the strike, null while charging. */
  strikeMs: number | null
  /** Wind-up at the moment of the strike. */
  windAtStrike: number
  /** 1 while live; fades out when a charge is cancelled. */
  level: number
}

interface KoState {
  ms: number
  vel: Vector3
  spinX: number
  spinZ: number
  settled: boolean
  popped: boolean
  sparkMs: number
}

/** Damped oscillator for knockback wobble. */
interface Wobble {
  x: number
  v: number
}

/** A hit effect waiting for the glove or drone to arrive, so flash, sparks and hitstop land on contact. */
interface PendingEffect {
  ready: () => boolean
  fire: () => void
  hitstopMs: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3
const easeInQuad = (t: number): number => t * t
const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const windOf = (a: Attack): number => easeOutCubic(Math.min(1, a.ms / WIND_MS)) * a.level

/** Exact critically damped spring step toward target (stable for any dt). */
function springStep(pos: Vector3, vel: Vector3, target: Vector3, omega: number, dt: number): void {
  const e = Math.exp(-omega * dt)
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = pos[axis] - target[axis]
    const k = vel[axis] + omega * d
    pos[axis] = target[axis] + (d + k * dt) * e
    vel[axis] = (vel[axis] - omega * k * dt) * e
  }
}

function wobble(w: Wobble, omega: number, zeta: number, dt: number): void {
  w.v += (-omega * omega * w.x - 2 * zeta * omega * w.v) * dt
  w.x += w.v * dt
}

function bezier(a: Vector3, b: Vector3, c: Vector3, t: number, out: Vector3): Vector3 {
  const u = 1 - t
  return out.set(
    u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    u * u * a.y + 2 * u * t * b.y + t * t * c.y,
    u * u * a.z + 2 * u * t * b.z + t * t * c.z,
  )
}

/** World-space shoulder-elbow-wrist angle in degrees, null when the joints are missing or degenerate. */
function elbowAngle(world: Joint[], j: Glove['joints']): number | null {
  const s = world[j.shoulder]
  const e = world[j.elbow]
  const w = world[j.wrist]
  if (!s || !e || !w) return null
  const ax = s.x - e.x, ay = s.y - e.y, az = s.z - e.z
  const bx = w.x - e.x, by = w.y - e.y, bz = w.z - e.z
  const la = Math.hypot(ax, ay, az)
  const lb = Math.hypot(bx, by, bz)
  if (la < 1e-6 || lb < 1e-6) return null
  return (Math.acos(clamp((ax * bx + ay * by + az * bz) / (la * lb), -1, 1)) * 180) / Math.PI
}

function makeGlove(hand: Hand): Glove {
  const left = hand === 'left'
  return {
    hand,
    side: left ? -1 : 1,
    parts: look ? look.buildGlove(hand) : buildGlove(hand),
    joints: left
      ? { shoulder: LM.L_SHOULDER, elbow: LM.L_ELBOW, wrist: LM.L_WRIST }
      : { shoulder: LM.R_SHOULDER, elbow: LM.R_ELBOW, wrist: LM.R_WRIST },
    tracked: false,
    track: new Vector3(),
    pos: new Vector3((left ? -1 : 1) * (GUARD_REST.x + VIEW_OFFSET.x), GUARD_REST.y + VIEW_OFFSET.y, GUARD_REST.z),
    vel: new Vector3(),
    shown: new Vector3(),
    punch: null,
    glow: 0,
  }
}

export function createBoxingScene(container: HTMLElement): BoxingScene {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setClearColor(COLORS.bg, 1)
  const canvas = renderer.domElement
  canvas.style.display = 'block'
  container.appendChild(canvas)

  const scene = new Scene()
  if (look) look.setup(scene, renderer)
  else {
    scene.background = new Color(COLORS.bg)
    scene.fog = new Fog(COLORS.bg, 7, 18)
    const key = new DirectionalLight(0xffffff, 2.5)
    key.position.set(1.5, 4, 3)
    const rim = new DirectionalLight(COLORS.drone, 1.6)
    rim.position.set(-2, 3, -7)
    scene.add(new HemisphereLight(0x9fb2ff, 0x0c0e16, 1.5), key, rim)
  }

  const glowMap = createGlowTexture()
  const vignetteMap = createVignetteTexture()
  scene.add(look ? look.buildArena() : buildArena())
  const drone = look ? look.buildDrone(glowMap) : buildDrone(glowMap)
  scene.add(drone.root, drone.floorGlow)
  const sparks = createSparks(720, 0.065, glowMap)
  const nearSparks = createSparks(160, 0.02, glowMap)
  scene.add(sparks.points, nearSparks.points)

  // Player rig at eye height: camera and gloves move together for slips and ducks.
  const rig = new Group()
  rig.position.set(0, EYE_Y, 0)
  scene.add(rig)
  const camera = new PerspectiveCamera(46, 1, 0.03, 60)
  camera.rotation.order = 'YXZ'
  camera.position.set(VIEW.x, VIEW.y, VIEW.z)
  camera.rotation.set(VIEW.pitch, VIEW.yaw, 0)
  rig.add(camera)
  const player = look ? buildBrightPlayer() : buildPlayerBody()
  rig.add(player)
  const vignetteMat = new MeshBasicMaterial({
    map: vignetteMap,
    color: COLORS.telegraph,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    fog: false,
  })
  const vignette = new Mesh(new PlaneGeometry(2, 2), vignetteMat)
  vignette.position.z = -0.05
  vignette.renderOrder = 10
  vignette.visible = false
  camera.add(vignette)

  const botRing = createGuardRing(BOT_RING.radius)
  botRing.group.position.set(BOT_RING.x, BOT_RING.y, BOT_RING.z)
  drone.root.add(botRing.group)
  const playerRing = createGuardRing(PLAYER_RING.radius)
  playerRing.group.position.set(PLAYER_RING.x, PLAYER_RING.y, PLAYER_RING.z)
  rig.add(playerRing.group)

  const leftGlove = makeGlove('left')
  const rightGlove = makeGlove('right')
  const gloves = [leftGlove, rightGlove]
  for (const g of gloves) rig.add(g.parts.group)
  const gloveOf = (hand: Hand): Glove => (hand === 'left' ? leftGlove : rightGlove)

  const post = createRenderPipeline(renderer, scene, camera, (level) => {
    sparks.density = nearSparks.density = (level === 'high' ? 1 : 0.5) * FX
  })
  sparks.density = nearSparks.density = FX

  // ---------- state ----------
  let time = 0
  let realTime = 0
  let timeScale = 1
  let hitstopMs = 0
  let guard = false
  let slip: SlipKind | null = null
  let lastHand: Hand = 'right'
  let lastKind: PunchKind = 'jab'
  let lastHit: { target: HitTarget; aim: Vector3 } | null = null
  const flash: Record<HitTarget, number> = { head: 0, chest: 0 }
  const knockPitch: Wobble = { x: 0, v: 0 }
  const knockRoll: Wobble = { x: 0, v: 0 }
  const knockPush: Wobble = { x: 0, v: 0 }
  let attack: Attack | null = null
  let hookSide = 1
  const pose = createPose()
  /** Telegraph ring: level 1 while charging, then fades; progress is the charge 0 to 1; size scales the pair. */
  const ring = { level: 0, progress: 0, phase: 0, size: 1 }
  let ko: KoState | null = null
  const pending: PendingEffect[] = []
  let lastPending: PendingEffect | null = null
  /** The latest droneHit while it waits for its glove, so a KO can start on that contact. */
  let pendingHit: PendingEffect | null = null
  let shake = 0
  let redFlash = 0
  const lean = { x: 0, y: 0 }
  let playerMeter: GuardMeterView = { fraction: 1, broken: false }
  let botMeter: GuardMeterView = { fraction: 1, broken: false }
  let botStance: BotStance = { guard: 'down', dodge: null, dodgePhase: null, broken: false }
  /** Smoothed bot defence pose: offset, roll, guard 0 to 1, stun 0 to 1. */
  const def = { x: 0, y: 0, roll: 0, guard: 0, stun: 0 }
  const tmpA = new Vector3()
  const tmpB = new Vector3()
  const tmpC = new Vector3()

  // ---------- gloves ----------

  function trackGlove(g: Glove, body: BodyFrame): boolean {
    const wrist = body.body[g.joints.wrist]
    if (!wrist || wrist.visibility < 0.5) return false
    const ls = body.body[LM.L_SHOULDER]
    const rs = body.body[LM.R_SHOULDER]
    const cx = ls && rs ? (ls.x + rs.x) / 2 : 0
    const cy = ls && rs ? (ls.y + rs.y) / 2 : 0
    const scale = body.scale > 0.25 ? body.scale : 1
    // Relative to the live shoulders: slips move the camera rig, not the gloves.
    const relX = (wrist.x - cx) / scale
    const relY = (wrist.y - cy) / scale
    const theta = elbowAngle(body.world, g.joints)
    const reach = theta === null ? 0.2 : clamp((theta - REACH_MIN_DEG) / (REACH_MAX_DEG - REACH_MIN_DEG), 0, 1)
    g.track.set(
      clamp(relX * SW_TO_M, -0.6, 0.6) * (1 - 0.4 * reach), // straight arms converge on the target
      clamp(-(relY + 0.3) * 0.55 - 0.2 + 0.12 * reach, -0.7, 0.3), // three y is up, body y is down
      -(0.56 + 0.5 * reach),
    )
    return true
  }

  /** Rig-local aiming target: the tracked wrist, or the guard pose. */
  function gloveTarget(g: Glove, out: Vector3): Vector3 {
    if (!g.tracked) {
      const p = guard ? GUARD_HELD : GUARD_REST
      return out.set(g.side * p.x, p.y, p.z)
    }
    out.copy(g.track)
    if (guard) {
      out.x *= 0.85
      out.y += 0.03
    }
    return out
  }

  /** Where the glove is drawn at rest: the aiming target nudged out of the drone's way. */
  function viewTarget(g: Glove, out: Vector3): Vector3 {
    gloveTarget(g, out)
    const k = 1 - 0.5 * g.glow
    out.x += g.side * VIEW_OFFSET.x * k
    out.y += VIEW_OFFSET.y * k
    return out
  }

  /** Writes the displayed position; returns the punch weight 0 to 1. */
  function placeGlove(g: Glove): number {
    const p = g.punch
    if (!p) {
      g.shown.copy(g.pos)
      return 0
    }
    if (p.ms < PUNCH_OUT_MS) {
      const e = easeOutCubic(p.ms / PUNCH_OUT_MS)
      bezier(p.from, p.control, p.strike, e, g.shown)
      return e
    }
    const b = easeInOutQuad(Math.min(1, (p.ms - PUNCH_OUT_MS) / PUNCH_BACK_MS))
    g.shown.lerpVectors(p.strike, g.pos, b)
    return 1 - b
  }

  function updateGloves(dt: number): void {
    for (const g of gloves) {
      springStep(g.pos, g.vel, viewTarget(g, tmpA), g.tracked ? TRACK_OMEGA : IDLE_OMEGA, dt)
      if (g.punch) {
        g.punch.ms += dt * 1000
        if (g.punch.ms >= PUNCH_OUT_MS + PUNCH_BACK_MS) g.punch = null
      }
      const w = placeGlove(g)
      g.shown.y += Math.sin(time * 2.4 + g.side) * 0.006 * (1 - w)
      const { group, shell, glow } = g.parts
      group.position.copy(g.shown)
      const twist = g.punch ? PUNCH_TWIST[g.punch.kind] : null
      const mirror = -g.side // 1 for the left glove
      group.rotation.set(
        0.5 + clamp(g.vel.y * 0.25, -0.35, 0.35) + (twist ? twist.pitch * w : 0),
        mirror * (-0.14 + (twist ? twist.yaw * w : 0)) + clamp(-g.vel.x * 0.15, -0.3, 0.3),
        mirror * (twist ? twist.roll * w : 0) + clamp(-g.vel.x * 0.3, -0.4, 0.4),
      )
      g.glow += ((guard ? 1 : 0) - g.glow) * Math.min(1, dt * 12)
      shell.emissiveIntensity = 0.5 + 0.6 * g.glow + 0.7 * w
      glow.opacity = 0.06 + 0.12 * g.glow + 0.12 * w
    }
  }

  // ---------- hit testing ----------

  function partCenter(part: DroneHitPart, out: Vector3): Vector3 {
    drone.root.updateMatrixWorld(true)
    return drone.body.localToWorld(out.copy(part.center))
  }

  /** World point on the drone plane that this punch aims at (z is ignored by the hit test). */
  function aimPoint(g: Glove, kind: PunchKind, out: Vector3): Vector3 {
    gloveTarget(g, out)
    if (kind === 'hook') out.x *= 0.3 // hooks arc in to the centre line
    else if (kind === 'uppercut') out.y -= 0.5 // uppercuts dig into the body
    else out.x *= 0.6 // straight punches converge on the centre line
    rig.updateMatrixWorld()
    return rig.localToWorld(out)
  }

  function hitTest(aim: Vector3): { part: DroneHitPart; target: HitTarget; accuracy: number } | null {
    if (ko) return null
    let best: { part: DroneHitPart; target: HitTarget; accuracy: number } | null = null
    let bestRatio = 1
    for (const [target, part] of [
      ['head', drone.head],
      ['chest', drone.chest],
    ] as const) {
      const c = partCenter(part, tmpA)
      const ratio = Math.hypot(aim.x - c.x, aim.y - c.y) / (part.radius * HIT_RADIUS_SCALE)
      if (ratio < bestRatio) {
        bestRatio = ratio
        best = { part, target, accuracy: Math.round(100 * (1 - ratio * ratio)) }
      }
    }
    return best
  }

  // ---------- effects ----------

  function defer(ready: () => boolean, fire: () => void): PendingEffect {
    const p: PendingEffect = { ready, fire, hitstopMs: 0 }
    pending.push(p)
    lastPending = p
    return p
  }

  function flushPending(): void {
    for (let i = 0; i < pending.length; ) {
      const p = pending[i]
      if (!p.ready()) {
        i++
        continue
      }
      pending.splice(i, 1)
      if (p === lastPending) lastPending = null
      if (p === pendingHit) pendingHit = null
      p.fire()
      hitstopMs = Math.max(hitstopMs, p.hitstopMs)
    }
  }

  function applyDroneHit(result: HitResult, damage: number, counter: boolean, hand: Hand, kind: PunchKind, aim: Vector3 | null): void {
    const part = result.target === 'head' ? drone.head : drone.chest
    flash[result.target] = 1
    const strength = 0.5 + damage / 12
    knockPitch.v -= (result.target === 'head' ? 8 : 4) * strength
    knockPush.v -= 2.5 * strength
    // The glove's travel pushes the drone sideways: left hand moves +x, which rolls the top to +x.
    knockRoll.v += (hand === 'left' ? -1 : 1) * (kind === 'hook' ? 6 : 1.5) * strength

    const impact = partCenter(part, tmpB)
    if (aim) {
      impact.x += clamp(aim.x - impact.x, -part.radius, part.radius) * 0.6
      impact.y += clamp(aim.y - impact.y, -part.radius, part.radius) * 0.6
    }
    impact.z += part.radius + 0.05
    look?.onDroneHit(counter)
    const color = counter ? GOLD : GLOVE_COLOR[hand]
    sparks.burst(impact, counter ? 70 : 30 + Math.round(damage * 2), color, counter ? 4.5 : 3.2, SPRAY_OUT, counter ? 0.6 : 0.45)
    sparks.burst(impact, 12, WHITE, 1.6, NO_BIAS, 0.18)
  }

  function applyPlayerHit(blocked: boolean): void {
    shake = Math.max(shake, blocked ? 0.03 : 0.08)
    if (!blocked) {
      redFlash = 1
      return
    }
    for (const g of gloves) g.vel.z += 3 // the block knocks the gloves back a little
    const mid = leftGlove.parts.group.getWorldPosition(tmpA).add(rightGlove.parts.group.getWorldPosition(tmpB))
    mid.multiplyScalar(0.5)
    mid.z -= 0.08
    nearSparks.burst(mid, 18, GLOVE_COLOR.left, 0.9, NO_BIAS, 0.3)
    nearSparks.burst(mid, 18, GLOVE_COLOR.right, 0.9, NO_BIAS, 0.3)
    nearSparks.burst(mid, 10, WHITE, 0.6, NO_BIAS, 0.2)
  }

  /** life: 1 = powered, 0 = dead (KO). */
  function applyPart(part: DroneHitPart, f: number, tint: number, life: number): void {
    part.shell.emissive.setScalar(0.8 * f)
    part.halo.opacity = (HALO_OPACITY + 0.3 * f + 0.1 * tint) * (0.3 + 0.7 * life)
    part.core.color.copy(NEON.core).lerp(RED_GLOW, tint).lerp(NEON.white, f).lerp(DEAD, 1 - life)
  }

  // ---------- drone ----------

  function startKO(): void {
    if (ko) return
    look?.onKO()
    const push = lastHand === 'left' ? 1 : -1 // the left glove travels toward +x
    ko = {
      ms: 0,
      vel: new Vector3(push * KO.launchSide, KO.launchUp, -KO.launchBack),
      spinX: KO.tumble,
      spinZ: -push * KO.roll,
      settled: false,
      popped: false,
      sparkMs: 0,
    }
    attack = null
    flash.head = flash.chest = 1
    for (const w of [knockPitch, knockRoll, knockPush]) w.x = w.v = 0
    const c = partCenter(drone.chest, tmpC)
    c.z += DRONE.chestRadius
    sparks.burst(c, 90, ACCENT, 5, SPRAY_KO, 1.1)
    sparks.burst(c, 36, WHITE, 4, SPRAY_KO, 0.7)
    sparks.burst(c, 36, GOLD, 5, SPRAY_KO, 0.9)
    shake = Math.max(shake, 0.06)
  }

  /** Tumble, two bounces, then roll onto its back. Returns the drone's remaining power 0 to 1. */
  function updateKO(k: KoState, dt: number): number {
    const { root, body } = drone
    k.ms += dt * 1000
    if (!k.settled) {
      k.vel.y -= KO.gravity * dt
      root.position.addScaledVector(k.vel, dt)
      body.rotation.x += k.spinX * dt
      body.rotation.z += k.spinZ * dt
      if (root.position.y < DRONE.restY && k.vel.y < 0) {
        const impact = -k.vel.y
        root.position.y = DRONE.restY
        k.vel.set(k.vel.x * 0.5, impact * KO.bounce, k.vel.z * 0.5)
        k.spinX *= -0.35
        k.spinZ *= 0.4
        k.settled = k.vel.y < 0.6
        sparks.burst(tmpC.set(root.position.x, 0.05, root.position.z), Math.round(impact * 16), ACCENT, impact * 0.8, SPRAY_UP, 0.6)
        shake = Math.max(shake, Math.min(0.05, impact * 0.012))
      }
    } else {
      // Slide to a stop and rock onto the nearest lying-on-its-back angle.
      const e = 1 - Math.exp(-dt * 7)
      k.vel.multiplyScalar(1 - e)
      root.position.x += k.vel.x * dt
      root.position.z += k.vel.z * dt
      const lying = Math.round((body.rotation.x + Math.PI / 2) / (2 * Math.PI)) * 2 * Math.PI - Math.PI / 2
      body.rotation.x += (lying - body.rotation.x) * e
    }

    if (!k.popped && k.ms >= KO.popMs) {
      k.popped = true
      const h = partCenter(drone.head, tmpC)
      sparks.burst(h, 60, WHITE, 2.6, SPRAY_UP, 0.5)
      sparks.burst(h, 40, ACCENT, 2, SPRAY_UP, 0.7)
    }
    k.sparkMs += dt * 1000
    if (k.ms < KO.sparksUntilMs && k.sparkMs >= (k.settled ? KO.emberMs : KO.trailMs)) {
      k.sparkMs = 0
      sparks.burst(partCenter(drone.chest, tmpC), k.settled ? 6 : 4, k.settled ? ACCENT : WHITE, 1.3, SPRAY_UP, 0.4)
    }

    // Flicker on the way out, then dark.
    const dark = Math.min(1, k.ms / KO.darkMs)
    return dark >= 1 ? 0 : (1 - dark) * (Math.sin(k.ms * 0.09) > -0.2 ? 1 : 0.15)
  }

  /** Steps the attack clock and fills pose. Returns the ring charge 0 to 1. */
  function updateAttack(ms: number, dt: number): number {
    const a = attack
    let wind = 0
    let lunge = 0
    let tremble = 0
    const fadeRing = (): void => {
      ring.level = Math.max(0, ring.level - dt / 0.1)
    }
    if (a && a.strikeMs === null) {
      a.ms += ms
      const live = a.ms <= a.duration + TELEGRAPH_GRACE_MS
      if (live) {
        ring.level = 1
        ring.progress = Math.min(1, a.ms / a.duration)
        ring.phase += dt * (7 + 32 * ring.progress)
      } else {
        a.level = Math.max(0, a.level - dt / 0.25) // cancelled: ease back to hover
        fadeRing()
      }
      wind = windOf(a)
      tremble = a.ms > WIND_MS ? 0.012 * Math.min(1, a.ms / a.duration) ** 2 * a.level : 0
      if (a.level <= 0) attack = null
    } else {
      fadeRing()
      if (a && a.strikeMs !== null) {
        a.strikeMs += ms
        const { inMs, backMs } = STRIKE_TIMING[a.pattern]
        if (a.strikeMs < inMs) {
          const t = a.strikeMs / inMs
          lunge = easeInQuad(t)
          wind = a.windAtStrike * (1 - easeOutCubic(t))
        } else if (a.strikeMs < inMs + backMs) {
          lunge = 1 - easeOutCubic((a.strikeMs - inMs) / backMs)
        } else {
          attack = null
        }
      }
    }
    blendAttackPose(a ? a.pattern : 'straight', a ? a.side : 1, wind, lunge * LUNGE_REACH, pose)
    pose.x += Math.sin(time * 70) * tremble
    pose.y += Math.sin(time * 53 + 1) * tremble * 0.6
    // The ring follows the wind-up while charging, then holds its place as it fades.
    if (a && a.strikeMs === null) {
      ring.size = 1 + pose.ringSize
      for (const r of [drone.telegraph, drone.telegraphGuide]) {
        r.position.set(pose.ringX, DRONE.ringY + pose.ringY, DRONE.ringZ + pose.ringZ)
        r.rotation.set(pose.ringPitch, pose.ringYaw, 0)
      }
    }
    return ring.progress * ring.level
  }

  /** Ease the bot toward its guard, dodge (with tell) or stunned pose. */
  function updateBotDefence(dt: number): void {
    const s = botStance
    let tx = 0
    let ty = 0
    if (s.dodge && s.dodgePhase !== 'recover') {
      const share = s.dodgePhase === 'tell' ? -BOT_TELL_SHARE : 1
      if (s.dodge === 'duck') ty = -BOT_DUCK_M * (s.dodgePhase === 'tell' ? -0.3 * BOT_TELL_SHARE : 1)
      else tx = (s.dodge === 'sway-left' ? -1 : 1) * BOT_SWAY_M * share
    }
    const kMove = 1 - Math.exp(-dt * (s.dodgePhase === 'active' ? 26 : 14))
    def.x += (tx - def.x) * kMove
    def.y += (ty - def.y) * kMove
    def.roll += (-tx * BOT_SWAY_ROLL / BOT_SWAY_M - def.roll) * kMove
    const kGuard = 1 - Math.exp(-dt * 16)
    def.guard += ((s.guard === 'down' ? 0 : 1) - def.guard) * kGuard
    def.stun += ((s.broken ? 1 : 0) - def.stun) * (1 - Math.exp(-dt * 10))
  }

  function updateDrone(dt: number): void {
    const ms = dt * 1000
    const { root, body } = drone
    wobble(knockPitch, 13, 0.35, dt)
    wobble(knockRoll, 11, 0.35, dt)
    wobble(knockPush, 10, 0.5, dt)

    let charge = 0
    let life = 1
    if (ko) {
      ring.level = 0
      life = updateKO(ko, dt)
    } else {
      charge = updateAttack(ms, dt)
      const calm = 1 - Math.min(1, Math.abs(pose.yaw) + Math.abs(pose.z)) // idle sway fades during attacks
      root.position.set(
        Math.sin(time * 0.6) * 0.08 * calm + pose.x,
        DRONE.y + Math.sin(time * 1.7) * 0.05 + pose.y,
        DRONE.z + pose.z + knockPush.x,
      )
      body.rotation.set(
        knockPitch.x + pose.pitch + Math.sin(time * 1.1) * 0.03,
        Math.sin(time * 0.5) * 0.12 * calm + pose.yaw,
        Math.sin(time * 0.9) * 0.06 + knockRoll.x + pose.roll,
      )
      const lead = attack?.pattern === 'hook' ? (attack.side > 0 ? 1 : 0) : -1
      drone.pods.forEach((pod, i) => {
        const isLead = i === lead
        pod.position.set(
          (i === 0 ? -1 : 1) * (DRONE.podX + (isLead ? pose.leadX : pose.rearX)),
          DRONE.podY + Math.sin(time * 2.2 + i * 1.7) * 0.025 + (isLead ? pose.leadY : pose.rearY),
          DRONE.podZ + (isLead ? pose.leadZ : pose.rearZ),
        )
      })
      drone.orb.position.z = DRONE.orbZ + pose.core

      // Bot defence on top of the attack pose: sway or duck, gloves up in front of the head, stun wobble.
      updateBotDefence(dt)
      root.position.x += def.x
      root.position.y += def.y + def.stun * -0.08
      body.rotation.z += def.roll * 0.5 + def.stun * Math.sin(time * 9) * 0.12
      body.rotation.x += def.stun * 0.18
      if (def.guard > 0.001 || def.stun > 0.001) {
        const hc = drone.head.center
        drone.pods.forEach((pod, i) => {
          const side = i === 0 ? -1 : 1
          pod.position.x += (side * 0.14 - pod.position.x) * def.guard
          pod.position.y += (hc.y - 0.06 - pod.position.y) * def.guard - 0.28 * def.stun
          pod.position.z += (hc.z + 0.22 - pod.position.z) * def.guard
        })
      }
    }

    drone.neckRing.rotation.z += dt * 2.2 * life
    drone.thruster.scale.y = 0.85 + 0.15 * Math.sin(time * 31) + 0.08 * Math.sin(time * 17)
    drone.thruster.material.opacity = (0.38 + 0.1 * Math.sin(time * 23)) * life

    // Telegraph ring: grows into its guide ring and pulses faster as the strike nears.
    const pulse = 0.72 + 0.28 * Math.sin(ring.phase)
    drone.telegraph.visible = drone.telegraphGuide.visible = ring.level > 0
    drone.telegraph.scale.setScalar((0.55 + 0.45 * ring.progress) * ring.size)
    drone.telegraphGuide.scale.setScalar(ring.size)
    drone.telegraph.material.opacity = (0.2 + 0.8 * ring.progress) * pulse * ring.level
    drone.telegraphGuide.material.opacity = 0.25 * charge

    flash.head = Math.max(0, flash.head - dt / 0.14)
    flash.chest = Math.max(0, flash.chest - dt / 0.14)
    applyPart(drone.head, flash.head, charge, life)
    applyPart(drone.chest, flash.chest, charge, life)
    const trim = 0.2 + 0.8 * life
    drone.accent.color.copy(NEON.accent).lerp(RED_GLOW, charge).multiplyScalar(trim)
    drone.accentSolid.color.copy(drone.accent.color)
    drone.floorGlow.position.set(root.position.x, 0.01, root.position.z)
    drone.floorGlow.material.color.copy(ACCENT).lerp(RED, charge)
    drone.floorGlow.material.opacity = 0.35 * life
  }

  function updateCamera(real: number): void {
    realTime += real
    const k = 1 - Math.exp(-real * 14)
    lean.x += ((slip === 'left' ? -SLIP_LEAN_M : slip === 'right' ? SLIP_LEAN_M : 0) - lean.x) * k
    lean.y += ((slip === 'duck' ? -DUCK_DROP_M : 0) - lean.y) * k
    rig.position.set(lean.x, EYE_Y + lean.y, 0)
    rig.rotation.z = -lean.x * 0.4
    shake *= Math.exp(-real * 10)
    const s = shake * SHAKE
    camera.position.set(VIEW.x + Math.sin(realTime * 71) * s, VIEW.y + Math.sin(realTime * 53 + 1.3) * s * 0.8, VIEW.z)
    camera.rotation.set(VIEW.pitch + Math.sin(realTime * 41) * s * 0.5, VIEW.yaw, Math.sin(realTime * 37) * s * 1.2)
    redFlash = Math.max(0, redFlash - real / 0.35)
    vignetteMat.opacity = redFlash * HIT_VIGNETTE[post.quality]
    vignette.visible = redFlash > 0
  }

  // ---------- API ----------

  const api: BoxingScene = {
    canvas,

    resize(width, height) {
      post.setSize(width, height)
      camera.aspect = Math.max(1, width) / Math.max(1, height)
      camera.fov = camera.aspect < 0.9 ? 62 : 46 // portrait screens need more height to fit the drone
      camera.updateProjectionMatrix()
      const halfH = Math.tan((camera.fov * Math.PI) / 360) * -vignette.position.z * 1.08
      vignette.scale.set(halfH * camera.aspect, halfH, 1)
    },

    setBody(body) {
      for (const g of gloves) g.tracked = body !== null && trackGlove(g, body)
    },

    punch(hand, kind) {
      const g = gloveOf(hand)
      lastHand = hand
      lastKind = kind
      const focus = aimPoint(g, kind, new Vector3())
      const hit = hitTest(focus)
      const eye = rig.getWorldPosition(new Vector3())
      let depth: number
      if (hit) {
        // Stop with the knuckles on the armour.
        const c = partCenter(hit.part, tmpA)
        focus.lerp(c, 0.6)
        focus.z = c.z
        depth = clamp(eye.z - c.z - hit.part.radius - GLOVE_RADIUS, 0.45, 2.4)
      } else {
        focus.z = drone.root.position.z
        depth = Math.min(STRIKE_DEPTH[kind], Math.max(0.6, eye.z - focus.z - 0.15))
      }
      // Fly along the eye ray through the focus point so the glove visually lands on it.
      const ray = focus.sub(eye)
      ray.multiplyScalar(depth / Math.max(0.3, -ray.z))
      const strikePoint = rig.worldToLocal(ray.add(eye))
      const from = g.shown.clone()
      const control = from.clone().lerp(strikePoint, 0.5)
      if (kind === 'hook') {
        control.x += g.side * 0.45 // swing out wide, then in
        control.z += 0.1
      } else if (kind === 'uppercut') {
        control.y = Math.min(from.y, strikePoint.y) - 0.3 // dip, then rise
        control.z += 0.15
      }
      g.punch = { kind, ms: 0, from, strike: strikePoint, control }
    },

    resolveHit(hand, kind) {
      const aim = aimPoint(gloveOf(hand), kind, new Vector3())
      const hit = hitTest(aim)
      lastHit = hit ? { target: hit.target, aim } : null
      return hit ? { target: hit.target, accuracy: hit.accuracy } : null
    },

    setGuard(on) {
      guard = on
    },

    setSlip(next) {
      slip = next
    },

    droneTelegraph(ms, pattern) {
      if (ko) return
      if (pattern === 'hook') hookSide = -hookSide
      attack = { pattern, side: pattern === 'hook' ? hookSide : 1, ms: 0, duration: Math.max(1, ms), strikeMs: null, windAtStrike: 0, level: 1 }
      ring.progress = 0
      ring.phase = 0
    },

    droneStrike(pattern) {
      if (ko) return
      const a = attack
      if (a && a.pattern === pattern && a.strikeMs === null) {
        a.windAtStrike = windOf(a)
        a.strikeMs = 0
        a.level = 1
      } else {
        attack = { pattern, side: 1, ms: 0, duration: 1, strikeMs: 0, windAtStrike: 0, level: 1 }
      }
    },

    droneHit(result, damage, counter) {
      const hand = lastHand
      const kind = lastKind
      const aim = lastHit && lastHit.target === result.target ? lastHit.aim.clone() : null
      const fire = (): void => applyDroneHit(result, damage, counter, hand, kind, aim)
      const anim = gloveOf(hand).punch
      lastPending = null
      pendingHit = null
      // Land the impact when the glove reaches its apex.
      if (anim && anim.ms < PUNCH_OUT_MS) {
        pendingHit = defer(() => anim.ms >= PUNCH_OUT_MS || gloveOf(hand).punch !== anim, fire)
      } else fire()
    },

    playerHit(blocked) {
      const a = attack
      lastPending = null
      // Land the impact when the lunge arrives.
      const inMs = a ? STRIKE_TIMING[a.pattern].inMs : 0
      if (a && a.strikeMs !== null && a.strikeMs < inMs) {
        defer(() => attack !== a || (a.strikeMs ?? inMs) >= inMs, () => applyPlayerHit(blocked))
      } else applyPlayerHit(blocked)
    },

    setGuardMeters(player, bot) {
      playerMeter = player
      botMeter = bot
    },

    setBotStance(stance) {
      botStance = stance
    },

    droneKO() {
      if (ko) return
      // The killing blow may still be in flight: start the KO on its contact.
      const hit = pendingHit
      if (hit && pending.includes(hit)) defer(hit.ready, startKO)
      else startKO()
    },

    resetRound() {
      ko = null
      attack = null
      pending.length = 0
      lastPending = pendingHit = null
      lastHit = null
      ring.level = ring.progress = 0
      flash.head = flash.chest = 0
      def.x = def.y = def.roll = def.guard = def.stun = 0
      botStance = { guard: 'down', dodge: null, dodgePhase: null, broken: false }
      playerMeter = { fraction: 1, broken: false }
      botMeter = { fraction: 1, broken: false }
      for (const w of [knockPitch, knockRoll, knockPush]) w.x = w.v = 0
      drone.body.rotation.set(0, 0, 0)
      drone.root.position.set(0, DRONE.y, DRONE.z)
      sparks.clear()
      nearSparks.clear()
      hitstopMs = shake = redFlash = 0
      timeScale = 1
      for (const g of gloves) g.punch = null
    },

    hitstop(ms) {
      // Called right after droneHit or playerHit: if that impact is deferred, freeze on contact instead.
      if (lastPending) lastPending.hitstopMs = Math.max(lastPending.hitstopMs, ms)
      else hitstopMs = Math.max(hitstopMs, ms)
    },

    setTimeScale(scale) {
      timeScale = clamp(scale, 0, 4)
    },

    get quality(): QualityLevel {
      return post.quality
    },

    setQuality(level) {
      post.setQuality(level)
    },

    update(dtMs) {
      post.watchFrame(dtMs)
      lastPending = null
      const realMs = clamp(dtMs, 0, MAX_DT_MS)
      let sceneMs = realMs
      if (hitstopMs > 0) {
        const frozen = Math.min(hitstopMs, sceneMs)
        hitstopMs -= frozen
        sceneMs -= frozen
      }
      const dt = (sceneMs * timeScale) / 1000
      time += dt
      updateGloves(dt)
      updateDrone(dt)
      flushPending()
      botRing.group.visible = !ko
      botRing.update(botMeter, realMs / 1000)
      playerRing.update(playerMeter, realMs / 1000)
      sparks.update(dt)
      nearSparks.update(dt)
      updateCamera(realMs / 1000)
      look?.update(realMs / 1000)
    },

    render() {
      post.render()
    },

    dispose() {
      const geometries = new Set<BufferGeometry>()
      const materials = new Set<Material>()
      scene.traverse((obj) => {
        if (obj instanceof Mesh || obj instanceof Points || obj instanceof LineSegments) {
          geometries.add(obj.geometry)
          const m: Material | Material[] = obj.material
          for (const mat of Array.isArray(m) ? m : [m]) materials.add(mat)
        }
      })
      for (const g of geometries) g.dispose()
      for (const m of materials) m.dispose()
      botRing.dispose()
      playerRing.dispose()
      glowMap.dispose()
      vignetteMap.dispose()
      pending.length = 0
      look?.dispose()
      post.dispose()
      renderer.dispose()
      renderer.forceContextLoss() // free the GL context so the dashboard can start other games
      canvas.remove()
    },
  }

  api.resize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight)
  return api
}
