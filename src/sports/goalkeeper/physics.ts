// Goalkeeper ball physics: 60 Hz semi-implicit Euler with gravity + Magnus, swept collision tests,
// save response, and the 9-zone goal grid. Pure TypeScript (no DOM / Three.js) so it runs in Node.

import type { BallState, SweptHit, Vec3, Zone } from './types.ts'

// ---------- constants ----------

export const GOAL_HALF_WIDTH = 3.66
export const GOAL_HEIGHT = 2.44
export const GOAL_Z = 0
export const PENALTY_Z = -11
export const BALL_RADIUS = 0.11
export const GLOVE_RADIUS = 0.38
export const TORSO_RADIUS = 0.28
export const GRAVITY = -9.81
export const RESTITUTION = 0.65
export const PHYS_DT = 1 / 60
/**
 * Magnus coefficient (1/rad). With omega = 30 rad/s about y and a ~13.75 m/s shot over 0.8 s the
 * uncompensated lateral drift at the goal line is ~0.6 m (20 rad/s ~0.4 m, 40 rad/s ~0.8 m).
 */
export const K_MAGNUS = 0.0045
/** Fraction of the collider velocity added to the ball on a save. */
export const PUNCH_GAIN = 0.6
/** Per-second spin decay factor (light). */
const SPIN_DECAY_PER_S = 0.98
/** Tangential velocity kept on a save. */
const SAVE_FRICTION = 0.8
/** Minimum outward speed after a save (ball must move away from goal, -z). */
const MIN_CLEAR_SPEED = 1

// ---------- vector helpers ----------

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s }
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

export function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}

/** Unit vector; returns (0, 0, 0) for a zero-length input. */
export function normalize(a: Vec3): Vec3 {
  const l = length(a)
  if (l < 1e-12) return { x: 0, y: 0, z: 0 }
  return { x: a.x / l, y: a.y / l, z: a.z / l }
}

