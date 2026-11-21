// First-person boxing scene: tracked neon gloves, a low-poly cyber-drone, telegraph ring and impact feel.
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
import type { BoxingScene, HitResult, HitTarget, PunchKind, SlipKind } from './types.ts'
import {
  COLORS,
  DRONE,
  HALO_OPACITY,
  buildArena,
  buildDrone,
  buildGlove,
  createGlowTexture,
  createSparks,
  createVignetteTexture,
} from './sceneParts.ts'
import type { DroneHitPart, GloveParts } from './sceneParts.ts'

const EYE_Y = 1.6
const CAMERA_PITCH = -0.06
const MAX_DT_MS = 50
/** Critically damped glove spring (rad/s). 60 settles in about 75 ms; untracked gloves ease slower. */
const TRACK_OMEGA = 60
const IDLE_OMEGA = 18
const PUNCH_OUT_MS = 90
const PUNCH_BACK_MS = 160
const STRIKE_IN_MS = 120
const STRIKE_BACK_MS = 250
const STRIKE_LUNGE_M = 1.3
const KO_BURST_MS = 420
/** Arcade hit radius = visual sphere radius times this. */
const HIT_RADIUS_SCALE = 1.6
const SLIP_LEAN_M = 0.12
const DUCK_DROP_M = 0.15
/** Untracked glove poses in rig metres (x is mirrored per side). */
const GUARD_REST = { x: 0.15, y: -0.16, z: -0.48 }
const GUARD_HELD = { x: 0.115, y: -0.11, z: -0.44 }
/** Shoulder widths to rig metres for tracked wrists. */
const SW_TO_M = 0.6
/** Elbow angle (deg) to reach: 0 at 70, 1 at 175. */
const REACH_MIN_DEG = 70
const REACH_MAX_DEG = 175
/** How far each punch flies along the view ray, metres. */
const STRIKE_DEPTH: Record<PunchKind, number> = { jab: 1.7, cross: 1.85, hook: 1.5, uppercut: 1.45 }
/** Extra rotation at full extension for the LEFT glove; the right glove mirrors yaw and roll. */
const PUNCH_TWIST: Record<PunchKind, { pitch: number; yaw: number; roll: number }> = {
  jab: { pitch: -0.2, yaw: 0, roll: -0.5 },
  cross: { pitch: -0.2, yaw: -0.15, roll: -0.7 },
  hook: { pitch: -0.2, yaw: -0.7, roll: 1.3 },
  uppercut: { pitch: 0.8, yaw: 0, roll: 0 },
}

const WHITE = new Color(0xffffff)
const RED = new Color(COLORS.telegraph)
const GOLD = new Color(COLORS.counter)
const ACCENT = new Color(COLORS.drone)
const CORE = new Color(COLORS.droneCore)
const GLOVE_COLOR: Record<Hand, Color> = { left: new Color(COLORS.left), right: new Color(COLORS.right) }
const SPRAY_OUT = new Vector3(0, 0.25, 0.6)
const SPRAY_UP = new Vector3(0, 0.5, 0.2)
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
    parts: buildGlove(hand),
    joints: left
      ? { shoulder: LM.L_SHOULDER, elbow: LM.L_ELBOW, wrist: LM.L_WRIST }
      : { shoulder: LM.R_SHOULDER, elbow: LM.R_ELBOW, wrist: LM.R_WRIST },
    tracked: false,
    track: new Vector3(),
    pos: new Vector3((left ? -1 : 1) * GUARD_REST.x, GUARD_REST.y, GUARD_REST.z),
    vel: new Vector3(),
    shown: new Vector3(),
    punch: null,
    glow: 0,
  }
}

