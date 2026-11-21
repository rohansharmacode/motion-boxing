// Neon arena around the boxing ring: tiered stands with a silhouette crowd and glow sticks,
// scrolling LED boards, and a back wall.
// Built for speed: instanced crowd and skyline, one canvas texture per board type, no lights,
// no shadows, about 25 draw calls in total.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  Color,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RepeatWrapping,
  IcosahedronGeometry,
  SRGBColorSpace,
} from 'three'
import type { Texture } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const CYAN = 0x38c8ff

/** Small deterministic PRNG so the crowd looks the same every match. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx) draw(ctx)
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  return tex
}

/** Scrolling LED board text: original arcade copy, cyan and pink on black. */
function ledTexture(): CanvasTexture {
  const words = ['Kinetic Ring', 'Round 1', 'No controller needed', 'Webcam boxing']
  const tex = canvasTexture(1024, 64, (ctx) => {
    ctx.fillStyle = '#0b0c0f'
    ctx.fillRect(0, 0, 1024, 64)
    ctx.font = '500 30px "Geist Sans", system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    let x = 24
    for (const word of words) {
      ctx.fillStyle = '#d6d6db'
      ctx.fillText(word, x, 33)
      x += ctx.measureText(word).width + 30
      ctx.fillStyle = '#4a4e58'
      ctx.fillRect(x, 28, 6, 6) // small square divider
      x += 36
    }
  })
  tex.wrapS = RepeatWrapping
  return tex
}

export interface ArenaDressing {
  group: Group
  /** Animates boards, beams and glow sticks. t in seconds. */
  update(t: number): void
  dispose(): void
}

interface Tier {
  /** Front-row seat position and the outward step per row. */
  x: number
  z: number
  stepX: number
  stepZ: number
  /** Seats run along this axis from start to end. */
  along: 'x' | 'z'
  from: number
  to: number
}

const ROWS = 5
const RISE = 0.45
const DEPTH = 0.75
const SEAT_GAP = 0.62

/** Back stand faces +z, the side stands face the ring centre. */
const STANDS: Tier[] = [
  { x: 0, z: -8.2, stepX: 0, stepZ: -DEPTH, along: 'x', from: -8.5, to: 8.5 },
  { x: -4.6, z: 0, stepX: -DEPTH, stepZ: 0, along: 'z', from: 0.5, to: -7.4 },
  { x: 4.6, z: 0, stepX: DEPTH, stepZ: 0, along: 'z', from: 0.5, to: -7.4 },
]

