// Neon Lanes bowling: pure rules (3-frame scoring) and a small 2D lane physics step. No DOM, no Three.js.

export const FRAMES = 3
export const LANE_HALF = 0.53
export const GUTTER_HALF = 0.72
export const HEAD_PIN_Z = -18
export const BALL_R = 0.109
export const PIN_R = 0.06
const BALL_MASS = 7
const PIN_MASS = 1.5
/** Ball past this z has left the pin deck. */
export const PIT_Z = -19.6

// ---------- scoring ----------

/** Rolls grouped by frame. The last frame may hold 3 rolls (strike or spare bonus). */
export type Frames = number[][]

/** Running total after each frame, or null while a bonus is still pending. */
export function frameTotals(frames: Frames): (number | null)[] {
  const flat = frames.flat()
  const out: (number | null)[] = []
  let total = 0
  let i = 0
  for (let f = 0; f < FRAMES; f++) {
    const r = frames[f]
    if (!r || r.length === 0) {
      out.push(null)
      continue
    }
    if (f === FRAMES - 1) {
      const done = r.length === 3 || (r.length === 2 && r[0] + r[1] < 10)
      total += r.reduce((a, b) => a + b, 0)
      out.push(done ? total : null)
      continue
    }
    if (r[0] === 10) {
      const b1 = flat[i + 1]
      const b2 = flat[i + 2]
      if (b1 === undefined || b2 === undefined) out.push(null)
      else out.push((total += 10 + b1 + b2))
      i += 1
    } else if (r.length === 2) {
      if (r[0] + r[1] === 10) {
        const b1 = flat[i + 2]
        if (b1 === undefined) out.push(null)
        else out.push((total += 10 + b1))
      } else out.push((total += r[0] + r[1]))
      i += 2
    } else {
      out.push(null)
      i += 1
    }
  }
  return out
}

/** Marks for the scoreboard: X strike, / spare, - zero. */
export function frameMarks(r: number[] | undefined, last: boolean): string[] {
  if (!r) return []
  const out: string[] = []
  let rack = 0
  for (let k = 0; k < r.length; k++) {
    const v = r[k]
    const fresh = rack === 0
    if (fresh && v === 10) {
      out.push('X')
      if (!last) break
      rack = 0
    } else if (!fresh && rack + v === 10) {
      out.push('/')
      rack = 0
    } else {
      out.push(v === 0 ? '-' : String(v))
      rack = fresh ? v : 0
    }
  }
  return out
}

/** What happens after a roll lands. */
export interface RollOutcome {
  /** Reset all ten pins for the next ball. */
  resetPins: boolean
  /** The game is over. */
  gameOver: boolean
  kind: 'strike' | 'spare' | 'gutter' | 'open'
}

/** Records `knocked` into frames and decides what comes next. rackBalls = balls already thrown at this rack. */
export function recordRoll(frames: Frames, knocked: number, rackBalls: number, rackStanding: number, gutter: boolean): RollOutcome {
  let f = frames.length - 1
  if (f < 0 || frameDone(frames, f)) {
    frames.push([])
    f++
  }
  const r = frames[f]
  r.push(knocked)
  const cleared = knocked === rackStanding
  const kind: RollOutcome['kind'] =
    cleared && rackBalls === 0 ? 'strike' : cleared ? 'spare' : knocked === 0 && gutter ? 'gutter' : 'open'
  const done = frameDone(frames, f)
  const gameOver = done && f === FRAMES - 1
  return { resetPins: cleared || done, gameOver, kind }
}

function frameDone(frames: Frames, f: number): boolean {
  const r = frames[f]
  if (f < FRAMES - 1) return r[0] === 10 || r.length === 2
  return r.length === 3 || (r.length === 2 && r[0] + r[1] < 10)
}

// ---------- physics ----------

export interface Pin {
  home: { x: number; z: number }
  x: number
  z: number
  vx: number
  vz: number
  /** In play: false once swept or never placed. */
  live: boolean
  /** Knocked: counts as down and plays the fall. */
  down: boolean
  /** 0 standing to 1 flat. */
  fall: number
  /** Fall direction, radians around y. */
  fallYaw: number
}

