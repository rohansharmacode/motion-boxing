// First-person boxing scene: tracked neon gloves, a low-poly cyber-drone, telegraphed attacks, bloom and impact feel.
// main.ts drives update() and render() from its own requestAnimationFrame.
import {
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  LineSegments,
  AdditiveBlending,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  SphereGeometry,
  Points,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { BufferGeometry, Material, Object3D, Quaternion } from 'three'
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
  createGlowTexture,
  createSparks,
  createVignetteTexture,
  hdr,
} from './sceneParts.ts'
import type { DroneHitPart, DroneParts, GloveParts } from './sceneParts.ts'
import { STRIKE_TIMING, WIND_MS, blendAttackPose, createPose } from './sceneAttack.ts'
import { createRenderPipeline } from './scenePost.ts'
import { buildArenaDressing } from './arenaDressing.ts'
import { createGloveTrail, createShockwaves } from './sceneFx.ts'
import { loadRobotBody } from './robotModel.ts'
import type { RobotBody } from './robotModel.ts'
import { brightBoxingLook } from '../../theme/bright/boxing.ts'
import { buildHumanoid } from '../../theme/bright/avatar.ts'
import { gloveColors, schemeOf } from '../../custom/look.ts'
import type { RobotLook } from '../../custom/look.ts'
import { buildHead } from '../../custom/robot.ts'

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
/**
 * The camera is not parented to the rig: it follows the rig on a critically damped spring, takes only part
 * of a slip or duck, and never rolls with the body, so the view stays steady while the player's robot leans.
 */
const CAM_OMEGA = 15
/** Player robot in rig space: a little left of centre so the camera sits over its right shoulder. */
const PLAYER_TWIN = { x: -0.5, z: 0.35 } as const
/** Shoulder widths to metres for the mirrored body lean, and its limits. */
const BODY_LEAN_M = 0.4
type ShotName = 'fight' | 'wide' | 'ko'
/** Camera shots in stage space (rig origin at eye height): camera position and look-at point, metres. */
const SHOTS: Record<ShotName, { pos: [number, number, number]; look: [number, number, number] }> = {
  fight: { pos: [0.45, 1.6 + 0.9, 2.75], look: [-0.08, 1.15, -2.1] },
  wide: { pos: [-1.2, 1.6 + 1.4, 2.9], look: [0, 1.0, -1.2] },
  ko: { pos: [1.8, 1.0, -0.6], look: [0, 0.6, -2.4] },
}
const CAM_FOLLOW = { x: 0.45, y: 0.55 } as const
/** Impact camera kick: damped springs (position metres, rotation radians), driven in real time. */
const KICK_OMEGA = 30
const KICK_ZETA = 0.55
/** Peak impact-frame white flash per hit type (high quality halves it: the composer blends in linear light). */
const IMPACT_FLASH = { hit: 0.2, counter: 0.32, block: 0.1, ko: 0.5 } as const
const IMPACT_FLASH_FADE_S = 0.09
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
/** KO choreography, scene time, full speed (no slow motion): the head flies off, then the body goes down. */
const HEAD_OFF = {
  up: 3.6,
  back: 2.3,
  side: 1.3,
  /** rad/s */
  spinX: -11,
  spinY: 5,
  spinZ: 7,
  /** Head centre height when it rests on the canvas. */
  floorY: 0.27,
  bounce: 0.42,
  friction: 0.65,
  /** Neck stump keeps spitting sparks this long. */
  stumpMs: 1400,
} as const
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
  popMs: 0,
  bounce: 0.32,
  trailMs: 45,
  emberMs: 420,
  sparksUntilMs: 3500,
} as const

const WHITE = new Color(0xffffff)
const GOLD = new Color(COLORS.counter)
const ACCENT = new Color(COLORS.drone)
/** Drone trim and cores tint toward this while an attack charges. */
const RED_GLOW = hdr(COLORS.telegraph, 2.2)
/** Dead visor glass. */
const DEAD = new Color(0x0c0a14)
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

/** Bigger gloves (display only; hit tests use the aim point, not the glove size). */
/** The player's own body is see-through so it never blocks the opponent or the gloves. */
function ghostPlayer(root: Object3D, cloneMats: boolean): void {
  root.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    const fix = (x: Material): Material => {
      const c = cloneMats ? x.clone() : x
      c.transparent = true
      c.opacity = 0.28
      c.depthWrite = false
      return c
    }
    m.material = Array.isArray(m.material) ? m.material.map(fix) : fix(m.material)
  })
}

