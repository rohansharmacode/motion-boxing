// Aero Bow physics tests. Run: node --test tests/archery/physics.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRIFT_AMPLITUDE,
  MAX_FLIGHT_S,
  PHYS_DT,
  WIND_RANGES,
  launchSpeed,
  ringScore,
  sampleFlight,
  simulateShot,
  solveLaunch,
  targetCenterAt,
  windForArrow,
} from '../../src/sports/archery/physics.ts'
import {
  LAUNCH_POS,
  TARGET_CENTER,
  TARGET_RADIUS,
  TARGET_Z,
  V0_BASE,
  V0_GAIN,
  WIND_FIRST_ARROW,
} from '../../src/sports/archery/types.ts'
import type { ShotFlight, Vec2, Vec3 } from '../../src/sports/archery/types.ts'

const still = (): Vec2 => ({ x: TARGET_CENTER.x, y: TARGET_CENTER.y })
const aimAt = (x: number, y: number): Vec3 => ({ x, y, z: TARGET_Z })
const mag = (v: Vec3): number => Math.hypot(v.x, v.y, v.z)

function shoot(aim: Vec3, tension: number, windAccel = 0, center: (ms: number) => Vec2 = still): ShotFlight {
  const velocity = solveLaunch(LAUNCH_POS, aim, launchSpeed(tension))
  return simulateShot({ from: LAUNCH_POS, velocity, windAccel, targetCenterAt: center })
}

function assertFinite3(v: Vec3, label: string): void {
  assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z), `${label} not finite`)
}

// Linear-congruential rng for repeatable sweeps.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

test('launchSpeed maps tension 0..1 to V0_BASE..V0_BASE+V0_GAIN', () => {
  assert.equal(launchSpeed(0), V0_BASE)
  assert.equal(launchSpeed(1), V0_BASE + V0_GAIN)
  assert.equal(launchSpeed(0.5), V0_BASE + V0_GAIN / 2)
  assert.equal(launchSpeed(-2), V0_BASE)
  assert.equal(launchSpeed(3), V0_BASE + V0_GAIN)
  assert.equal(launchSpeed(NaN), V0_BASE)
})

test('solveLaunch + simulateShot hit the aim within 2 mm with zero wind', () => {
  const aims: [number, number][] = [
    [0, 1.5], // centre
    [-0.95, 1.5], // left edge
    [0.95, 1.5], // right edge
    [0, 2.45], // top edge
    [0, 0.55], // bottom edge
    [0.6, 2.2], // upper right
    [-0.7, 0.9], // lower left
    [0, 3.5], // above the face
    [0, 0.2], // below the face
  ]
  for (const tension of [0, 0.5, 1]) {
    for (const [x, y] of aims) {
      const aim = aimAt(x, y)
      const v = solveLaunch(LAUNCH_POS, aim, launchSpeed(tension))
      assert.ok(Math.abs(mag(v) - launchSpeed(tension)) < 1e-9, 'speed preserved')
      const f = shoot(aim, tension)
      const tag = `tension ${tension} aim (${x}, ${y})`
      assert.equal(f.end, 'target', tag)
      assert.equal(f.impact.z, TARGET_Z, tag)
      const miss = Math.hypot(f.impact.x - x, f.impact.y - y)
      assert.ok(miss < 0.002, `${tag}: miss ${miss}`)
      assert.ok(f.hit !== null)
      const r = Math.hypot(x - TARGET_CENTER.x, y - TARGET_CENTER.y)
      assert.ok(Math.abs(f.radius - r) < 0.002, tag)
      assert.equal(f.windErrX, 0)
    }
  }
})

test('a centred full-draw shot scores 10 and the face edge is a miss', () => {
  assert.equal(shoot(aimAt(0, 1.5), 1).score, 10)
  assert.equal(shoot(aimAt(0.25, 1.5), 0.5).score, 8)
  assert.equal(shoot(aimAt(0, 1.5 + TARGET_RADIUS + 0.05), 1).score, 0)
})

test('ringScore boundaries', () => {
  assert.equal(ringScore(0), 10)
  assert.equal(ringScore(0.0999), 10)
  assert.equal(ringScore(0.0999999), 10)
  assert.equal(ringScore(0.1), 9)
  assert.equal(ringScore(0.15), 9)
  assert.equal(ringScore(0.3), 7)
  assert.equal(ringScore(0.7), 3)
  assert.equal(ringScore(0.95), 1)
  assert.equal(ringScore(0.9999), 1)
  assert.equal(ringScore(1.0), 0)
  assert.equal(ringScore(1.5), 0)
  assert.equal(ringScore(Infinity), 0)
  assert.equal(ringScore(-0.1), 0)
  assert.equal(ringScore(NaN), 0)
  // Every boundary, written both as a literal and as a product.
  for (let k = 1; k < 10; k++) {
    assert.equal(ringScore(k * 0.1), 10 - k, `k*0.1 k=${k}`)
    assert.equal(ringScore(Number((k / 10).toFixed(1))), 10 - k, `literal k=${k}`)
    assert.equal(ringScore(k / 10 - 1e-6), 11 - k, `just inside k=${k}`)
  }
})

