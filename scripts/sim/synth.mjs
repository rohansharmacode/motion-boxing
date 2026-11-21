// Synthetic poses for sports without motion-lab recordings: a simple full-body skeleton in world metres
// (hip origin, mirrored x so the player's own left is negative, y down, z toward the camera negative),
// projected to image coordinates, keyframed and sampled at 30 fps into the sim queue format.
const STORED = [0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]
const ASPECT = 4 / 3
const SCALE = 0.55 // image heights per metre at about 2.2 m
const FPS_MS = 33

/** Joint positions (world metres) of a relaxed standing player. */
export function guardBase() {
  return {
    0: [0, -0.62, -0.1], 11: [-0.19, -0.45, 0], 12: [0.19, -0.45, 0],
    13: [-0.22, -0.18, 0], 14: [0.22, -0.18, 0], 15: [-0.23, 0.08, -0.02], 16: [0.23, 0.08, -0.02],
    23: [-0.1, 0, 0], 24: [0.1, 0, 0], 25: [-0.11, 0.42, 0], 26: [0.11, 0.42, 0], 27: [-0.11, 0.82, 0], 28: [0.11, 0.82, 0],
  }
}

function withHands(j) {
  // Hand points (17 to 22) sit just past the wrists.
  for (const [w, ids] of [[15, [17, 19, 21]], [16, [18, 20, 22]]]) for (const id of ids) j[id] = [j[w][0], j[w][1] + 0.04, j[w][2]]
  return j
}

function pack(j, vis = 0.98) {
  const img = [], wld = []
  for (const id of STORED) {
    const [x, y, z] = j[id]
    const s = SCALE * (2.2 / (2.2 + z))
    img.push(Math.round((0.5 + (x * s) / ASPECT) * 1000), Math.round((0.47 + y * s) * 1000), Math.round(z * 1000), Math.round(vis * 100))
    wld.push(Math.round(x * 1000), Math.round(y * 1000), Math.round(z * 1000), Math.round(vis * 100))
  }
  return [0, img, wld]
}

const ease = (u) => u * u * (3 - 2 * u)
function lerpPose(a, b, u) {
  const o = {}
  for (const k of Object.keys(a)) o[k] = a[k].map((v, i) => v + (b[k][i] - v) * u)
  return o
}
/** Copy of base with some joints replaced (absolute) and the whole body shifted by dx, dy. */
function pose(base, set = {}, dx = 0, dy = 0) {
  const o = {}
  for (const [k, v] of Object.entries(base)) o[k] = [v[0] + dx, v[1] + dy, v[2]]
  for (const [k, v] of Object.entries(set)) o[k] = [v[0] + dx, v[1] + dy, v[2]]
  return o
}

/** Keyframes [ms to reach, pose]. */
function moves(kind, b) {
  const sway = (dx) => pose(b, {}, dx)
  switch (kind) {
    case 'stand': return null
    case 'dive-L':
    case 'dive-R': {
      const s = kind === 'dive-L' ? -1 : 1
      const reach = pose(b, { 13: [s * 0.45, -0.55, 0], 15: [s * 0.72, -0.62, -0.05], 14: [s * 0.12, -0.6, 0], 16: [s * 0.4, -0.75, -0.05] }, s * 0.45, 0.08)
      return [[500, b], [280, reach], [450, reach], [500, b], [700, b]]
    }
    case 'draw-release': {
      const bow = { 13: [-0.45, -0.46, -0.05], 15: [-0.72, -0.46, -0.08] }
      const nock = pose(b, { ...bow, 14: [-0.25, -0.5, -0.05], 16: [-0.55, -0.47, -0.08] })
      const full = pose(b, { ...bow, 14: [0.35, -0.47, 0.02], 16: [0.02, -0.55, -0.05] })
      const loose = pose(b, { ...bow, 14: [0.45, -0.42, 0.05], 16: [0.4, -0.48, 0.05] })
      return [[600, b], [700, nock], [900, full], [1300, full], [90, loose], [700, loose], [800, b], [600, b]]
    }
    case 'bowl': {
      const down = pose(b, { 14: [0.25, -0.15, 0.1], 16: [0.27, 0.15, 0.2] })
      const up = pose(b, { 14: [0.2, -0.7, -0.15], 16: [0.15, -0.95, -0.3] })
      return [[800, b], [400, down], [500, down], [250, up], [600, up], [700, b], [1500, b]]
    }
    case 'swing': {
      const back = pose(b, { 14: [0.45, -0.35, 0.05], 16: [0.65, -0.35, 0] })
      const thru = pose(b, { 14: [0.05, -0.38, -0.2], 16: [-0.25, -0.38, -0.3] })
      return [[300, b], [500, back], [400, back], [140, thru], [500, thru], [600, b], [400, b]]
    }
    case 'idle':
    default:
      return [[800, sway(0.04)], [800, sway(-0.04)], [800, sway(0.03)], [800, b]]
  }
}

/** Queue items for one move (or a still stand of durMs). */
export function synthPose(kind, base = guardBase(), durMs = 2000) {
  const keys = moves(kind, base) ?? [[durMs, base]]
  const items = []
  let from = base
  let first = true
  for (const [ms, to] of keys) {
    const n = Math.max(1, Math.round(ms / FPS_MS))
    for (let i = 1; i <= n; i++) {
      const breath = Math.sin(items.length * 0.15) * 0.004
      const p = lerpPose(from, to, ease(i / n))
      p[0] = [p[0][0], p[0][1] + breath, p[0][2]]
      items.push({ dt: FPS_MS, pose: pack(withHands(p)), label: first ? kind : undefined })
      first = false
    }
    from = to
  }
  return items
}
