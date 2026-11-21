// Goalkeeper physics, zones, mapping and 1-euro filter (pure TypeScript, Node environment).
import { describe, expect, test } from 'vitest'
import type { BallState, Vec3, Zone } from '../../src/sports/goalkeeper/types.ts'
import {
  BALL_RADIUS,
  GLOVE_RADIUS,
  GOAL_HALF_WIDTH,
  GOAL_HEIGHT,
  GOAL_Z,
  GRAVITY,
  K_MAGNUS,
  PENALTY_Z,
  PHYS_DT,
  RESTITUTION,
  TORSO_RADIUS,
  cross,
  dot,
  inGoalMouth,
  length,
  resolveSave,
  solveLaunch,
  stepBall,
  sub,
  sweptCapsuleHit,
  sweptSphereHit,
  vec3,
  zoneOf,
  zoneTarget,
} from '../../src/sports/goalkeeper/physics.ts'
import { bodyToGoal, edgeCurve } from '../../src/sports/goalkeeper/mapping.ts'
import { OneEuroFilter, OneEuroVec3 } from '../../src/sports/goalkeeper/filter.ts'
import { mulberry32 } from '../../src/sports/goalkeeper/striker.ts'

const SPOT: Vec3 = { x: 0, y: BALL_RADIUS, z: PENALTY_Z }
const ALL_ZONES: Zone[] = [0, 1, 2, 3, 4, 5, 6, 7, 8]

/** Step a ball until its centre crosses z = planeZ; returns the interpolated crossing point and time. */
function flyToPlane(p: Vec3, v: Vec3, omega: Vec3, planeZ = GOAL_Z, maxS = 5): { point: Vec3; time: number } {
  const ball: BallState = { p: { ...p }, v: { ...v }, omega: { ...omega } }
  let t = 0
  while (t < maxS) {
    const prev = { ...ball.p }
    stepBall(ball, PHYS_DT)
    t += PHYS_DT
    if (prev.z < planeZ && ball.p.z >= planeZ) {
      const f = (planeZ - prev.z) / (ball.p.z - prev.z)
      return {
        point: { x: prev.x + (ball.p.x - prev.x) * f, y: prev.y + (ball.p.y - prev.y) * f, z: planeZ },
        time: t - PHYS_DT + f * PHYS_DT,
      }
    }
  }
  throw new Error('ball never crossed the plane')
}

function dist(a: Vec3, b: Vec3): number {
  return length(sub(a, b))
}

describe('constants', () => {
  test('match the contract in types.ts', () => {
    expect(GOAL_HALF_WIDTH).toBe(3.66)
    expect(GOAL_HEIGHT).toBe(2.44)
    expect(GOAL_Z).toBe(0)
    expect(PENALTY_Z).toBe(-11)
    expect(BALL_RADIUS).toBe(0.11)
    expect(GLOVE_RADIUS).toBe(0.38)
    expect(TORSO_RADIUS).toBe(0.28)
    expect(RESTITUTION).toBe(0.65)
    expect(PHYS_DT).toBeCloseTo(1 / 60, 12)
    expect(GRAVITY).toBeCloseTo(-9.81, 6)
  })
})