export interface Ball {
  x: number
  z: number
  vx: number
  vz: number
  /** Lateral acceleration once past the heads, m/s^2 (hook). */
  hook: number
  gutter: boolean
  rolling: boolean
}

export function pinHomes(): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = []
  for (let row = 0; row < 4; row++)
    for (let i = 0; i <= row; i++) out.push({ x: (i - row / 2) * 0.305, z: HEAD_PIN_Z - row * 0.264 })
  return out
}

export function makePins(): Pin[] {
  return pinHomes().map((h) => ({ home: h, x: h.x, z: h.z, vx: 0, vz: 0, live: true, down: false, fall: 0, fallYaw: 0 }))
}

export function rackPins(pins: Pin[], all: boolean): void {
  for (const p of pins) {
    if (all) p.live = true
    else if (p.down) p.live = false
    p.x = p.home.x
    p.z = p.home.z
    p.vx = p.vz = 0
    p.down = false
    p.fall = 0
  }
}

function knock(p: Pin, vx: number, vz: number): void {
  if (!p.down) {
    p.down = true
    p.fallYaw = Math.atan2(vx, vz)
  }
}

/** One fixed physics step (seconds). */
export function stepLane(ball: Ball, pins: Pin[], dt: number): void {
  if (ball.rolling) {
    ball.x += ball.vx * dt
    ball.z += ball.vz * dt
    if (!ball.gutter) {
      if (ball.z < -7 && ball.z > HEAD_PIN_Z) ball.vx += ball.hook * dt
      if (Math.abs(ball.x) > LANE_HALF) {
        ball.gutter = true
        ball.x = Math.sign(ball.x) * (LANE_HALF + 0.1)
        ball.vx = 0
      }
    }
    if (ball.z < PIT_Z - 1) ball.rolling = false
  }
  // ball vs pins
  if (ball.rolling && !ball.gutter) {
    for (const p of pins) {
      if (!p.live) continue
      collide(ball, BALL_MASS, BALL_R, p, PIN_MASS, PIN_R)
    }
  }
  // pin vs pin
  for (let a = 0; a < pins.length; a++) {
    const pa = pins[a]
    if (!pa.live) continue
    for (let b = a + 1; b < pins.length; b++) {
      const pb = pins[b]
      if (!pb.live) continue
      if (!pa.down && !pb.down) continue
      collide(pa, PIN_MASS, PIN_R * 1.6, pb, PIN_MASS, PIN_R * 1.6)
    }
  }
  const drag = Math.exp(-2.2 * dt)
  for (const p of pins) {
    if (!p.live) continue
    p.x += p.vx * dt
    p.z += p.vz * dt
    p.vx *= drag
    p.vz *= drag
    if (p.down) p.fall = Math.min(1, p.fall + dt * 4)
    if (Math.abs(p.x) > GUTTER_HALF) {
      p.x = Math.sign(p.x) * GUTTER_HALF
      p.vx *= -0.3
    }
  }
}

type Body = { x: number; z: number; vx: number; vz: number }

function collide(a: Body | Pin, ma: number, ra: number, b: Pin, mb: number, rb: number): void {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const d2 = dx * dx + dz * dz
  const min = ra + rb
  if (d2 >= min * min || d2 === 0) return
  const d = Math.sqrt(d2)
  const nx = dx / d
  const nz = dz / d
  const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz
  // separate
  const push = (min - d) / 2
  a.x -= nx * push
  a.z -= nz * push
  b.x += nx * push
  b.z += nz * push
  if (rel <= 0) return
  const e = 0.75
  const j = ((1 + e) * rel) / (1 / ma + 1 / mb)
  a.vx -= (j / ma) * nx
  a.vz -= (j / ma) * nz
  b.vx += (j / mb) * nx
  b.vz += (j / mb) * nz
  // Pins scatter a bit sideways so racks do not fall in a perfect line.
  b.vx += (Math.random() - 0.5) * 0.4
  knock(b, b.vx, b.vz)
  if ('down' in a) knock(a, a.vx, a.vz)
}

/** All motion has settled after the ball reached the pins. */
export function laneSettled(ball: Ball, pins: Pin[]): boolean {
  if (ball.rolling && ball.z > PIT_Z) return false
  for (const p of pins) if (p.live && p.vx * p.vx + p.vz * p.vz > 0.01) return false
  return true
}
