// Bright theme boxing arena: a raised outdoor ring on the beach with bleachers and bunting. Original low-poly art.
import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from 'three'
import { OUTFIT, RING, hex } from './palette.ts'
import { buildIslandBackdrop } from './environment.ts'

/** Same ring geometry as the neon arena (gameplay depends on it). */
const R = { halfWidth: 2.3, near: 0.9, far: -5.3, ropes: [0.45, 0.85, 1.25] } as const
/** Apron margin outside the ropes, metres. */
const APRON = 0.45
/** Sand height around the raised ring. The ring mat (and the opponent's feet) are at y = 0. */
export const ARENA_GROUND_Y = -0.55
/** Clear rectangle the island props stay out of (ring, deck, bleachers, bunting poles). */
export const ARENA_FOOTPRINT = { halfWidth: 7.2, near: 2.5, far: -10.6 } as const

const SEAT_TOP = (row: number): number => ARENA_GROUND_Y + 0.5 + row * 0.42
const SIDE_X = (row: number): number => 5.25 + row * 0.85
const SIDE_Z = [-3.8, -4.8, -5.8, -6.8] as const
const BACK_Z = (row: number): number => -8.7 - row * 0.85
const BACK_X = [-2.75, -1.65, -0.55, 0.55, 1.65, 2.75] as const

function seats(): Array<{ x: number; y: number; z: number; faceY: number }> {
  const out: Array<{ x: number; y: number; z: number; faceY: number }> = []
  for (let row = 0; row < 2; row++) {
    for (const z of SIDE_Z) {
      out.push({ x: -SIDE_X(row), y: SEAT_TOP(row), z, faceY: Math.PI / 2 })
      out.push({ x: SIDE_X(row), y: SEAT_TOP(row), z, faceY: -Math.PI / 2 })
    }
    for (const x of BACK_X) out.push({ x, y: SEAT_TOP(row), z: BACK_Z(row), faceY: 0 })
  }
  return out
}

/**
 * World positions where a seated spectator's hips go (top of the bench plank).
 * faceY is rotation.y for a model whose front faces +z, so it looks toward the ring.
 */
export const CROWD_SEATS: ReadonlyArray<{ x: number; y: number; z: number; faceY: number }> = seats()

const std = (color: number, roughness = 0.85, flat = false): MeshStandardMaterial =>
  new MeshStandardMaterial({ color, roughness, metalness: 0, flatShading: flat })

function shadowed<T extends Object3D>(o: T, cast: boolean, receive: boolean): T {
  o.castShadow = cast
  o.receiveShadow = receive
  return o
}