export function createBoxingScene(container: HTMLElement): BoxingScene {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(COLORS.bg, 1)
  const canvas = renderer.domElement
  canvas.style.display = 'block'
  container.appendChild(canvas)

  const scene = new Scene()
  scene.background = new Color(COLORS.bg)
  scene.fog = new Fog(COLORS.bg, 7, 18)
  const key = new DirectionalLight(0xffffff, 2.5)
  key.position.set(1.5, 4, 3)
  const rim = new DirectionalLight(COLORS.drone, 1.6)
  rim.position.set(-2, 3, -7)
  scene.add(new HemisphereLight(0x9fb2ff, 0x0c0e16, 1.5), key, rim)

  const glowMap = createGlowTexture()
  const vignetteMap = createVignetteTexture()
  scene.add(buildArena())
  const drone = buildDrone(glowMap)
  scene.add(drone.root, drone.floorGlow)
  const sparks = createSparks(720, 0.065, glowMap)
  const nearSparks = createSparks(160, 0.014, glowMap)
  scene.add(sparks.points, nearSparks.points)

  // Player rig at eye height: camera and gloves move together for slips and ducks.
  const rig = new Group()
  rig.position.set(0, EYE_Y, 0)
  scene.add(rig)
  const camera = new PerspectiveCamera(68, 1, 0.03, 60)
  camera.rotation.x = CAMERA_PITCH
  rig.add(camera)
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

  const leftGlove = makeGlove('left')
  const rightGlove = makeGlove('right')
  const gloves = [leftGlove, rightGlove]
  for (const g of gloves) rig.add(g.parts.group)
  const gloveOf = (hand: Hand): Glove => (hand === 'left' ? leftGlove : rightGlove)

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
  const tele = { active: false, ms: 0, duration: 600, phase: 0, progress: 0, level: 0 }
  let strike: { ms: number } | null = null
  let ko: { ms: number; vy: number; spin: number; burst: boolean } | null = null
  const pending: PendingEffect[] = []
  let lastPending: PendingEffect | null = null
  let shake = 0
  let redFlash = 0
  const lean = { x: 0, y: 0 }
  const tmpA = new Vector3()
  const tmpB = new Vector3()

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
      clamp(-(relY + 0.3) * 0.55 - 0.16, -0.65, 0.3), // three y is up, body y is down
      -(0.46 + 0.5 * reach),
    )
    return true
  }

  /** Rig-local spring target: the tracked wrist, or the guard pose. */
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
      springStep(g.pos, g.vel, gloveTarget(g, tmpA), g.tracked ? TRACK_OMEGA : IDLE_OMEGA, dt)
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
        0.3 + clamp(g.vel.y * 0.25, -0.35, 0.35) + (twist ? twist.pitch * w : 0),
        mirror * (-0.14 + (twist ? twist.yaw * w : 0)) + clamp(-g.vel.x * 0.15, -0.3, 0.3),
        mirror * (twist ? twist.roll * w : 0) + clamp(-g.vel.x * 0.3, -0.4, 0.4),
      )
      g.glow += ((guard ? 1 : 0) - g.glow) * Math.min(1, dt * 12)
      shell.emissiveIntensity = 0.5 + 0.9 * g.glow + 0.7 * w
      glow.opacity = 0.12 + 0.2 * g.glow + 0.18 * w
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

  function defer(ready: () => boolean, fire: () => void): void {
    const p: PendingEffect = { ready, fire, hitstopMs: 0 }
    pending.push(p)
    lastPending = p
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
    const color = counter ? GOLD : GLOVE_COLOR[hand]
    sparks.burst(impact, counter ? 70 : 30 + Math.round(damage * 2), color, counter ? 4.5 : 3.2, SPRAY_OUT, counter ? 0.6 : 0.45)
    sparks.burst(impact, 12, WHITE, 1.6, NO_BIAS, 0.18)
  }

  function applyPlayerHit(blocked: boolean): void {
    shake = Math.max(shake, blocked ? 0.03 : 0.09)
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

  function applyPart(part: DroneHitPart, f: number, tint: number): void {
    part.shell.emissive.setScalar(f)
    part.halo.opacity = HALO_OPACITY + 0.45 * f + 0.1 * tint
    part.core.color.copy(CORE).lerp(RED, tint).lerp(WHITE, f)
  }

  // ---------- drone ----------

  function updateKO(dt: number): void {
    if (!ko) return
    const { root, body } = drone
    ko.ms += dt * 1000
    ko.vy -= 9.8 * dt
    root.position.y = Math.max(0.3, root.position.y + ko.vy * dt)
    root.position.z -= 0.8 * dt
    body.rotation.x -= 3.2 * dt
    body.rotation.z += ko.spin * dt
    if (!ko.burst && ko.ms >= KO_BURST_MS) {
      ko.burst = true
      const c = partCenter(drone.chest, tmpA)
      sparks.burst(c, 170, ACCENT, 4.2, SPRAY_UP, 1.2)
      sparks.burst(c, 90, WHITE, 3, SPRAY_UP, 0.9)
      sparks.burst(c, 60, RED, 3.6, SPRAY_UP, 1)
      body.visible = false
      shake = Math.max(shake, 0.05)
    }
  }

  function updateDrone(dt: number): void {
    const ms = dt * 1000
    let lunge = 0
    if (strike) {
      strike.ms += ms
      if (strike.ms < STRIKE_IN_MS) lunge = easeInQuad(strike.ms / STRIKE_IN_MS)
      else if (strike.ms < STRIKE_IN_MS + STRIKE_BACK_MS) lunge = 1 - easeOutCubic((strike.ms - STRIKE_IN_MS) / STRIKE_BACK_MS)
      else strike = null
    }
    wobble(knockPitch, 13, 0.35, dt)
    wobble(knockRoll, 11, 0.35, dt)
    wobble(knockPush, 10, 0.5, dt)

    if (ko) updateKO(dt)
    else {
      drone.root.position.set(
        Math.sin(time * 0.6) * 0.08,
        DRONE.y + Math.sin(time * 1.7) * 0.05,
        DRONE.z + lunge * STRIKE_LUNGE_M + knockPush.x,
      )
      drone.body.rotation.set(
        knockPitch.x + lunge * 0.35 + Math.sin(time * 1.1) * 0.03,
        Math.sin(time * 0.5) * 0.12,
        Math.sin(time * 0.9) * 0.06 + knockRoll.x,
      )
    }
    drone.neckRing.rotation.z += dt * 2.2
    drone.pods.forEach((pod, i) => {
      pod.position.y = 0.04 + Math.sin(time * 2.2 + i * 1.7) * 0.025
      pod.position.z = 0.02 + lunge * 0.22
    })
    drone.thruster.scale.y = 0.85 + 0.15 * Math.sin(time * 31) + 0.08 * Math.sin(time * 17)
    drone.thruster.material.opacity = 0.38 + 0.1 * Math.sin(time * 23)

    // Telegraph: the ring grows into its guide ring and pulses faster as the strike nears.
    if (tele.active) {
      tele.ms += ms
      tele.progress = Math.min(1, tele.ms / tele.duration)
      tele.phase += dt * (7 + 32 * tele.progress)
      tele.level = 1
      if (tele.ms > tele.duration + 350) tele.active = false // no strike came: fade out
    } else {
      tele.level = Math.max(0, tele.level - dt / 0.1)
    }
    const charge = tele.progress * tele.level
    const pulse = 0.72 + 0.28 * Math.sin(tele.phase)
    drone.telegraph.visible = drone.telegraphGuide.visible = tele.level > 0 && !ko
    drone.telegraph.scale.setScalar(0.55 + 0.45 * tele.progress)
    drone.telegraph.material.opacity = (0.2 + 0.8 * tele.progress) * pulse * tele.level
    drone.telegraphGuide.material.opacity = 0.25 * charge

    flash.head = Math.max(0, flash.head - dt / 0.14)
    flash.chest = Math.max(0, flash.chest - dt / 0.14)
    applyPart(drone.head, flash.head, charge)
    applyPart(drone.chest, flash.chest, charge)
    drone.accent.color.copy(ACCENT).lerp(RED, charge)
    drone.floorGlow.material.color.copy(ACCENT).lerp(RED, charge)
    drone.floorGlow.material.opacity = ko?.burst ? 0.1 : 0.35
  }

  function updateCamera(real: number): void {
    realTime += real
    const k = 1 - Math.exp(-real * 14)
    lean.x += ((slip === 'left' ? -SLIP_LEAN_M : slip === 'right' ? SLIP_LEAN_M : 0) - lean.x) * k
    lean.y += ((slip === 'duck' ? -DUCK_DROP_M : 0) - lean.y) * k
    rig.position.set(lean.x, EYE_Y + lean.y, 0)
    rig.rotation.z = -lean.x * 0.4
    shake *= Math.exp(-real * 10)
    camera.position.set(Math.sin(realTime * 71) * shake, Math.sin(realTime * 53 + 1.3) * shake * 0.8, 0)
    camera.rotation.set(CAMERA_PITCH + Math.sin(realTime * 41) * shake * 0.5, 0, Math.sin(realTime * 37) * shake * 1.2)
    redFlash = Math.max(0, redFlash - real / 0.35)
    vignetteMat.opacity = redFlash * 0.75
    vignette.visible = redFlash > 0
  }

  // ---------- API ----------

  const api: BoxingScene = {
    canvas,

    resize(width, height) {
      const w = Math.max(1, Math.round(width))
      const h = Math.max(1, Math.round(height))
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.fov = camera.aspect < 0.9 ? 80 : 68 // portrait screens need more height to fit the drone
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
      if (hit) focus.lerp(partCenter(hit.part, tmpA), 0.6)
      focus.z = drone.root.position.z
      // Fly along the eye ray through the focus point so the glove visually lands on it.
      const eye = rig.getWorldPosition(new Vector3())
      const ray = focus.sub(eye)
      const depth = Math.min(STRIKE_DEPTH[kind], Math.max(0.6, -ray.z - 0.15))
      ray.multiplyScalar(depth / Math.max(0.5, -ray.z))
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

    droneTelegraph(ms) {
      if (ko) return
      tele.active = true
      tele.ms = 0
      tele.duration = Math.max(1, ms)
      tele.progress = 0
      tele.phase = 0
      tele.level = 1
    },

    droneStrike() {
      if (ko) return
      tele.active = false
      strike = { ms: 0 }
    },

    droneHit(result, damage, counter) {
      const hand = lastHand
      const kind = lastKind
      const aim = lastHit && lastHit.target === result.target ? lastHit.aim.clone() : null
      const fire = (): void => applyDroneHit(result, damage, counter, hand, kind, aim)
      const anim = gloveOf(hand).punch
      lastPending = null
      // Land the impact when the glove reaches its apex.
      if (anim && anim.ms < PUNCH_OUT_MS) defer(() => anim.ms >= PUNCH_OUT_MS || gloveOf(hand).punch !== anim, fire)
      else fire()
    },

    playerHit(blocked) {
      const s = strike
      lastPending = null
      // Land the impact when the lunge arrives.
      if (s && s.ms < STRIKE_IN_MS) defer(() => strike !== s || s.ms >= STRIKE_IN_MS, () => applyPlayerHit(blocked))
      else applyPlayerHit(blocked)
    },

    droneKO() {
      if (ko) return
      ko = { ms: 0, vy: 1.4, spin: (lastHand === 'left' ? -1 : 1) * 3.5, burst: false }
      flash.head = flash.chest = 1
      tele.active = false
      strike = null
    },

    resetRound() {
      ko = null
      strike = null
      pending.length = 0
      lastPending = null
      lastHit = null
      tele.active = false
      tele.progress = tele.level = 0
      flash.head = flash.chest = 0
      for (const w of [knockPitch, knockRoll, knockPush]) w.x = w.v = 0
      drone.body.visible = true
      drone.body.rotation.set(0, 0, 0)
      drone.root.position.set(0, DRONE.y, DRONE.z)
      sparks.clear()
      nearSparks.clear()
      hitstopMs = shake = redFlash = 0
      for (const g of gloves) g.punch = null
    },

    hitstop(ms) {
      // Called right after droneHit or playerHit: if that impact is deferred, freeze on contact instead.
      if (lastPending) lastPending.hitstopMs = Math.max(lastPending.hitstopMs, ms)
      else hitstopMs = Math.max(hitstopMs, ms)
    },

    update(dtMs) {
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
      updateDrone(dt)
      flushPending()
      sparks.update(dt)
      nearSparks.update(dt)
      updateCamera(realMs / 1000)
    },

    render() {
      renderer.render(scene, camera)
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
      glowMap.dispose()
      vignetteMap.dispose()
      pending.length = 0
      renderer.dispose()
      canvas.remove()
    },
  }

  api.resize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight)
  return api
}