export function buildArenaDressing(): ArenaDressing {
  const group = new Group()
  const textures: Texture[] = []
  const r = rng(11)

  // ---------- stands ----------
  const tierMat = new MeshBasicMaterial({ color: 0x0d0f1a })
  const stripMats = [new MeshBasicMaterial({ color: 0x343844 }), new MeshBasicMaterial({ color: 0x2a2d36 })]
  const seats: { x: number; y: number; z: number; facing: number }[] = []
  // Static stand pieces are merged into three meshes: steps, cyan nosing, pink nosing.
  const stepGeos: BufferGeometry[] = []
  const stripGeos: BufferGeometry[][] = [[], []]
  STANDS.forEach((s, si) => {
    const span = Math.abs(s.to - s.from)
    const mid = (s.to + s.from) / 2
    for (let row = 0; row < ROWS; row++) {
      const x = s.x + s.stepX * row
      const z = s.z + s.stepZ * row
      const top = (row + 1) * RISE
      // A step block from the floor to this row's height.
      const geo = s.along === 'x' ? new BoxGeometry(span, top, DEPTH) : new BoxGeometry(DEPTH, top, span)
      geo.translate(s.along === 'x' ? mid : x + Math.sign(s.stepX) * DEPTH * 0.5, top / 2, s.along === 'x' ? z - DEPTH * 0.5 : mid)
      stepGeos.push(geo)
      // Neon nosing on the front edge of every second row.
      if (row % 2 === 0) {
        const stripGeo = s.along === 'x' ? new BoxGeometry(span, 0.025, 0.025) : new BoxGeometry(0.025, 0.025, span)
        stripGeo.translate(s.along === 'x' ? mid : x, top + 0.01, s.along === 'x' ? z : mid)
        stripGeos[(row / 2 + si) % 2].push(stripGeo)
      }
      const facing = s.along === 'x' ? 0 : s.stepX < 0 ? Math.PI / 2 : -Math.PI / 2
      const lo = Math.min(s.from, s.to)
      for (let p = lo + SEAT_GAP / 2; p < lo + span; p += SEAT_GAP) {
        if (r() < 0.25) continue // empty seats keep the rows from looking stamped
        const jitter = (r() - 0.5) * 0.18
        const back = DEPTH * 0.45
        seats.push(
          s.along === 'x'
            ? { x: p + jitter, y: top, z: z - back, facing }
            : { x: x + Math.sign(s.stepX) * back, y: top, z: p + jitter, facing },
        )
      }
    }
  })

  const merged = (geos: BufferGeometry[]): BufferGeometry => {
    const out = mergeGeometries(geos)
    for (const g of geos) g.dispose()
    return out
  }
  group.add(new Mesh(merged(stepGeos), tierMat))
  stripGeos.forEach((geos, i) => group.add(new Mesh(merged(geos), stripMats[i])))

  // Crowd: one instanced body and one instanced head mesh, dark silhouettes with a little colour.
  const bodyGeo = new CylinderGeometry(0.13, 0.19, 0.62, 5, 1)
  const headGeo = new IcosahedronGeometry(0.12, 0)
  const crowdMat = new MeshBasicMaterial({ color: 0xffffff })
  const bodies = new InstancedMesh(bodyGeo, crowdMat, seats.length)
  const heads = new InstancedMesh(headGeo, crowdMat, seats.length)
  const dummy = new Object3D()
  const tint = new Color()
  const shirts = [0x10142a, 0x1a1029, 0x0c1726, 0x1b0f20, 0x11111d]
  seats.forEach((seat, i) => {
    const h = 0.75 + r() * 0.15
    dummy.position.set(seat.x, seat.y + 0.33 * h, seat.z)
    dummy.rotation.set(0, seat.facing, (r() - 0.5) * 0.12)
    dummy.scale.set(1, h, 1)
    dummy.updateMatrix()
    bodies.setMatrixAt(i, dummy.matrix)
    bodies.setColorAt(i, tint.setHex(shirts[Math.floor(r() * shirts.length)]))
    dummy.position.y = seat.y + 0.33 * h + 0.36 * h
    dummy.scale.setScalar(0.85)
    dummy.updateMatrix()
    heads.setMatrixAt(i, dummy.matrix)
    heads.setColorAt(i, tint.setHex(0x151726))
  })
  group.add(bodies, heads)

  // Glow sticks and phone lights over about a third of the crowd, in two blinking sets.
  const stickSets = [0, 1].map((set) => {
    const pos: number[] = []
    const col: number[] = []
    const c = new Color()
    seats.forEach((seat, i) => {
      if (i % 3 !== set) return
      pos.push(seat.x + (r() - 0.5) * 0.3, seat.y + 0.95 + r() * 0.25, seat.z)
      c.set(r() < 0.7 ? 0xf2f2f5 : CYAN).multiplyScalar(0.55)
      col.push(c.r, c.g, c.b)
    })
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    geo.setAttribute('color', new BufferAttribute(new Float32Array(col), 3))
    const mat = new PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, opacity: 1, depthWrite: false })
    const pts = new Points(geo, mat)
    group.add(pts)
    return mat
  })

  // ---------- LED boards around the ring floor ----------
  const led = ledTexture()
  textures.push(led)
  const boardMats: MeshBasicMaterial[] = []
  const boards: [number, number, number, number][] = [
    // x, z, length, rotationY
    [0, -7.0, 7.6, 0],
    [-3.9, -3.15, 7.3, Math.PI / 2],
    [3.9, -3.15, 7.3, -Math.PI / 2],
  ]
  for (const [x, z, len, ry] of boards) {
    const map = led.clone()
    map.repeat.set(len / 6.5, 1)
    map.needsUpdate = true
    textures.push(map)
    const mat = new MeshBasicMaterial({ map, color: 0xd0d0d6 })
    boardMats.push(mat)
    const board = new Mesh(new PlaneGeometry(len, 0.42), mat)
    board.position.set(x, 0.32, z)
    board.rotation.y = ry
    const back = new Mesh(new BoxGeometry(len, 0.5, 0.06), tierMat)
    back.position.set(0, 0, -0.035)
    board.add(back)
    group.add(board)
  }

  // ---------- floor ----------
  // Pink outer grid lines and a cyan apron rectangle around the ring.
  const apronMat = new MeshBasicMaterial({ color: 0x2a2d36 })
  for (const [w, d, x, z] of [
    [7.8, 0.03, 0, 1.6],
    [7.8, 0.03, 0, -6.2],
    [0.03, 7.8, -3.4, -2.3],
    [0.03, 7.8, 3.4, -2.3],
  ] as const) {
    const line = new Mesh(new BoxGeometry(w, 0.01, d), apronMat)
    line.position.set(x, 0.006, z)
    group.add(line)
  }

  // ---------- back wall ----------
  const wall = new Mesh(new PlaneGeometry(26, 9), tierMat)
  wall.position.set(0, 4.5, -8.2 - DEPTH * ROWS - 0.05)
  group.add(wall)

  return {
    group,
    update(t) {
      for (const [i, mat] of boardMats.entries()) {
        if (mat.map) mat.map.offset.x = (t * 0.06 * (i === 0 ? 1 : -1)) % 1
      }
      stickSets[0].opacity = 0.55 + 0.45 * Math.sin(t * 2.1)
      stickSets[1].opacity = 0.55 + 0.45 * Math.sin(t * 2.1 + Math.PI)
    },
    dispose() {
      for (const tex of textures) tex.dispose()
      group.removeFromParent()
    },
  }
}