/** Ring mat texture: white apron, sky-blue canvas, darker edge band, lighter centre circle. */
function makeMatTexture(W: number, D: number, zFar: number): CanvasTexture {
  const px = 140 // pixels per metre
  const cw = Math.round(W * px)
  const ch = Math.round(D * px)
  const c = document.createElement('canvas')
  c.width = cw
  c.height = ch
  const g = c.getContext('2d')
  if (g) {
    const X = (x: number): number => (x + W / 2) * px
    const Z = (z: number): number => (z - zFar) * px // canvas row 0 is the far side
    g.fillStyle = hex(RING.apron)
    g.fillRect(0, 0, cw, ch)
    // Mat inside the ropes, running out to the near (rope-less) side.
    const x0 = X(-R.halfWidth)
    const x1 = X(R.halfWidth)
    const z0 = Z(R.far)
    g.fillStyle = hex(RING.matEdge)
    g.fillRect(x0, z0, x1 - x0, ch - z0)
    const band = 0.16 * px
    g.fillStyle = hex(RING.mat)
    g.fillRect(x0 + band, z0 + band, x1 - x0 - band * 2, ch - z0 - band)
    // Light centre circle with a thin white ring.
    const cx = X(0)
    const cz = Z((R.near + R.far) / 2)
    const light = new Color(RING.mat).lerp(new Color(0xa8e0ff), 0.55)
    g.fillStyle = `#${light.getHexString()}`
    g.beginPath()
    g.arc(cx, cz, 1.05 * px, 0, Math.PI * 2)
    g.fill()
    g.strokeStyle = 'rgba(255,255,255,0.9)'
    g.lineWidth = 0.05 * px
    g.beginPath()
    g.arc(cx, cz, 1.05 * px, 0, Math.PI * 2)
    g.stroke()
    // Soft canvas weave so the mat does not look like flat plastic.
    g.globalAlpha = 0.05
    g.fillStyle = '#ffffff'
    for (let y = 0; y < ch; y += 6) g.fillRect(x0 + band, y, x1 - x0 - band * 2, 2)
    g.globalAlpha = 1
    // White apron edge line.
    g.strokeStyle = 'rgba(255,255,255,1)'
    g.lineWidth = 0.05 * px
    g.strokeRect(x0, z0, x1 - x0, ch - z0 + 10)
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** Light wooden planks, tiling. */
function makePlankTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const g = c.getContext('2d')
  if (g) {
    const tones = ['#e2b57a', '#d9a86b', '#e8bf88', '#d4a265']
    for (let i = 0; i < 8; i++) {
      g.fillStyle = tones[i % tones.length]
      g.fillRect(0, i * 32, 256, 32)
      g.fillStyle = 'rgba(120,80,40,0.35)'
      g.fillRect(0, i * 32 + 30, 256, 2)
      g.fillRect(((i * 97) % 200) + 20, i * 32, 2, 30)
    }
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  return tex
}

/** A downward-pointing pennant in its local xy plane, top edge on the string. */
function makePennantGeometry(): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute([-0.14, 0, 0, 0.14, 0, 0, 0, -0.32, 0], 3))
  g.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
  return g
}

