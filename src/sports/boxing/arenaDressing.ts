// Neon arena around the boxing ring: tiered stands with a silhouette crowd and glow sticks,
// scrolling LED boards, sweeping spotlight beams, a synthwave horizon and a city skyline.
// Built for speed: instanced crowd and skyline, one canvas texture per board type, no lights,
// no shadows, about 25 draw calls in total.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
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
const PINK = 0xff3d9a
const PURPLE = 0xa47bff
const AMBER = 0xffc83a

/** Pushes a colour above 1 so the bloom pass picks it up (neon theme only uses this module). */
const glow = (hex: number, k: number): Color => new Color(hex).multiplyScalar(k)

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
  const words = ['KINETIC RING', 'FIGHT', 'ROUND 1', 'NO CONTROLLER NEEDED', 'KO']
  const tex = canvasTexture(1024, 64, (ctx) => {
    ctx.fillStyle = '#05060a'
    ctx.fillRect(0, 0, 1024, 64)
    ctx.font = '700 40px "Bebas Neue", "Outfit", system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    let x = 16
    words.forEach((word, i) => {
      ctx.fillStyle = i % 2 === 0 ? '#38c8ff' : '#ff3d9a'
      ctx.fillText(word, x, 34)
      x += ctx.measureText(word).width + 26
      ctx.fillStyle = '#ffc83a'
      ctx.fillText('◆', x, 34)
      x += 46
    })
  })
  tex.wrapS = RepeatWrapping
  return tex
}

/** Sky behind everything: deep navy fading to a pink horizon band. */
function horizonTexture(): CanvasTexture {
  return canvasTexture(512, 256, (ctx) => {
    const sky = ctx.createLinearGradient(0, 0, 0, 256)
    sky.addColorStop(0, '#07080c')
    sky.addColorStop(0.55, '#1a0f33')
    sky.addColorStop(0.86, '#5a1850')
    sky.addColorStop(1, '#ff3d9a')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, 512, 256)
  })
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

const ROWS = 6
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
  const stripMats = [new MeshBasicMaterial({ color: glow(CYAN, 1.15) }), new MeshBasicMaterial({ color: glow(PINK, 1.15) })]
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
        if (r() < 0.12) continue // empty seats keep the rows from looking stamped
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
      c.set([CYAN, PINK, AMBER, PURPLE][Math.floor(r() * 4)]).multiplyScalar(1.4)
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
    const mat = new MeshBasicMaterial({ map, color: glow(0xffffff, 1.05) })
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
  const apronMat = new MeshBasicMaterial({ color: glow(PINK, 1.2) })
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

  // ---------- spotlight beams ----------
  const beamGeo = new ConeGeometry(0.9, 8, 10, 1, true)
  beamGeo.translate(0, -4, 0) // apex at the origin, so rotation sweeps the beam around the lamp
  const beams = [
    { x: -3.2, z: -9.5, color: CYAN, phase: 0 },
    { x: 3.2, z: -9.5, color: PINK, phase: 1.7 },
  ].map((b) => {
    const mat = new MeshBasicMaterial({
      color: b.color,
      transparent: true,
      opacity: 0.035,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
    })
    const beam = new Mesh(beamGeo, mat)
    beam.position.set(b.x, 7.5, b.z)
    group.add(beam)
    return { beam, ...b }
  })

  // ---------- horizon and skyline ----------
  const sky = horizonTexture()
  textures.push(sky)
  const horizon = new Mesh(new PlaneGeometry(110, 16), new MeshBasicMaterial({ map: sky, fog: false, depthWrite: false }))
  horizon.position.set(0, 6, -45)
  horizon.renderOrder = -1
  group.add(horizon)

  const towerGeo = new BoxGeometry(1, 1, 1)
  towerGeo.translate(0, 0.5, 0)
  const towers = new InstancedMesh(towerGeo, new MeshBasicMaterial({ color: 0x0b0a18, fog: false }), 46)
  for (let i = 0; i < 46; i++) {
    const x = -48 + i * 2.1 + (r() - 0.5) * 0.8
    const w = 1.4 + r() * 1.6
    const h = 3 + r() * r() * 11
    dummy.position.set(x, 0, -38 - r() * 4)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(w, h, 1.5)
    dummy.updateMatrix()
    towers.setMatrixAt(i, dummy.matrix)
  }
  group.add(towers)

  return {
    group,
    update(t) {
      for (const [i, mat] of boardMats.entries()) {
        if (mat.map) mat.map.offset.x = (t * 0.06 * (i === 0 ? 1 : -1)) % 1
      }
      stickSets[0].opacity = 0.55 + 0.45 * Math.sin(t * 2.1)
      stickSets[1].opacity = 0.55 + 0.45 * Math.sin(t * 2.1 + Math.PI)
      for (const b of beams) {
        b.beam.rotation.set(0.35 + 0.15 * Math.sin(t * 0.5 + b.phase), 0, 0.3 * Math.sin(t * 0.37 + b.phase))
        b.beam.rotation.x *= -1 // lean in toward the ring from behind the back stand
      }
    },
    dispose() {
      for (const tex of textures) tex.dispose()
      group.removeFromParent()
    },
  }
}