describe('stepBall', () => {
  test('one step matches a = g + K_MAGNUS (omega x v), semi-implicit Euler', () => {
    const p0 = vec3(0.2, 1.0, -5)
    const v0 = vec3(1.5, 3.0, 14)
    const w0 = vec3(4, 30, -2)
    const ball: BallState = { p: { ...p0 }, v: { ...v0 }, omega: { ...w0 } }
    const dt = PHYS_DT
    stepBall(ball, dt)
    const m = cross(w0, v0)
    const vExp = {
      x: v0.x + K_MAGNUS * m.x * dt,
      y: v0.y + (GRAVITY + K_MAGNUS * m.y) * dt,
      z: v0.z + K_MAGNUS * m.z * dt,
    }
    expect(ball.v.x).toBeCloseTo(vExp.x, 12)
    expect(ball.v.y).toBeCloseTo(vExp.y, 12)
    expect(ball.v.z).toBeCloseTo(vExp.z, 12)
    // Semi-implicit: position uses the NEW velocity.
    expect(ball.p.x).toBeCloseTo(p0.x + vExp.x * dt, 12)
    expect(ball.p.y).toBeCloseTo(p0.y + vExp.y * dt, 12)
    expect(ball.p.z).toBeCloseTo(p0.z + vExp.z * dt, 12)
    // Light spin decay: strictly smaller but within 1%.
    expect(Math.abs(ball.omega.y)).toBeLessThan(30)
    expect(Math.abs(ball.omega.y)).toBeGreaterThan(29.7)
  })

  test('zero spin is pure ballistic flight', () => {
    const v0 = vec3(1.2, 4.0, 13.75)
    const ball: BallState = { p: { ...SPOT }, v: { ...v0 }, omega: vec3(0, 0, 0) }
    const n = 48 // 0.8 s
    for (let i = 0; i < n; i++) stepBall(ball, PHYS_DT)
    const t = n * PHYS_DT
    // No lateral or longitudinal acceleration.
    expect(ball.v.x).toBeCloseTo(v0.x, 12)
    expect(ball.v.z).toBeCloseTo(v0.z, 12)
    expect(ball.p.x).toBeCloseTo(SPOT.x + v0.x * t, 9)
    expect(ball.p.z).toBeCloseTo(SPOT.z + v0.z * t, 9)
    // Exact discrete semi-implicit result, and within ~g dt t / 2 of the continuous parabola.
    const discrete = SPOT.y + v0.y * t + GRAVITY * PHYS_DT * PHYS_DT * ((n * (n + 1)) / 2)
    expect(ball.p.y).toBeCloseTo(discrete, 9)
    const continuous = SPOT.y + v0.y * t + 0.5 * GRAVITY * t * t
    expect(Math.abs(ball.p.y - continuous)).toBeLessThan(0.08)
  })

  test('sidespin about +y curves the ball toward +x by a visible 0.3 to 1.0 m', () => {
    const v0 = vec3(0, 4.0, 13.75)
    const plain = flyToPlane(SPOT, v0, vec3(0, 0, 0))
    const curlPos = flyToPlane(SPOT, v0, vec3(0, 30, 0))
    const curlNeg = flyToPlane(SPOT, v0, vec3(0, -30, 0))
    expect(plain.point.x).toBeCloseTo(0, 9)
    const dPos = curlPos.point.x - plain.point.x
    const dNeg = curlNeg.point.x - plain.point.x
    expect(dPos).toBeGreaterThan(0.3)
    expect(dPos).toBeLessThan(1.0)
    expect(dNeg).toBeLessThan(-0.3)
    expect(dNeg).toBeGreaterThan(-1.0)
    // Symmetric, and more spin curves more.
    expect(dPos).toBeCloseTo(-dNeg, 6)
    const curlBig = flyToPlane(SPOT, v0, vec3(0, 40, 0))
    expect(curlBig.point.x).toBeGreaterThan(curlPos.point.x)
  })
})

describe('solveLaunch', () => {
  const rng = mulberry32(1234)
  const cases: { zone: Zone; spin: number; T: number; target: Vec3 }[] = []
  for (const zone of ALL_ZONES)
    for (const spin of [30, 0, -30])
      for (const T of [0.68, 0.95]) cases.push({ zone, spin, T, target: zoneTarget(zone, rng) })

  test.each(cases)('zone $zone spin $spin T $T crosses the goal plane within 2 cm', ({ target, spin, T }) => {
    const omega = vec3(0, spin, 0)
    const v = solveLaunch(SPOT, target, T, omega)
    const hit = flyToPlane(SPOT, v, omega)
    expect(Math.hypot(hit.point.x - target.x, hit.point.y - target.y)).toBeLessThan(0.02)
    // Flight time stays near the request.
    expect(Math.abs(hit.time - T)).toBeLessThan(0.1)
    // The aim compensates for curl: with spin, the launch direction leans against it.
    if (spin !== 0) {
      const vNoSpin = solveLaunch(SPOT, target, T, vec3(0, 0, 0))
      expect(Math.sign(v.x - vNoSpin.x)).toBe(-Math.sign(spin))
    }
  })
})