export function copyInto(dst: Vec3, src: Vec3): Vec3 {
  dst.x = src.x
  dst.y = src.y
  dst.z = src.z
  return dst
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

// ---------- integration ----------

/** One semi-implicit Euler step: a = g + K_MAGNUS (omega x v); v += a dt; p += v dt. Mutates ball. */
export function stepBall(ball: BallState, dt: number): void {
  const { v, omega, p } = ball
  const mx = omega.y * v.z - omega.z * v.y
  const my = omega.z * v.x - omega.x * v.z
  const mz = omega.x * v.y - omega.y * v.x
  v.x += K_MAGNUS * mx * dt
  v.y += (GRAVITY + K_MAGNUS * my) * dt
  v.z += K_MAGNUS * mz * dt
  p.x += v.x * dt
  p.y += v.y * dt
  p.z += v.z * dt
  const decay = Math.pow(SPIN_DECAY_PER_S, dt)
  omega.x *= decay
  omega.y *= decay
  omega.z *= decay
}

/**
 * Simulate from `from` with velocity v0 until the ball centre crosses the plane z = planeZ.
 * Returns the interpolated crossing point and time, or null if it never crosses.
 */
function simulateToPlane(
  from: Vec3,
  v0: Vec3,
  omega: Vec3,
  planeZ: number,
  maxTime: number,
): { point: Vec3; time: number } | null {
  const ball: BallState = { p: { ...from }, v: { ...v0 }, omega: { ...omega } }
  const dir = Math.sign(planeZ - from.z) || 1
  const maxSteps = Math.ceil(maxTime / PHYS_DT)
  let t = 0
  for (let i = 0; i < maxSteps; i++) {
    const prev = { ...ball.p }
    stepBall(ball, PHYS_DT)
    t += PHYS_DT
    const d0 = (planeZ - prev.z) * dir
    const d1 = (planeZ - ball.p.z) * dir
    if (d0 > 0 && d1 <= 0) {
      const f = d0 / (d0 - d1)
      return { point: lerp3(prev, ball.p, f), time: t - PHYS_DT + f * PHYS_DT }
    }
  }
  return null
}

/**
 * Launch velocity so a ball from `from` with spin `omega`, stepped by stepBall at PHYS_DT, crosses the
 * plane z = target.z at (target.x, target.y) after about flightTime seconds. Ballistic seed, then
 * iterative correction of the miss at the plane crossing (< 2 cm, max 8 iterations).
 */
export function solveLaunch(from: Vec3, target: Vec3, flightTime: number, omega: Vec3): Vec3 {
  const T = Math.max(flightTime, 0.05)
  const v: Vec3 = {
    x: (target.x - from.x) / T,
    y: (target.y - from.y - 0.5 * GRAVITY * T * T) / T,
    z: (target.z - from.z) / T,
  }
  let best: Vec3 = { ...v }
  let bestMiss = Infinity
  for (let iter = 0; iter < 8; iter++) {
    const hit = simulateToPlane(from, v, omega, target.z, T * 3 + 1)
    if (!hit) {
      // Should not happen with a forward z velocity; nudge forward and retry.
      v.z += Math.sign(target.z - from.z) * 1
      continue
    }
    const ex = target.x - hit.point.x
    const ey = target.y - hit.point.y
    const miss = Math.hypot(ex, ey)
    if (miss < bestMiss) {
      bestMiss = miss
      best = { ...v }
    }
    if (miss < 0.005) break
    // Correct lateral/vertical velocity by the miss over the actual flight time.
    const tf = Math.max(hit.time, 0.05)
    v.x += ex / tf
    v.y += ey / tf
    // Keep the flight time close to the requested one.
    v.z *= tf / T
  }
  return best
}

// ---------- swept collisions ----------

/**
 * Ball centre b0 -> b1 (radius ballR) against a sphere collider centre c0 -> c1 (radius r) over one step.
 * Solved in relative motion; returns the earliest contact t in [0, 1].
 */
export function sweptSphereHit(
  b0: Vec3,
  b1: Vec3,
  ballR: number,
  c0: Vec3,
  c1: Vec3,
  r: number,
): SweptHit | null {
  const R = ballR + r
  const s0 = sub(b0, c0) // relative position at t=0
  const d = sub(sub(b1, b0), sub(c1, c0)) // relative displacement over the step
  const c = dot(s0, s0) - R * R
  if (c <= 0) {
    const n = length(s0) > 1e-9 ? normalize(s0) : vec3(0, 0, -1)
    return { t: 0, point: { ...b0 }, normal: n }
  }
  const a = dot(d, d)
  if (a < 1e-12) return null
  const b = 2 * dot(s0, d)
  if (b >= 0) return null // moving apart
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const t = (-b - Math.sqrt(disc)) / (2 * a)
  if (t < 0 || t > 1) return null
  const point = lerp3(b0, b1, t)
  const cAt = lerp3(c0, c1, t)
  const diff = sub(point, cAt)
  const normal = length(diff) > 1e-9 ? normalize(diff) : vec3(0, 0, -1)
  return { t, point, normal }
}

function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  if (l2 < 1e-12) return { ...a }
  let u = dot(sub(p, a), ab) / l2
  if (u < 0) u = 0
  else if (u > 1) u = 1
  return { x: a.x + ab.x * u, y: a.y + ab.y * u, z: a.z + ab.z * u }
}

function segDist(p: Vec3, a: Vec3, b: Vec3): number {
  return length(sub(p, closestOnSegment(p, a, b)))
}

/**
 * Ball centre b0 -> b1 (radius ballR) against a static capsule (segment a..b, radius r).
 * Distance to a segment along a linear path is convex in t, so: dense sampling to find the
 * first sample inside (or the minimum), then bisection on the entry boundary.
 */
export function sweptCapsuleHit(
  b0: Vec3,
  b1: Vec3,
  ballR: number,
  a: Vec3,
  b: Vec3,
  r: number,
): SweptHit | null {
  const R = ballR + r
  const f = (t: number): number => segDist(lerp3(b0, b1, t), a, b) - R
  const makeHit = (t: number): SweptHit => {
    const point = lerp3(b0, b1, t)
    const diff = sub(point, closestOnSegment(point, a, b))
    const normal = length(diff) > 1e-9 ? normalize(diff) : vec3(0, 0, -1)
    return { t, point, normal }
  }
  if (f(0) <= 0) return makeHit(0)

  const N = 16
  let prevT = 0
  let tIn = -1
  let minT = 0
  let minV = f(0)
  for (let i = 1; i <= N; i++) {
    const t = i / N
    const v = f(t)
    if (v <= 0) {
      tIn = t
      break
    }
    if (v < minV) {
      minV = v
      minT = t
    }
    prevT = t
  }
  if (tIn < 0) {
    // No sample inside; the convex minimum may still dip below zero between samples.
    // Ternary search for the true minimum around the best sample.
    let lo = Math.max(0, minT - 1 / N)
    let hi = Math.min(1, minT + 1 / N)
    for (let i = 0; i < 40; i++) {
      const m1 = lo + (hi - lo) / 3
      const m2 = hi - (hi - lo) / 3
      if (f(m1) < f(m2)) hi = m2
      else lo = m1
    }
    const tm = (lo + hi) / 2
    if (f(tm) > 0) return null
    tIn = tm
    prevT = Math.max(0, minT - 1 / N)
    // Ensure f(prevT) > 0 (f is convex and f(0) > 0, so the bracket below tm is valid).
    if (f(prevT) <= 0) prevT = 0
  }
  // Bisection on [prevT (outside), tIn (inside)].
  let lo = prevT
  let hi = tIn
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2
    if (f(m) > 0) lo = m
    else hi = m
  }
  return makeHit(hi)
}