test('windErrX equals 0.5 a t^2 and shifts the impact by exactly that', () => {
  for (const tension of [0.7, 1]) {
    for (const a of [-3.4, -1.7, 2.3, 3.4]) {
      const aim = aimAt(0.2, 1.4)
      const calm = shoot(aim, tension, 0)
      const windy = shoot(aim, tension, a)
      const t = windy.flightMs / 1000
      assert.ok(Math.abs(windy.windErrX - 0.5 * a * t * t) < 1e-12)
      assert.ok(Math.abs(windy.flightMs - calm.flightMs) < 1e-9, 'wind does not change flight time')
      assert.ok(Math.abs(windy.impact.x - calm.impact.x - windy.windErrX) < 1e-9)
      assert.ok(Math.abs(windy.impact.y - calm.impact.y) < 1e-9)
      assert.equal(Math.sign(windy.windErrX), Math.sign(a))
    }
  }
})

test('wind on a ground shot is measured at the landing time', () => {
  const f = shoot(aimAt(0, -3), 1, 2)
  assert.equal(f.end, 'ground')
  const t = f.flightMs / 1000
  assert.ok(Math.abs(f.windErrX - t * t) < 1e-12)
})

test('drifting target: hit is measured against the centre at impact time', () => {
  const center = (ms: number): Vec2 => ({ x: 0.5 * Math.sin(ms / 300), y: 1.5 })
  const f = shoot(aimAt(0.1, 1.6), 1, 0, center)
  assert.equal(f.end, 'target')
  const c = center(f.flightMs)
  const hit = f.hit
  if (!hit) throw new Error('expected a target hit')
  assert.ok(Math.abs(f.targetCenter.x - c.x) < 1e-12)
  assert.ok(Math.abs(hit.x - (f.impact.x - c.x)) < 1e-12)
  assert.ok(Math.abs(hit.y - (f.impact.y - c.y)) < 1e-12)
  assert.equal(f.score, ringScore(Math.hypot(hit.x, hit.y)))
  // Lead the real drifting target: aim where the centre will be at impact.
  const phase = 1.1
  const launchMs = 2000
  const cAt = (ms: number): Vec2 => targetCenterAt(4, launchMs + ms, phase)
  const guess = shoot(aimAt(0, 1.5), 1).flightMs
  const lead = cAt(guess)
  const led = shoot(aimAt(lead.x, lead.y), 1, 0, cAt)
  assert.ok(led.radius < 0.002, `led radius ${led.radius}`)
  assert.equal(led.score, 10)
})

test('aiming far below the target ends on the ground with score 0', () => {
  for (const tension of [0, 0.5, 1]) {
    const f = shoot(aimAt(0, -4), tension)
    assert.equal(f.end, 'ground')
    assert.equal(f.hit, null)
    assert.equal(f.radius, Infinity)
    assert.equal(f.score, 0)
    assert.equal(f.impact.y, 0)
    assert.ok(f.impact.z > TARGET_Z)
    assert.ok(f.flightMs > 0 && f.flightMs < 1000)
  }
})

test('path and vel: one sample per step, launch first, impact last', () => {
  const f = shoot(aimAt(0.3, 1.8), 0.8, 1.5)
  assert.equal(f.stepS, PHYS_DT)
  assert.equal(f.path.length, f.vel.length)
  assert.deepEqual(f.path[0], { ...LAUNCH_POS })
  assert.equal(f.path[f.path.length - 1], f.impact)
  const n = f.path.length
  const tEnd = f.flightMs / 1000
  assert.ok(tEnd > (n - 2) * PHYS_DT - 1e-12 && tEnd <= (n - 1) * PHYS_DT + 1e-12)
  for (let i = 1; i < n; i++) assert.ok(f.path[i].z < f.path[i - 1].z, 'moves toward the target')
  // Speed grows only through gravity and wind, never NaN.
  for (const v of f.vel) assertFinite3(v, 'vel')
})

test('sampleFlight interpolates between launch and impact', () => {
  const f = shoot(aimAt(0, 1.5), 1)
  assert.deepEqual(sampleFlight(f, 0).p, { ...LAUNCH_POS })
  const end = sampleFlight(f, 99)
  assert.ok(Math.hypot(end.p.x - f.impact.x, end.p.y - f.impact.y, end.p.z - f.impact.z) < 1e-9)
  const mid = sampleFlight(f, 10 * PHYS_DT)
  assert.ok(Math.hypot(mid.p.x - f.path[10].x, mid.p.y - f.path[10].y, mid.p.z - f.path[10].z) < 1e-9)
  assertFinite3(sampleFlight(f, NaN).p, 'NaN time')
})