function scaleGlove(parts: GloveParts): GloveParts {
  parts.group.scale.multiplyScalar(1.4)
  // The player's gloves always draw on top: never hidden behind the body, the ring or culled at the frame edge.
  parts.group.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    m.frustumCulled = false
    m.renderOrder = 20
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    const own = mats.map((x) => {
      const c = x.clone()
      c.depthTest = false
      c.depthWrite = false
      return c
    })
    m.material = Array.isArray(m.material) ? own : own[0]
  })
  return parts
}

function makeGlove(hand: Hand, robot?: RobotLook): Glove {
  const left = hand === 'left'
  return {
    hand,
    side: left ? -1 : 1,
    parts: scaleGlove(look ? look.buildGlove(hand) : buildGlove(hand, robot)),
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

export interface BoxingSceneOptions {
  /** The player's customised robot (colours, head, gloves). Omitted: the default look. */
  robot?: RobotLook
}

export function createBoxingScene(container: HTMLElement, opts: BoxingSceneOptions = {}): BoxingScene {
  const { robot } = opts
  const robotGloves = robot && !look ? gloveColors(robot) : null
  const GLOVE_COLOR: Record<Hand, Color> = {
    left: new Color(robotGloves?.[0] ?? COLORS.left),
    right: new Color(robotGloves?.[1] ?? COLORS.right),
  }
  /** Opponent colours the drone animates from; a 1v1 friend's look replaces them. */
  const droneAccent = NEON.accent.clone()
  const droneCore = NEON.core.clone()
  const droneGlow = ACCENT.clone()
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setClearColor(COLORS.bg, 1)
  const canvas = renderer.domElement
  canvas.style.display = 'block'
  container.appendChild(canvas)

  const scene = new Scene()
  if (look) look.setup(scene, renderer)
  else {
    scene.background = new Color(COLORS.bg)
    scene.fog = new Fog(COLORS.bg, 12, 34)
    const key = new DirectionalLight(0xffffff, 2.5)
    key.position.set(1.5, 4, 3)
    const rim = new DirectionalLight(COLORS.drone, 1.6)
    rim.position.set(-2, 3, -7)
    // Subtle rim light from behind each fighter so smooth shapes read with a bright edge.
    const rimFront = new DirectionalLight(0x9fe8ff, 1.1)
    rimFront.position.set(2.5, 2.5, 6)
    scene.add(new HemisphereLight(0x9fb2ff, 0x0c0e16, 1.5), key, rim, rimFront)
  }

  const glowMap = createGlowTexture()
  const vignetteMap = createVignetteTexture()
  scene.add(look ? look.buildArena() : buildArena())
  /** Neon only: stands, crowd, LED boards, beams and skyline around the ring. */
  const dressing = look ? null : buildArenaDressing()
  if (dressing) scene.add(dressing.group)
  const drone = look ? look.buildDrone(glowMap) : buildDrone(glowMap)
  /** The drone's own armour and fist colours, to restore after a 1v1. */
  const droneArmour = drone.armour?.map((m) => m.color.getHex()) ?? []
  const droneFist = drone.fistShell ? { color: drone.fistShell.color.clone(), emissive: drone.fistShell.emissive.clone() } : null
  /** A 1v1 friend's head style, replacing the drone helmet. */
  let opponentHead: Group | null = null
  const podGlows = drone.pods.map((pod) => {
    const m = new Mesh(
      new SphereGeometry(0.13, 16, 10),
      new MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, fog: false }),
    )
    m.visible = false
    pod.add(m)
    return m
  })
  /** Both fighters live on a stage that drifts and turns slowly, so the fight circles the ring. */
  const stage = new Group()
  scene.add(stage)
  stage.add(drone.root, drone.floorGlow)
  const sparks = createSparks(720, 0.065, glowMap)
  const nearSparks = createSparks(160, 0.02, glowMap)
  scene.add(sparks.points, nearSparks.points)

  // Player rig at eye height: camera and gloves move together for slips and ducks.
  const rig = new Group()
  rig.position.set(0, EYE_Y, 0)
  stage.add(rig)
  const camera = new PerspectiveCamera(50, 1, 0.03, 60)
  camera.rotation.order = 'YXZ'
  camera.position.set(VIEW.x, EYE_Y + VIEW.y, VIEW.z)
  camera.rotation.set(VIEW.pitch, VIEW.yaw, 0)
  scene.add(camera)
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
  // Impact frame: a brief white flash on contact, held while the hit-stop freezes the scene.
  const impactMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    fog: false,
  })
  const impactPlane = new Mesh(new PlaneGeometry(2, 2), impactMat)
  impactPlane.position.z = -0.05
  impactPlane.renderOrder = 11
  impactPlane.visible = false
  camera.add(impactPlane)

  const botRing = createGuardRing(BOT_RING.radius)
  botRing.group.position.set(BOT_RING.x, BOT_RING.y, BOT_RING.z)
  drone.root.add(botRing.group)
  const playerRing = createGuardRing(PLAYER_RING.radius)
  playerRing.group.position.set(PLAYER_RING.x, PLAYER_RING.y, PLAYER_RING.z)
  rig.add(playerRing.group)

  const leftGlove = makeGlove('left', robot)
  const rightGlove = makeGlove('right', robot)
  const gloves = [leftGlove, rightGlove]
  for (const g of gloves) rig.add(g.parts.group)
  // The player's robot is built exactly like the opponent (same proportions and size), seen from behind.
  // Its own fists are hidden: the tracked gloves float in front, like the opponent's.
  const twin = look ? null : buildDrone(glowMap)
  const playerModel: Object3D = twin ? twin.root : buildBrightPlayer()
  if (twin) {
    for (const pod of twin.pods) pod.visible = false
    twin.telegraph.visible = twin.telegraphGuide.visible = false
    twin.telegraph.removeFromParent()
    twin.telegraphGuide.removeFromParent()
    const scheme = robot ? schemeOf(robot) : null
    if (scheme) twin.armour?.forEach((m) => m.color.setHex(scheme.armour))
    twin.root.rotation.y = Math.PI
    twin.root.position.set(PLAYER_TWIN.x, DRONE.y - EYE_Y, PLAYER_TWIN.z)
    ghostPlayer(twin.root, true)
  }
  // Smooth glTF robot bodies (CC0) replace the built-in shapes once loaded; gloves stay separate.
  let droneRobot: RobotBody | null = null
  let twinRobot: RobotBody | null = null
  const useRobot = (parts: DroneParts, tint: number, set: (r: RobotBody) => void): void =>
    loadRobotBody(parts.body, -DRONE.y, tint, (r) => {
      if (disposed) return
      for (const c of parts.body.children) if (c !== r.root && c !== parts.headRoot && !parts.pods.includes(c as Group)) c.visible = false
      parts.headModel?.traverse((o: Object3D) => (o.visible = o === parts.headModel))
      parts.head.shell = parts.chest.shell = r.paint
      set(r)
    })
  if (!look) {
    useRobot(drone, 0xd0386a, (r) => (droneRobot = r))
    if (twin)
      useRobot(twin, 0x1d8fae, (r) => {
        twinRobot = r
        ghostPlayer(r.root, false)
      })
  }
  let disposed = false
  const playerBase = playerModel.position.clone()
  rig.add(playerModel)
  /** Continuous body lean from the camera (metres, radians), learned against a slow baseline. */
  const bodyLean = { x: 0, y: 0, roll: 0, tx: 0, ty: 0, troll: 0, bx: NaN, by: NaN }
  const gloveOf = (hand: Hand): Glove => (hand === 'left' ? leftGlove : rightGlove)
  const trails = gloves.map((g) => {
    const t = createGloveTrail(GLOVE_COLOR[g.hand])
    t.reset(g.pos)
    rig.add(t.mesh)
    return t
  })
  const waves = createShockwaves(8)
  scene.add(waves.group)

  const post = createRenderPipeline(renderer, scene, camera, (level) => {
    sparks.density = nearSparks.density = (level === 'high' ? 1 : 0.5) * FX
  })
  sparks.density = nearSparks.density = FX

  // ---------- state ----------
  let time = 0
  let realTime = 0
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
  let redFlash = 0
  let impactFlash = 0
  /** Camera follow spring state (world) and the impact kick springs. */
  const camPos = new Vector3(VIEW.x, EYE_Y + VIEW.y, VIEW.z) // stage space
  const camVel = new Vector3()
  const camTarget = new Vector3()
  const kick = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, z: { x: 0, v: 0 }, pitch: { x: 0, v: 0 }, roll: { x: 0, v: 0 } }
  /** The KO head in flight, with where it came from so the next round can put it back. */
  let headFly: {
    obj: Object3D
    parent: Object3D
    pos: Vector3
    quat: Quaternion
    vel: Vector3
    spin: Vector3
    settled: boolean
  } | null = null
  const eyeLocal = new Vector3()
  let shotRequest: 'wide' | 'fight' = 'fight'
  const shotPos = new Vector3(...SHOTS.fight.pos)
  const shotLook = new Vector3(...SHOTS.fight.look)
  const camQuat = camera.quaternion
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

  /** Impulse on the camera kick springs (velocities): metres per second and radians per second. */
  function kickCam(x: number, y: number, z: number, pitch: number, roll: number): void {
    kick.x.v += x
    kick.y.v += y
    kick.z.v += z
    kick.pitch.v += pitch
    kick.roll.v += roll
  }

  function flashImpact(level: number): void {
    impactFlash = Math.max(impactFlash, level)
  }

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
    knockPitch.v -= (result.target === 'head' ? 12 : 6) * strength
    knockPush.v -= 7 * strength // punches drive the target back
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
    // Shockwave right on the contact point, a white inner ring on top for a crisp edge.
    waves.spawn(impact, color, 0.3 + damage * 0.025 + (counter ? 0.15 : 0), counter ? 0.32 : 0.24)
    waves.spawn(impact, WHITE, 0.16 + damage * 0.01, 0.14)
    flashImpact(counter ? IMPACT_FLASH.counter : IMPACT_FLASH.hit)
    // Camera kick toward the punch: a small dip forward, nudged the way the glove travelled.
    const dirX = hand === 'left' ? 1 : -1
    kickCam(dirX * 0.4 * strength, -0.3 * strength, -1.4 * strength, -0.35 * strength, dirX * (kind === 'hook' ? 0.6 : 0.25) * strength)
  }

  function applyPlayerHit(blocked: boolean): void {
    const rollSign = Math.random() < 0.5 ? -1 : 1
    if (!blocked) {
      redFlash = 1
      // Rocked back: the camera snaps back and tilts, then springs home.
      kickCam(rollSign * 0.4, 0.5, 2.6, 1.3, rollSign * 2.4)
      return
    }
    kickCam(0, 0.1, 1.1, 0.4, rollSign * 0.6)
    flashImpact(IMPACT_FLASH.block)
    for (const g of gloves) g.vel.z += 3 // the block knocks the gloves back a little
    const mid = leftGlove.parts.group.getWorldPosition(tmpA).add(rightGlove.parts.group.getWorldPosition(tmpB))
    mid.multiplyScalar(0.5)
    mid.z -= 0.08
    nearSparks.burst(mid, 18, GLOVE_COLOR.left, 0.9, NO_BIAS, 0.3)
    nearSparks.burst(mid, 18, GLOVE_COLOR.right, 0.9, NO_BIAS, 0.3)
    nearSparks.burst(mid, 10, WHITE, 0.6, NO_BIAS, 0.2)
    waves.spawn(mid, NEON.white, 0.22, 0.2)
  }

  /** life: 1 = powered, 0 = dead (KO). */
  function applyPart(part: DroneHitPart, f: number, tint: number, life: number): void {
    part.shell.emissive.setScalar(0.8 * f)
    part.halo.opacity = (HALO_OPACITY + 0.3 * f + 0.1 * tint) * (0.3 + 0.7 * life)
    part.core.color.copy(droneCore).lerp(RED_GLOW, tint).lerp(NEON.white, f).lerp(DEAD, 1 - life)
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
    sparks.burst(c, 90, droneGlow, 5, SPRAY_KO, 1.1)
    sparks.burst(c, 36, WHITE, 4, SPRAY_KO, 0.7)
    sparks.burst(c, 36, GOLD, 5, SPRAY_KO, 0.9)
    knockHeadOff(push)
    const h = partCenter(drone.head, tmpC)
    waves.spawn(h, GOLD, 0.75, 0.45)
    waves.spawn(h, WHITE, 0.4, 0.25)
    waves.spawn(h, droneGlow, 1.1, 0.6)
    flashImpact(IMPACT_FLASH.ko)
    kickCam(-push * 0.6, 0.3, -2.2, -0.9, -push * 1.6)
  }

  /** Finisher: the head pops clean off the body and flies up and away, spinning. */
  function knockHeadOff(push: number): void {
    if (headFly) return
    // Model robot: bake its head off the skinned body; otherwise knock the built-in head group off.
    const baked = droneRobot?.detachHead() ?? null
    if (baked) scene.add(baked)
    const obj = baked ?? drone.headRoot
    if (!obj.parent) return
    const parent = obj.parent
    headFly = {
      obj,
      parent,
      pos: obj.position.clone(),
      quat: obj.quaternion.clone(),
      vel: new Vector3(push * HEAD_OFF.side, HEAD_OFF.up, -HEAD_OFF.back),
      spin: new Vector3(HEAD_OFF.spinX, push * HEAD_OFF.spinY, push * HEAD_OFF.spinZ),
      settled: false,
    }
    if (!baked) scene.attach(obj) // keeps its world transform
  }

  function updateHead(k: KoState, dt: number): void {
    const f = headFly
    if (!f) return
    const o = f.obj
    if (!f.settled) {
      f.vel.y -= KO.gravity * dt
      o.position.addScaledVector(f.vel, dt)
      o.rotation.x += f.spin.x * dt
      o.rotation.y += f.spin.y * dt
      o.rotation.z += f.spin.z * dt
      if (o.position.y < HEAD_OFF.floorY && f.vel.y < 0) {
        const impact = -f.vel.y
        o.position.y = HEAD_OFF.floorY
        f.vel.set(f.vel.x * HEAD_OFF.friction, impact * HEAD_OFF.bounce, f.vel.z * HEAD_OFF.friction)
        f.spin.multiplyScalar(0.55)
        sparks.burst(tmpC.set(o.position.x, 0.05, o.position.z), Math.round(impact * 10), WHITE, impact * 0.6, SPRAY_UP, 0.4)
        kickCam(0, -Math.min(0.5, impact * 0.08), 0, 0, 0)
        if (impact > 2) waves.spawn(tmpC.set(o.position.x, 0.06, o.position.z), droneGlow, 0.4, 0.25)
        if (f.vel.y < 0.7) f.settled = true
      } else if (k.ms < 900 && k.sparkMs === 0) {
        sparks.burst(o.getWorldPosition(tmpC), 3, GOLD, 0.8, NO_BIAS, 0.3)
      }
    } else {
      // Roll to a stop on the canvas.
      const e = 1 - Math.exp(-dt * 3)
      f.vel.multiplyScalar(1 - e)
      f.spin.multiplyScalar(1 - e)
      o.position.x += f.vel.x * dt
      o.position.z += f.vel.z * dt
      o.rotation.x += f.spin.x * dt
      o.rotation.z += f.spin.z * dt
    }
  }

  function restoreHead(): void {
    const f = headFly
    if (!f) return
    headFly = null
    if (droneRobot && f.obj !== drone.headRoot) {
      droneRobot.reattachHead()
      return
    }
    f.parent.add(f.obj)
    f.obj.position.copy(f.pos)
    f.obj.quaternion.copy(f.quat)
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
        sparks.burst(stage.localToWorld(tmpC.set(root.position.x, 0.05, root.position.z)), Math.round(impact * 16), droneGlow, impact * 0.8, SPRAY_UP, 0.6)
        kickCam(0, -Math.min(0.9, impact * 0.2), 0, -Math.min(0.3, impact * 0.06), 0)
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
      sparks.burst(h, 80, WHITE, 3.2, SPRAY_UP, 0.5)
      sparks.burst(h, 60, GOLD, 2.6, SPRAY_UP, 0.8)
    }
    k.sparkMs += dt * 1000
    if (k.ms < KO.sparksUntilMs && k.sparkMs >= (k.settled ? KO.emberMs : KO.trailMs)) {
      k.sparkMs = 0
      sparks.burst(partCenter(drone.chest, tmpC), k.settled ? 6 : 4, k.settled ? droneGlow : WHITE, 1.3, SPRAY_UP, 0.4)
      // The neck stump fizzes where the head used to be.
      if (headFly && k.ms < HEAD_OFF.stumpMs) sparks.burst(partCenter(drone.head, tmpC), 8, GOLD, 2.2, SPRAY_UP, 0.45)
    }
    updateHead(k, dt)

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
    droneRobot?.tick(dt)
    twinRobot?.tick(dt)
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
        // Footwork: side steps and a bob-and-weave, quieter while it attacks.
        (Math.sin(time * 1.1) * 0.14 + Math.sin(time * 2.9) * 0.05) * calm + pose.x,
        DRONE.y + Math.abs(Math.sin(time * 2.9)) * -0.03 * calm + pose.y,
        DRONE.z + pose.z + knockPush.x,
      )
      body.rotation.set(
        knockPitch.x + pose.pitch + Math.sin(time * 1.1) * 0.03,
        Math.sin(time * 1.1 + 0.6) * 0.2 * calm + pose.yaw,
        Math.sin(time * 2.9) * 0.08 * calm + knockRoll.x + pose.roll,
      )
      const lead = attack?.pattern === 'hook' ? (attack.side > 0 ? 1 : 0) : -1
      drone.pods.forEach((pod, i) => {
        const isLead = i === lead
        // Small red glow on the glove that is about to strike (both for straights and slams).
        const glow = podGlows[i]
        if (glow) {
          const on = lead === -1 || isLead ? charge : 0
          glow.visible = on > 0.01
          glow.material.opacity = on * (0.55 + 0.35 * (0.5 + 0.5 * Math.sin(ring.phase)))
          glow.scale.setScalar(0.8 + 0.4 * on)
        }
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
          pod.position.x += (side * 0.17 - pod.position.x) * def.guard
          pod.position.y += (hc.y - 0.06 - pod.position.y) * def.guard - 0.28 * def.stun
          pod.position.z += (hc.z + 0.34 - pod.position.z) * def.guard // gloves stay clear of the head
        })
      }
    }

    drone.neckRing.rotation.z += dt * 2.2 * life
    drone.thruster.scale.y = 0.85 + 0.15 * Math.sin(time * 31) + 0.08 * Math.sin(time * 17)
    drone.thruster.material.opacity = (0.38 + 0.1 * Math.sin(time * 23)) * life

    // Telegraph ring: grows into its guide ring and pulses faster as the strike nears.
    const pulse = 0.72 + 0.28 * Math.sin(ring.phase)
    // The big ring is retired: the attacking glove glows instead.
    drone.telegraph.visible = drone.telegraphGuide.visible = false
    drone.telegraph.scale.setScalar((0.55 + 0.45 * ring.progress) * ring.size)
    drone.telegraphGuide.scale.setScalar(ring.size)
    drone.telegraph.material.opacity = (0.2 + 0.8 * ring.progress) * pulse * ring.level
    drone.telegraphGuide.material.opacity = 0.25 * charge

    flash.head = Math.max(0, flash.head - dt / 0.14)
    flash.chest = Math.max(0, flash.chest - dt / 0.14)
    applyPart(drone.head, flash.head, 0, life)
    applyPart(drone.chest, flash.chest, 0, life)
    const trim = 0.2 + 0.8 * life
    drone.accent.color.copy(droneAccent).multiplyScalar(trim)
    drone.accentSolid.color.copy(drone.accent.color)
    drone.floorGlow.position.set(root.position.x, 0.01, root.position.z)
    drone.floorGlow.material.color.copy(droneGlow)
    drone.floorGlow.material.opacity = 0.35 * life
  }

  function updateCamera(real: number): void {
    realTime += real
    const k = 1 - Math.exp(-real * 14)
    lean.x += ((slip === 'left' ? -SLIP_LEAN_M : slip === 'right' ? SLIP_LEAN_M : 0) - lean.x) * k
    lean.y += ((slip === 'duck' ? -DUCK_DROP_M : 0) - lean.y) * k
    rig.position.set(lean.x, EYE_Y + lean.y, 0)
    rig.rotation.z = -lean.x * 0.4
    // Footwork: the stage circles slowly; the player's robot bounces on its toes.
    const still = ko ? 0.3 : 1
    // TV-style: the pair circles and steps across the ring, so the broadcast angle keeps changing.
    stage.rotation.y = (Math.sin(realTime * 0.37) * 0.32 + Math.sin(realTime * 0.91) * 0.06) * still
    stage.position.set(
      (Math.sin(realTime * 0.52) * 0.55 + Math.sin(realTime * 1.3) * 0.08) * still,
      0,
      (Math.sin(realTime * 0.43 + 1) * 0.28 + Math.sin(realTime * 1.7) * 0.05) * still,
    )
    // The player's robot mirrors the body: lean and duck 1:1, shoulder tilt as weight shift, a calm breathing bob.
    const kb = 1 - Math.exp(-real * 16)
    bodyLean.x += (bodyLean.tx - bodyLean.x) * kb
    bodyLean.y += (bodyLean.ty - bodyLean.y) * kb
    bodyLean.roll += (bodyLean.troll - bodyLean.roll) * kb
    playerModel.position.set(
      playerBase.x + bodyLean.x,
      playerBase.y + bodyLean.y + Math.sin(realTime * 2.2) * 0.008,
      playerBase.z,
    )
    if (twin) {
      twin.body.rotation.set(-bodyLean.y * 0.6, 0, -bodyLean.roll * 0.8 - bodyLean.x * 0.5)
      twin.headRoot.rotation.z = -bodyLean.roll * 0.3
    } else playerModel.rotation.z = -bodyLean.roll * 0.5
    // Shot by situation: wide for the countdown, tighter in an exchange, a low side angle on the KO.
    // One steady over-the-shoulder view while fighting; wide only for the countdown, side angle for the KO.
    const shot: ShotName = ko ? 'ko' : shotRequest === 'wide' ? 'wide' : 'fight'
    const sp = SHOTS[shot]
    shotPos.lerp(tmpA.set(sp.pos[0], sp.pos[1], sp.pos[2]), 1 - Math.exp(-real * (shot === 'ko' ? 4 : 4.5)))
    if (shot === 'ko') tmpB.set(drone.root.position.x, Math.max(0.6, drone.root.position.y), drone.root.position.z)
    else tmpB.set(sp.look[0], sp.look[1], sp.look[2])
    shotLook.lerp(tmpB, 1 - Math.exp(-real * 5))
    // Smooth follow: part of the lean, on a spring, no roll. Kicks ride on top and settle in ~150 ms.
    const follow = shot === 'fight' ? 1 : 0
    camTarget.set(shotPos.x + lean.x * CAM_FOLLOW.x * follow, shotPos.y + lean.y * CAM_FOLLOW.y * follow, shotPos.z)
    springStep(camPos, camVel, camTarget, CAM_OMEGA, real)
    for (const w of [kick.x, kick.y, kick.z, kick.pitch, kick.roll]) wobble(w, KICK_OMEGA, KICK_ZETA, real)
    const s = SHAKE / 0.45 // kick size follows the calm-fight SHAKE setting
    stage.updateMatrixWorld()
    camera.position.copy(
      stage.localToWorld(
        tmpC.set(
          camPos.x + clamp(kick.x.x, -0.06, 0.06) * s,
          camPos.y + clamp(kick.y.x, -0.06, 0.06) * s,
          camPos.z + clamp(kick.z.x, -0.12, 0.12) * s,
        ),
      ),
    )
    camera.lookAt(stage.localToWorld(tmpC.copy(shotLook)))
    camera.rotateX(clamp(kick.pitch.x, -0.05, 0.05) * s)
    camera.rotateZ(clamp(kick.roll.x, -0.07, 0.07) * s)
    redFlash = Math.max(0, redFlash - real / 0.35)
    vignetteMat.opacity = redFlash * HIT_VIGNETTE[post.quality]
    vignette.visible = redFlash > 0
    // Impact frame: full while the hit-stop holds, then a fast fade.
    if (hitstopMs <= 0) impactFlash = Math.max(0, impactFlash - real / IMPACT_FLASH_FADE_S)
    impactMat.opacity = impactFlash * (post.quality === 'high' ? 0.5 : 1)
    impactPlane.visible = impactFlash > 0
  }

  function updateTrails(dt: number): void {
    camera.updateMatrixWorld()
    rig.updateMatrixWorld()
    rig.worldToLocal(camera.getWorldPosition(eyeLocal))
    gloves.forEach((g, i) => {
      const anim = g.punch
      const w = anim ? (anim.ms < PUNCH_OUT_MS ? 1 : Math.max(0, 1 - (anim.ms - PUNCH_OUT_MS) / PUNCH_BACK_MS)) : 0
      const fast = clamp((g.vel.length() - 1.8) / 3, 0, 0.7)
      trails[i].update(g.shown, Math.max(w, fast), eyeLocal, dt > 0)
    })
  }

  // ---------- API ----------

  const api: BoxingScene = {
    canvas,

    resize(width, height) {
      post.setSize(width, height)
      camera.aspect = Math.max(1, width) / Math.max(1, height)
      camera.fov = camera.aspect < 0.9 ? 62 : 50 // portrait screens need more height to fit the drone
      camera.updateProjectionMatrix()
      const halfH = Math.tan((camera.fov * Math.PI) / 360) * -vignette.position.z * 1.08
      vignette.scale.set(halfH * camera.aspect, halfH, 1)
      impactPlane.scale.copy(vignette.scale)
    },

    setBody(body) {
      for (const g of gloves) g.tracked = body !== null && trackGlove(g, body)
      const ls = body?.body[LM.L_SHOULDER]
      const rs = body?.body[LM.R_SHOULDER]
      if (!body || !ls || !rs || ls.visibility < 0.5 || rs.visibility < 0.5) {
        bodyLean.tx = bodyLean.ty = bodyLean.troll = 0
        return
      }
      const scale = body.scale > 0.25 ? body.scale : 1
      const cx = (ls.x + rs.x) / 2
      const cy = (ls.y + rs.y) / 2
      if (Number.isNaN(bodyLean.bx)) {
        bodyLean.bx = cx
        bodyLean.by = cy
      }
      // Slow baseline (a few seconds) so standing a bit off centre does not read as a lean.
      bodyLean.bx += (cx - bodyLean.bx) * 0.004
      bodyLean.by += (cy - bodyLean.by) * 0.004
      bodyLean.tx = clamp(((cx - bodyLean.bx) / scale) * BODY_LEAN_M, -0.3, 0.3)
      bodyLean.ty = clamp((-(cy - bodyLean.by) / scale) * BODY_LEAN_M, -0.3, 0.1)
      bodyLean.troll = clamp(Math.atan2(rs.y - ls.y, rs.x - ls.x) * (rs.x < ls.x ? -1 : 1), -0.45, 0.45)
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

    setOpponentLook(friend) {
      const model = drone.headModel
      if (look || !model) return // bright toy figures keep their own look
      if (opponentHead) {
        opponentHead.removeFromParent()
        opponentHead.traverse((o) => (o as Mesh).geometry?.dispose())
        opponentHead = null
      }
      const scheme = friend ? schemeOf(friend) : null
      droneAccent.copy(scheme ? hdr(scheme.accent, 2.2) : NEON.accent)
      droneCore.copy(scheme ? hdr(scheme.visor, 1.5) : NEON.core)
      droneGlow.setHex(scheme?.accent ?? COLORS.drone)
      drone.armour?.forEach((m, i) => m.color.setHex(scheme ? scheme.armour : (droneArmour[i] ?? 0x1d2132)))
      if (drone.fistShell && droneFist) {
        if (scheme) {
          drone.fistShell.color.setHex(scheme.accent).multiplyScalar(0.5)
          drone.fistShell.emissive.copy(hdr(scheme.accent, 0.7))
        } else {
          drone.fistShell.color.copy(droneFist.color)
          drone.fistShell.emissive.copy(droneFist.emissive)
        }
      }
      for (const c of model.children) c.visible = !friend
      if (friend) {
        opponentHead = buildHead(friend.head, { shell: drone.head.shell, edge: drone.accent, visor: drone.head.core }, 0.25, 1)
        model.add(opponentHead)
      }
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
      restoreHead()
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
      waves.clear()
      hitstopMs = redFlash = impactFlash = 0
      for (const w of Object.values(kick)) w.x = w.v = 0
      for (const g of gloves) g.punch = null
      gloves.forEach((g, i) => trails[i].reset(g.shown))
    },

    setShot(name) {
      shotRequest = name
    },

    hitstop(ms) {
      // Called right after droneHit or playerHit: if that impact is deferred, freeze on contact instead.
      if (lastPending) lastPending.hitstopMs = Math.max(lastPending.hitstopMs, ms)
      else hitstopMs = Math.max(hitstopMs, ms)
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
      const dt = sceneMs / 1000
      time += dt
      updateGloves(dt)
      if (twin) {
        // The player's robot reaches for the tracked gloves: its hidden fists sit where the gloves are,
        // so its arms connect to them. Rotated to face away, so the left glove maps to its +x fist.
        twin.root.updateMatrixWorld(true)
        for (const g of gloves) {
          const pod = twin.pods[g.hand === 'left' ? 1 : 0]
          if (pod) twin.body.worldToLocal(g.parts.group.getWorldPosition(pod.position))
        }
      }
      updateDrone(dt)
      flushPending()
      botRing.group.visible = !ko
      botRing.update(botMeter, realMs / 1000)
      playerRing.update(playerMeter, realMs / 1000)
      sparks.update(dt)
      nearSparks.update(dt)
      updateCamera(realMs / 1000)
      updateTrails(dt)
      waves.update(dt, camQuat)
      look?.update(realMs / 1000)
      dressing?.update(realTime)
    },

    render() {
      post.render()
    },

    dispose() {
      disposed = true
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
      for (const m of materials) {
        ;(m as Material & { map?: { dispose(): void } | null }).map?.dispose() // canvas textures on the ring
        m.dispose()
      }
      botRing.dispose()
      playerRing.dispose()
      for (const t of trails) t.dispose()
      waves.dispose()
      glowMap.dispose()
      vignetteMap.dispose()
      pending.length = 0
      look?.dispose()
      dressing?.dispose()
      post.dispose()
      renderer.dispose()
      renderer.forceContextLoss() // free the GL context so the dashboard can start other games
      canvas.remove()
    },
  }

  api.resize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight)
  return api
}