// ---------- save response ----------

/**
 * Apply a save: push the ball out of contact, reflect the relative normal velocity with RESTITUTION,
 * keep tangential with friction, add PUNCH_GAIN of the collider velocity, guarantee v.z <= -1 m/s,
 * and damp spin. Mutates ball.
 */
export function resolveSave(ball: BallState, hit: SweptHit, colliderVel: Vec3): void {
  const n = hit.normal
  copyInto(ball.p, add(hit.point, scale(n, 0.001)))
  const vr = sub(ball.v, colliderVel)
  const vn = dot(vr, n)
  let out: Vec3
  if (vn < 0) {
    const normalPart = scale(n, vn)
    const tangential = sub(vr, normalPart)
    out = add(scale(tangential, SAVE_FRICTION), scale(n, -RESTITUTION * vn))
  } else {
    out = { ...vr }
  }
  const v = add(out, scale(colliderVel, PUNCH_GAIN))
  if (v.z > -MIN_CLEAR_SPEED) v.z = -MIN_CLEAR_SPEED
  copyInto(ball.v, v)
  copyInto(ball.omega, scale(ball.omega, 0.3))
}

// ---------- zones ----------

const CELL_W = (2 * GOAL_HALF_WIDTH) / 3
const CELL_H = GOAL_HEIGHT / 3

/** 9-zone grid index (row 0 top, col 0 = -x). Points outside the mouth clamp to the nearest zone. */
export function zoneOf(x: number, y: number): Zone {
  const col = Math.min(2, Math.max(0, Math.floor((x + GOAL_HALF_WIDTH) / CELL_W)))
  const rowFromBottom = Math.min(2, Math.max(0, Math.floor(y / CELL_H)))
  const row = 2 - rowFromBottom
  return (row * 3 + col) as Zone
}

/** Random aim point inside the zone cell on z = GOAL_Z, kept safely inside posts, bar and ground. */
export function zoneTarget(zone: Zone, rng: () => number): Vec3 {
  const row = Math.floor(zone / 3)
  const col = zone % 3
  const margin = BALL_RADIUS + 0.25
  let x0 = -GOAL_HALF_WIDTH + col * CELL_W
  let x1 = x0 + CELL_W
  let y1 = GOAL_HEIGHT - row * CELL_H
  let y0 = y1 - CELL_H
  x0 = Math.max(x0, -GOAL_HALF_WIDTH + margin)
  x1 = Math.min(x1, GOAL_HALF_WIDTH - margin)
  y0 = Math.max(y0, Math.max(margin, 0.25))
  y1 = Math.min(y1, GOAL_HEIGHT - margin)
  // Jitter within the inner 80% of the (clamped) cell so shots stay clearly in their zone.
  const inset = 0.1
  const ux = inset + (1 - 2 * inset) * rng()
  const uy = inset + (1 - 2 * inset) * rng()
  return { x: x0 + (x1 - x0) * ux, y: y0 + (y1 - y0) * uy, z: GOAL_Z }
}

/** True when a ball centre crossing the goal plane at (x, y) is inside the mouth. */
export function inGoalMouth(x: number, y: number): boolean {
  return (
    Math.abs(x) < GOAL_HALF_WIDTH - BALL_RADIUS &&
    y > BALL_RADIUS * 0.5 &&
    y < GOAL_HEIGHT - BALL_RADIUS
  )
}