test('unreachable and degenerate aims never produce NaN', () => {
  // Far too high for the slowest arrow: 45 degrees toward the aim.
  const v = solveLaunch(LAUNCH_POS, aimAt(0, 500), launchSpeed(0))
  assertFinite3(v, 'unreachable')
  assert.ok(Math.abs(mag(v) - launchSpeed(0)) < 1e-9)
  assert.ok(Math.abs(Math.atan2(v.y, Math.hypot(v.x, v.z)) - Math.PI / 4) < 1e-12)
  const f = simulateShot({ from: LAUNCH_POS, velocity: v, windAccel: 2, targetCenterAt: still })
  for (const p of f.path) assertFinite3(p, 'path')
  assert.ok(Number.isFinite(f.flightMs))
  assert.equal(f.score, 0)

  // Aim on the launch point, straight above it, and NaN everywhere.
  assertFinite3(solveLaunch(LAUNCH_POS, { ...LAUNCH_POS }, 40), 'aim == from')
  assertFinite3(solveLaunch(LAUNCH_POS, { ...LAUNCH_POS, y: 5 }, 40), 'aim above')
  assertFinite3(solveLaunch(LAUNCH_POS, { x: NaN, y: 1, z: TARGET_Z }, 40), 'NaN aim')
  assertFinite3(solveLaunch(LAUNCH_POS, aimAt(0, 1.5), NaN), 'NaN speed')
  const nanShot = simulateShot({
    from: LAUNCH_POS,
    velocity: { x: NaN, y: 0, z: -40 },
    windAccel: NaN,
    targetCenterAt: () => ({ x: NaN, y: NaN }),
  })
  assertFinite3(nanShot.impact, 'NaN shot impact')
  assert.ok(Number.isFinite(nanShot.windErrX))
})

test('flight is capped at MAX_FLIGHT_S', () => {
  const f = simulateShot({ from: LAUNCH_POS, velocity: { x: 0, y: 25, z: 0 }, windAccel: 0, targetCenterAt: still })
  assert.equal(f.end, 'ground')
  assert.ok(Math.abs(f.flightMs - MAX_FLIGHT_S * 1000) < 1e-6)
  assert.equal(f.score, 0)
})

test('windForArrow: calm before arrow 3, inside the documented range after', () => {
  const rng = lcg(7)
  for (let arrow = 0; arrow < WIND_FIRST_ARROW; arrow++) assert.equal(windForArrow(arrow, rng), 0)
  assert.equal(windForArrow(NaN, rng), 0)
  for (const arrow of [3, 4]) {
    const [lo, hi] = WIND_RANGES[arrow - WIND_FIRST_ARROW]
    let pos = 0
    let neg = 0
    for (let i = 0; i < 500; i++) {
      const w = windForArrow(arrow, rng)
      const m = Math.abs(w)
      assert.ok(m >= lo - 1e-9 && m <= hi + 1e-9, `arrow ${arrow}: ${w}`)
      assert.ok(Math.abs(w * 10 - Math.round(w * 10)) < 1e-9, 'rounded to 0.1')
      if (w > 0) pos++
      else neg++
    }
    assert.ok(pos > 100 && neg > 100, 'both directions occur')
    // Extreme rng values stay in range too.
    for (const u of [0, 0.9999999, 1]) {
      const m = Math.abs(windForArrow(arrow, () => u))
      assert.ok(m >= lo - 1e-9 && m <= hi + 1e-9)
    }
  }
  // Arrow 4 is stronger than arrow 3.
  assert.ok(WIND_RANGES[1][0] > WIND_RANGES[0][0] && WIND_RANGES[1][1] > WIND_RANGES[0][1])
})

test('arrow 3 wind drifts a full-draw centre shot by 0.2 to 0.35 m', () => {
  const [lo, hi] = WIND_RANGES[0]
  for (const a of [lo, hi]) {
    const drift = Math.abs(shoot(aimAt(0, 1.5), 1, a).windErrX)
    assert.ok(drift >= 0.2 && drift <= 0.35, `a ${a}: drift ${drift}`)
  }
})

test('targetCenterAt: fixed before arrow 3, bounded smooth drift after', () => {
  for (let arrow = 0; arrow < WIND_FIRST_ARROW; arrow++) {
    for (const t of [0, 1234, 99999]) assert.deepEqual(targetCenterAt(arrow, t, 2), { ...TARGET_CENTER })
  }
  for (const arrow of [3, 4]) {
    const A = DRIFT_AMPLITUDE[arrow - WIND_FIRST_ARROW]
    let maxDx = 0
    let prev = targetCenterAt(arrow, 0, 0.7)
    for (let t = 0; t <= 12000; t += 16) {
      const c = targetCenterAt(arrow, t, 0.7)
      assert.equal(c.y, TARGET_CENTER.y)
      const dx = Math.abs(c.x - TARGET_CENTER.x)
      assert.ok(dx <= A + 1e-12)
      assert.ok(Math.abs(c.x) + TARGET_RADIUS <= 1.5, 'face stays in the lane')
      // Slow: under 0.5 m/s, so under 8 mm per 16 ms frame.
      assert.ok(Math.abs(c.x - prev.x) < 0.008)
      maxDx = Math.max(maxDx, dx)
      prev = c
    }
    assert.ok(maxDx > A * 0.95, 'it actually drifts')
  }
  const c = targetCenterAt(4, NaN, NaN)
  assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y))
})