export function buildBrightArena(): Group {
  const arena = new Group()
  arena.name = 'bright-arena'
  const { halfWidth: hw, near, far } = R
  const W = (hw + APRON) * 2
  const zNear = near + APRON + 0.6 // a little extra behind the camera
  const zFar = far - APRON
  const D = zNear - zFar
  const zMid = (zNear + zFar) / 2
  const platformH = -ARENA_GROUND_Y

  // ----- ring platform -----
  const mat = new Mesh(
    new PlaneGeometry(W, D),
    new MeshStandardMaterial({ map: makeMatTexture(W, D, zFar), roughness: 0.92, metalness: 0 }),
  )
  mat.rotation.x = -Math.PI / 2
  mat.position.set(0, 0, zMid)
  arena.add(shadowed(mat, false, true))

  const skirt = new Mesh(new BoxGeometry(W, platformH - 0.006, D), std(RING.matEdge))
  skirt.position.set(0, ARENA_GROUND_Y + (platformH - 0.006) / 2, zMid)
  arena.add(shadowed(skirt, true, true))
  const stripeMat = std(RING.ropeAlt)
  const lipMat = std(RING.apron)
  const stripe = new Mesh(new BoxGeometry(W + 0.02, 0.07, D + 0.02), stripeMat)
  stripe.position.set(0, -0.2, zMid)
  const lip = new Mesh(new BoxGeometry(W + 0.03, 0.05, D + 0.03), lipMat)
  lip.position.set(0, -0.03, zMid)
  arena.add(shadowed(stripe, false, true), shadowed(lip, false, true))

  // ----- corner posts and turnbuckle pads -----
  const postMat = std(RING.post, 0.5)
  const postGeo = new CylinderGeometry(0.07, 0.08, 1.5, 14)
  const capGeo = new SphereGeometry(0.085, 14, 8)
  const padGeo = new CapsuleGeometry(0.11, 0.86, 4, 14)
  const corners: Array<[number, number, number]> = [
    [-hw, far, RING.padLeft],
    [hw, far, RING.padRight],
    [-hw, near, RING.apron],
    [hw, near, RING.apron],
  ]
  for (const [x, z, color] of corners) {
    const post = new Mesh(postGeo, postMat)
    post.position.set(x, 0.75, z)
    const cap = new Mesh(capGeo, postMat)
    cap.position.set(x, 1.5, z)
    const pad = new Mesh(padGeo, std(color, 0.6))
    pad.position.set(x, 0.85, z)
    arena.add(shadowed(post, true, true), shadowed(cap, true, false), shadowed(pad, true, true))
  }

  // ----- ropes: white / coral / white on three sides -----
  const ropeMats = [std(RING.rope, 0.5), std(RING.ropeAlt, 0.5), std(RING.rope, 0.5)]
  const sideLen = near - far
  const sideGeo = new CylinderGeometry(0.03, 0.03, sideLen, 10, 1)
  const backGeo = new CylinderGeometry(0.03, 0.03, hw * 2, 10, 1)
  R.ropes.forEach((y, i) => {
    for (const x of [-hw, hw]) {
      const rope = new Mesh(sideGeo, ropeMats[i])
      rope.rotation.x = Math.PI / 2
      rope.position.set(x, y, (near + far) / 2)
      arena.add(shadowed(rope, true, false))
    }
    const back = new Mesh(backGeo, ropeMats[i])
    back.rotation.z = Math.PI / 2
    back.position.set(0, y, far)
    arena.add(shadowed(back, true, false))
  })
  // Rope ties at the middle of each side.
  const tieGeo = new BoxGeometry(0.05, 0.9, 0.07)
  const tieMat = std(RING.apron, 0.6)
  for (const [x, z, ry] of [
    [-hw, (near + far) / 2, 0],
    [hw, (near + far) / 2, 0],
    [0, far, Math.PI / 2],
  ] as const) {
    const tie = new Mesh(tieGeo, tieMat)
    tie.position.set(x, 0.85, z)
    tie.rotation.y = ry
    arena.add(shadowed(tie, true, false))
  }

  // ----- wooden deck around the ring, with steps -----
  const plank = makePlankTexture()
  plank.repeat.set(4, 5)
  const deckMat = new MeshStandardMaterial({ map: plank, roughness: 0.9, metalness: 0 })
  const deckW = 8.6
  const deckD = 11
  const deck = new Mesh(new BoxGeometry(deckW, 0.1, deckD), deckMat)
  deck.position.set(0, ARENA_GROUND_Y + 0.02, -3.6)
  arena.add(shadowed(deck, false, true))
  const stepMat = std(RING.deck, 0.9)
  for (let i = 0; i < 3; i++) {
    const h = ((i + 1) * platformH) / 4
    const step = new Mesh(new BoxGeometry(0.32, h, 1.1), stepMat)
    step.position.set(-W / 2 - 0.16 - (2 - i) * 0.32, ARENA_GROUND_Y + h / 2 + 0.07, -3.9)
    arena.add(shadowed(step, true, true))
  }

  // ----- bleachers (empty; see CROWD_SEATS) -----
  const riserMat = std(0xffffff, 0.8)
  const benchColors = [OUTFIT[1], OUTFIT[0], OUTFIT[3]]
  const benchMats = benchColors.map((c) => std(c, 0.7))
  const plankH = 0.07
  const rowDepth = 0.85
  const addRow = (row: number, cx: number, cz: number, len: number, alongX: boolean, towardRing: number): void => {
    const top = SEAT_TOP(row)
    const h = top - plankH - ARENA_GROUND_Y
    const riser = new Mesh(alongX ? new BoxGeometry(len, h, rowDepth) : new BoxGeometry(rowDepth, h, len), riserMat)
    riser.position.set(cx, ARENA_GROUND_Y + h / 2, cz)
    const bench = new Mesh(
      alongX ? new BoxGeometry(len + 0.1, plankH, 0.42) : new BoxGeometry(0.42, plankH, len + 0.1),
      benchMats[row % benchMats.length],
    )
    // The plank sits at the front (ring side) of the riser.
    const off = (rowDepth / 2 - 0.21) * towardRing
    bench.position.set(alongX ? cx : cx + off, top - plankH / 2, alongX ? cz + off : cz)
    arena.add(shadowed(riser, true, true), shadowed(bench, true, true))
  }
  const sideLenB = SIDE_Z[0] - SIDE_Z[SIDE_Z.length - 1] + 1.0
  const sideMid = (SIDE_Z[0] + SIDE_Z[SIDE_Z.length - 1]) / 2
  const backLen = BACK_X[BACK_X.length - 1] - BACK_X[0] + 1.0
  for (let row = 0; row < 3; row++) {
    addRow(row, -SIDE_X(row), sideMid, sideLenB, false, 1)
    addRow(row, SIDE_X(row), sideMid, sideLenB, false, -1)
    addRow(row, 0, BACK_Z(row), backLen, true, 1)
  }

  // ----- bunting on poles -----
  const poleH = 4.6
  const poleGeo = new CylinderGeometry(0.06, 0.07, poleH, 8)
  const knobGeo = new SphereGeometry(0.13, 10, 8)
  const poleMat = std(0xffffff, 0.6)
  const poles = [
    new Vector3(-4.4, poleH, 0.7),
    new Vector3(4.4, poleH, 0.7),
    new Vector3(-4.4, poleH, -8.0),
    new Vector3(4.4, poleH, -8.0),
  ]
  poles.forEach((p, i) => {
    const pole = new Mesh(poleGeo, poleMat)
    pole.position.set(p.x, ARENA_GROUND_Y + poleH / 2, p.z)
    const knob = new Mesh(knobGeo, std(OUTFIT[i % OUTFIT.length], 0.6))
    knob.position.set(p.x, ARENA_GROUND_Y + poleH + 0.08, p.z)
    arena.add(shadowed(pole, true, false), shadowed(knob, true, false))
  })
  const top = (v: Vector3): Vector3 => new Vector3(v.x, ARENA_GROUND_Y + poleH - 0.05, v.z)
  const strings: Array<[Vector3, Vector3, number]> = [
    [top(poles[2]), top(poles[3]), 0.55],
    [top(poles[0]), top(poles[2]), 0.6],
    [top(poles[1]), top(poles[3]), 0.6],
  ]
  const stringMat = std(0xffffff, 0.7)
  const flagGeo = makePennantGeometry()
  const flagMat = new MeshStandardMaterial({ roughness: 0.8, metalness: 0, side: DoubleSide })
  const flagColors = [OUTFIT[0], OUTFIT[3], OUTFIT[1], OUTFIT[2], 0xffffff, OUTFIT[4], OUTFIT[5]]
  const flagSpacing = 0.42
  const flagCounts = strings.map(([a, b]) => Math.floor(a.distanceTo(b) / flagSpacing))
  const flags = new InstancedMesh(flagGeo, flagMat, flagCounts.reduce((s, n) => s + n, 0))
  const m4 = new Matrix4()
  const dummy = new Object3D()
  const col = new Color()
  let k = 0
  strings.forEach(([a, b, sag], si) => {
    const at = (t: number): Vector3 => a.clone().lerp(b, t).add(new Vector3(0, -sag * 4 * t * (1 - t), 0))
    const pts: Vector3[] = []
    for (let i = 0; i <= 16; i++) pts.push(at(i / 16))
    const curve = new CatmullRomCurve3(pts)
    const tube = new Mesh(new TubeGeometry(curve, 48, 0.01, 4, false), stringMat)
    arena.add(tube)
    const n = flagCounts[si]
    const yaw = Math.atan2(-(b.z - a.z), b.x - a.x)
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n
      dummy.position.copy(at(t))
      dummy.rotation.set(0, yaw, 0)
      dummy.updateMatrix()
      m4.copy(dummy.matrix)
      flags.setMatrixAt(k, m4)
      flags.setColorAt(k, col.set(flagColors[(i + si * 2) % flagColors.length]))
      k++
    }
  })
  flags.instanceMatrix.needsUpdate = true
  if (flags.instanceColor) flags.instanceColor.needsUpdate = true
  flags.computeBoundingSphere()
  arena.add(shadowed(flags, true, false))

  // ----- the island around it -----
  arena.add(buildIslandBackdrop({ exclude: ARENA_FOOTPRINT, groundY: ARENA_GROUND_Y }))
  return arena
}