describe('zones', () => {
  test('numbering: row 0 top, col 0 = -x', () => {
    const cw = (2 * GOAL_HALF_WIDTH) / 3
    const ch = GOAL_HEIGHT / 3
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++) {
        const x = -GOAL_HALF_WIDTH + (col + 0.5) * cw
        const y = GOAL_HEIGHT - (row + 0.5) * ch
        expect(zoneOf(x, y)).toBe(row * 3 + col)
      }
    expect(zoneOf(-3, 2.3)).toBe(0)
    expect(zoneOf(3, 2.3)).toBe(2)
    expect(zoneOf(0, 1.22)).toBe(4)
    expect(zoneOf(-3, 0.2)).toBe(6)
    expect(zoneOf(3, 0.2)).toBe(8)
    // Outside the mouth clamps to the nearest zone.
    expect(zoneOf(-10, 10)).toBe(0)
    expect(zoneOf(10, -1)).toBe(8)
  })

  test('zoneTarget round-trips through zoneOf and stays inside the mouth', () => {
    const rng = mulberry32(99)
    for (const zone of ALL_ZONES)
      for (let i = 0; i < 200; i++) {
        const t = zoneTarget(zone, rng)
        expect(zoneOf(t.x, t.y)).toBe(zone)
        expect(t.z).toBe(GOAL_Z)
        expect(inGoalMouth(t.x, t.y)).toBe(true)
        expect(Math.abs(t.x)).toBeLessThan(GOAL_HALF_WIDTH - BALL_RADIUS)
        expect(t.y).toBeGreaterThan(BALL_RADIUS)
        expect(t.y).toBeLessThan(GOAL_HEIGHT - BALL_RADIUS)
      }
  })

  test('zoneTarget is deterministic for a seeded rng', () => {
    const a = zoneTarget(4, mulberry32(5))
    const b = zoneTarget(4, mulberry32(5))
    const c = zoneTarget(4, mulberry32(6))
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  test('inGoalMouth edges (posts minus ball radius, ground, bar)', () => {
    const post = GOAL_HALF_WIDTH - BALL_RADIUS // 3.55
    expect(inGoalMouth(0, 1.2)).toBe(true)
    expect(inGoalMouth(post - 0.01, 1.2)).toBe(true)
    expect(inGoalMouth(-(post - 0.01), 1.2)).toBe(true)
    expect(inGoalMouth(post + 0.01, 1.2)).toBe(false)
    expect(inGoalMouth(-(post + 0.01), 1.2)).toBe(false)
    expect(inGoalMouth(0, BALL_RADIUS * 0.5 + 0.005)).toBe(true)
    expect(inGoalMouth(0, BALL_RADIUS * 0.5 - 0.005)).toBe(false)
    expect(inGoalMouth(0, GOAL_HEIGHT - BALL_RADIUS - 0.01)).toBe(true)
    expect(inGoalMouth(0, GOAL_HEIGHT - BALL_RADIUS + 0.01)).toBe(false)
  })
})

describe('sweptSphereHit', () => {
  const R = BALL_RADIUS + GLOVE_RADIUS // 0.49
  const step = 30 * PHYS_DT // 0.5 m per step at 30 m/s

  test('detects a 30 m/s ball tunnelling through a still glove in one step', () => {
    const glove = vec3(0, 1, 0)
    const off = 0.45
    const b0 = vec3(off, 1, -step / 2)
    const b1 = vec3(off, 1, step / 2)
    // Both endpoints are outside contact: a discrete test would miss it.
    expect(dist(b0, glove)).toBeGreaterThan(R)
    expect(dist(b1, glove)).toBeGreaterThan(R)
    const hit = sweptSphereHit(b0, b1, BALL_RADIUS, glove, glove, GLOVE_RADIUS)
    expect(hit).not.toBeNull()
    const zEntry = -Math.sqrt(R * R - off * off)
    expect(hit!.t).toBeCloseTo((zEntry - b0.z) / step, 6)
    expect(hit!.point.z).toBeCloseTo(zEntry, 6)
    expect(dist(hit!.point, glove)).toBeCloseTo(R, 6)
  })

  test('returns the earliest (entry) contact, not the exit', () => {
    const glove = vec3(0, 1, 0)
    const b0 = vec3(0.1, 1, -0.6)
    const b1 = vec3(0.1, 1, 0.6)
    const hit = sweptSphereHit(b0, b1, BALL_RADIUS, glove, glove, GLOVE_RADIUS)!
    expect(hit).not.toBeNull()
    expect(hit.point.z).toBeLessThan(0)
    const at = (t: number) => vec3(0.1, 1, -0.6 + 1.2 * t)
    expect(dist(at(hit.t - 1e-3), glove)).toBeGreaterThan(R)
    expect(dist(at(hit.t), glove)).toBeCloseTo(R, 6)
  })

  test('detects a glove moving into the ball path', () => {
    const b0 = vec3(0, 1, -step / 2)
    const b1 = vec3(0, 1, step / 2)
    const c0 = vec3(1.0, 1, 0)
    const c1 = vec3(0, 1, 0)
    // The glove standing still at its start would miss.
    expect(sweptSphereHit(b0, b1, BALL_RADIUS, c0, c0, GLOVE_RADIUS)).toBeNull()
    const hit = sweptSphereHit(b0, b1, BALL_RADIUS, c0, c1, GLOVE_RADIUS)
    expect(hit).not.toBeNull()
    const cAt = vec3(1.0 - hit!.t, 1, 0)
    expect(dist(hit!.point, cAt)).toBeCloseTo(R, 6)
    expect(hit!.t).toBeGreaterThan(0)
    expect(hit!.t).toBeLessThan(1)
  })

  test('rejects a clear miss and a ball moving away', () => {
    const glove = vec3(0, 1, 0)
    expect(sweptSphereHit(vec3(0.6, 1, -0.25), vec3(0.6, 1, 0.25), BALL_RADIUS, glove, glove, GLOVE_RADIUS)).toBeNull()
    expect(sweptSphereHit(vec3(R + 0.001, 1, -0.25), vec3(R + 0.001, 1, 0.25), BALL_RADIUS, glove, glove, GLOVE_RADIUS)).toBeNull()
    expect(sweptSphereHit(vec3(0, 1, -0.6), vec3(0, 1, -1.1), BALL_RADIUS, glove, glove, GLOVE_RADIUS)).toBeNull()
  })

  test('normal is unit length and points from the collider toward the ball', () => {
    const rng = mulberry32(42)
    for (let i = 0; i < 100; i++) {
      const glove = vec3(rng() * 2 - 1, 1 + rng(), 0)
      const rad = rng() * 0.45
      const ang = rng() * 2 * Math.PI
      const ox = rad * Math.cos(ang)
      const oy = rad * Math.sin(ang)
      const b0 = vec3(glove.x + ox, glove.y + oy, -0.7)
      const b1 = vec3(glove.x + ox, glove.y + oy, 0)
      const hit = sweptSphereHit(b0, b1, BALL_RADIUS, glove, glove, GLOVE_RADIUS)
      expect(hit).not.toBeNull()
      expect(length(hit!.normal)).toBeCloseTo(1, 9)
      const toBall = sub(hit!.point, glove)
      expect(dot(hit!.normal, toBall)).toBeCloseTo(length(toBall), 6)
      expect(hit!.normal.z).toBeLessThan(0) // ball approaches from -z
    }
  })

  test('overlap at the start returns t = 0 with the collider-to-ball normal', () => {
    const glove = vec3(0, 1, 0)
    const b0 = vec3(0.2, 1, -0.2)
    const hit = sweptSphereHit(b0, vec3(0.2, 1, 0.3), BALL_RADIUS, glove, glove, GLOVE_RADIUS)
    expect(hit).not.toBeNull()
    expect(hit!.t).toBe(0)
    expect(hit!.point).toEqual(b0)
    expect(hit!.normal.x).toBeCloseTo(Math.SQRT1_2, 9)
    expect(hit!.normal.z).toBeCloseTo(-Math.SQRT1_2, 9)
  })
})

describe('sweptCapsuleHit', () => {
  const a = vec3(0, 0.5, 0)
  const b = vec3(0, 1.5, 0)
  const R = BALL_RADIUS + TORSO_RADIUS // 0.39
  const step = 30 * PHYS_DT

  test('no tunnelling at 30 m/s over seeded lateral offsets inside the radius', () => {
    const rng = mulberry32(2024)
    let tunnelCases = 0
    for (let i = 0; i < 500; i++) {
      const x = (rng() * 2 - 1) * (R - 0.002)
      const y = 0.5 + rng() * 1.0
      const z0 = -step / 2 + (rng() - 0.5) * 0.1
      const b0 = vec3(x, y, z0)
      const b1 = vec3(x, y, z0 + step)
      if (Math.hypot(x, z0) > R && Math.hypot(x, z0 + step) > R) tunnelCases++
      const hit = sweptCapsuleHit(b0, b1, BALL_RADIUS, a, b, TORSO_RADIUS)
      expect(hit, `offset x=${x.toFixed(3)} y=${y.toFixed(3)}`).not.toBeNull()
      const zEntry = -Math.sqrt(R * R - x * x)
      const tExp = Math.max(0, (zEntry - z0) / step)
      expect(hit!.t).toBeCloseTo(tExp, 4)
      expect(length(hit!.normal)).toBeCloseTo(1, 9)
      expect(hit!.normal.z).toBeLessThanOrEqual(1e-9)
    }
    // Plenty of cases where both endpoints are outside (true tunnelling).
    expect(tunnelCases).toBeGreaterThan(50)
  })

  test('hits on the end caps beyond the segment', () => {
    const hit = sweptCapsuleHit(vec3(0, 1.5 + R - 0.01, -0.25), vec3(0, 1.5 + R - 0.01, 0.25), BALL_RADIUS, a, b, TORSO_RADIUS)
    expect(hit).not.toBeNull()
    expect(hit!.normal.y).toBeGreaterThan(0.5)
  })

  test('misses just outside the radius sum, hits just inside', () => {
    for (const sign of [-1, 1]) {
      const outX = sign * (R + 0.005)
      const inX = sign * (R - 0.005)
      expect(sweptCapsuleHit(vec3(outX, 1, -0.25), vec3(outX, 1, 0.25), BALL_RADIUS, a, b, TORSO_RADIUS)).toBeNull()
      expect(sweptCapsuleHit(vec3(inX, 1, -0.25), vec3(inX, 1, 0.25), BALL_RADIUS, a, b, TORSO_RADIUS)).not.toBeNull()
    }
    // Above the top cap and below the bottom cap.
    expect(sweptCapsuleHit(vec3(0, 1.5 + R + 0.005, -0.25), vec3(0, 1.5 + R + 0.005, 0.25), BALL_RADIUS, a, b, TORSO_RADIUS)).toBeNull()
    expect(sweptCapsuleHit(vec3(0, 0.5 - R - 0.005, -0.25), vec3(0, 0.5 - R - 0.005, 0.25), BALL_RADIUS, a, b, TORSO_RADIUS)).toBeNull()
  })

  test('starting inside returns t = 0', () => {
    const hit = sweptCapsuleHit(vec3(0.1, 1, -0.1), vec3(0.1, 1, 0.4), BALL_RADIUS, a, b, TORSO_RADIUS)
    expect(hit).not.toBeNull()
    expect(hit!.t).toBe(0)
  })
})

describe('resolveSave', () => {
  const glove = vec3(0, 1, 0)
  function headOn(speed: number): { ball: BallState; hit: NonNullable<ReturnType<typeof sweptSphereHit>> } {
    const ball: BallState = { p: vec3(0, 1, -0.3), v: vec3(0, 0, speed), omega: vec3(0, 20, 0) }
    const hit = sweptSphereHit(vec3(0, 1, -0.8), vec3(0, 1, -0.3), BALL_RADIUS, glove, glove, GLOVE_RADIUS)!
    expect(hit).not.toBeNull()
    expect(hit.normal.z).toBeCloseTo(-1, 9)
    return { ball, hit }
  }

  test('still glove: normal speed ratio = restitution, ball heads out (v.z < 0)', () => {
    const { ball, hit } = headOn(20)
    resolveSave(ball, hit, vec3(0, 0, 0))
    expect(ball.v.z).toBeLessThan(0)
    expect(-ball.v.z / 20).toBeCloseTo(RESTITUTION, 9)
    expect(ball.v.x).toBeCloseTo(0, 9)
    // Pushed just out of contact along the normal.
    expect(ball.p.z).toBeCloseTo(hit.point.z - 0.001, 9)
  })

  test('punching glove (0, 0, -4) clears harder than a still glove', () => {
    const still = headOn(20)
    resolveSave(still.ball, still.hit, vec3(0, 0, 0))
    const punch = headOn(20)
    resolveSave(punch.ball, punch.hit, vec3(0, 0, -4))
    // -(0.65 * 24) + 0.6 * -4 = -18
    expect(punch.ball.v.z).toBeCloseTo(-18, 6)
    expect(punch.ball.v.z).toBeLessThan(still.ball.v.z - 3)
  })

  test('glancing contact still forces v.z <= -1', () => {
    const n = { x: 0.998, y: 0, z: -0.0632 }
    const l = length(n)
    const hit = { t: 0.5, point: vec3(0.49, 1, -0.03), normal: { x: n.x / l, y: 0, z: n.z / l } }
    const ball: BallState = { p: vec3(0.49, 1, -0.03), v: vec3(0, 0, 20), omega: vec3(0, 0, 0) }
    resolveSave(ball, hit, vec3(0, 0, 0))
    expect(ball.v.z).toBeLessThanOrEqual(-1)
    expect(ball.v.z).toBeCloseTo(-1, 9)
    // Sideways deflection away from the glove.
    expect(ball.v.x).toBeGreaterThan(0)
  })

  test('spin is scaled by 0.3', () => {
    const { ball, hit } = headOn(20)
    ball.omega = vec3(5, 30, -10)
    resolveSave(ball, hit, vec3(0, 0, 0))
    expect(ball.omega.x).toBeCloseTo(1.5, 9)
    expect(ball.omega.y).toBeCloseTo(9, 9)
    expect(ball.omega.z).toBeCloseTo(-3, 9)
  })
})

describe('mapping', () => {
  test('edgeCurve is odd, fixes 0 and +-1, and expands toward the edges', () => {
    expect(edgeCurve(0)).toBe(0)
    expect(edgeCurve(1)).toBeCloseTo(1, 12)
    expect(edgeCurve(-1)).toBeCloseTo(-1, 12)
    expect(edgeCurve(0.5)).toBeCloseTo(Math.pow(0.5, 0.85), 12)
    expect(edgeCurve(-0.5)).toBeCloseTo(-edgeCurve(0.5), 12)
    expect(edgeCurve(0.5)).toBeGreaterThan(0.5)
    expect(edgeCurve(-0.3)).toBeLessThan(0)
  })

  test('bodyToGoal maps the reach box centre and corners onto the goal', () => {
    const c = bodyToGoal(0, -0.25)
    expect(c.x).toBeCloseTo(0, 9)
    expect(c.y).toBeCloseTo((GOAL_HEIGHT + 0.2) / 2, 9)
    const tl = bodyToGoal(-1.25, -1.0)
    expect(tl.x).toBeCloseTo(-GOAL_HALF_WIDTH, 9)
    expect(tl.y).toBeCloseTo(GOAL_HEIGHT, 9)
    const tr = bodyToGoal(1.25, -1.0)
    expect(tr.x).toBeCloseTo(GOAL_HALF_WIDTH, 9)
    expect(tr.y).toBeCloseTo(GOAL_HEIGHT, 9)
    const bl = bodyToGoal(-1.25, 0.5)
    expect(bl.x).toBeCloseTo(-GOAL_HALF_WIDTH, 9)
    expect(bl.y).toBeCloseTo(0.2, 9)
    // Screen right (+bx) is +x, body y down is world y down.
    expect(bodyToGoal(0.5, -0.3).x).toBeGreaterThan(0)
    expect(bodyToGoal(0, -0.8).y).toBeGreaterThan(c.y)
  })

  test('bodyToGoal clamps overreach and never goes below the floor', () => {
    const far = bodyToGoal(10, -0.3)
    expect(far.x).toBeGreaterThan(GOAL_HALF_WIDTH)
    expect(far.x).toBeCloseTo(Math.pow(1.12, 0.85) * GOAL_HALF_WIDTH, 9)
    expect(bodyToGoal(50, -0.3)).toEqual(far)
    expect(bodyToGoal(0, 10).y).toBeGreaterThanOrEqual(0.05)
  })
})

describe('OneEuroFilter', () => {
  test('smooths constant jitter', () => {
    const rng = mulberry32(7)
    const f = new OneEuroFilter()
    const raw: number[] = []
    const out: number[] = []
    for (let i = 0; i < 600; i++) {
      const v = 1 + (rng() * 2 - 1) * 0.05
      raw.push(v)
      out.push(f.filter(v, i / 60))
    }
    const sd = (xs: number[]) => {
      const tail = xs.slice(120)
      const m = tail.reduce((s, x) => s + x, 0) / tail.length
      return Math.sqrt(tail.reduce((s, x) => s + (x - m) ** 2, 0) / tail.length)
    }
    expect(sd(out)).toBeLessThan(sd(raw) * 0.5)
    expect(Math.abs(out[out.length - 1] - 1)).toBeLessThan(0.03)
  })

  test('converges on a step', () => {
    const f = new OneEuroFilter()
    let y = 0
    for (let i = 0; i < 60; i++) y = f.filter(0, i / 60)
    expect(y).toBe(0)
    const after: number[] = []
    for (let i = 60; i < 240; i++) after.push(f.filter(1, i / 60))
    expect(after[0]).toBeGreaterThan(0)
    expect(after[0]).toBeLessThan(1) // lags
    for (let i = 1; i < after.length; i++) expect(after[i]).toBeGreaterThanOrEqual(after[i - 1])
    expect(after[after.length - 1]).toBeGreaterThan(0.99)
  })

  test('first sample passes through; non-increasing time returns the previous value', () => {
    const f = new OneEuroFilter()
    expect(f.filter(3, 1)).toBe(3)
    expect(f.filter(10, 1)).toBe(3)
    f.reset()
    expect(f.filter(10, 2)).toBe(10)
  })

  test('OneEuroVec3 filters each axis', () => {
    const f = new OneEuroVec3()
    f.filter(vec3(0, 0, 0), 0)
    const r = f.filter(vec3(1, -1, 0), 1 / 60)
    expect(r.x).toBeGreaterThan(0)
    expect(r.x).toBeLessThan(1)
    expect(r.y).toBeCloseTo(-r.x, 12)
    expect(r.z).toBe(0)
  })
})
