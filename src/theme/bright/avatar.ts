// Bright theme character kit: original friendly toy-figure humanoids. A round head with a simple face and a
// hair cap, a short neck, a rounded torso and hips, short legs with rounded shoes, and short stubby arms
// ending in big mitten hands. Shared by the boxing opponent, the crowd, figurines and other sports.
// Geometries and materials are cached and shared.
import {
  CapsuleGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import type { BufferGeometry, Material, Object3D } from 'three'
import { OUTFIT, SKIN } from './palette.ts'

/** Reference design height (feet to crown) in metres. Everything below is authored at this size, feet at y=0. */
export const REF_HEIGHT = 1.75

/** Body layout in foot space at REF_HEIGHT. */
export const BODY = {
  headY: 1.52,
  headZ: 0.02,
  headR: 0.2,
  /** Head group scale: a slightly tall, slightly flat-faced egg. */
  headScale: [1, 1.07, 0.97] as const,
  torsoBottom: 0.72,
  torsoTop: 1.27,
  hipsY: 0.66,
  legX: 0.105,
  handX: 0.3,
  handY: 0.84,
  /** Seated: everything above the legs drops by this much so the hips sit at y=0. */
  seatDrop: 0.58,
} as const

export const INK = 0x28344a
export const CHEEK = 0xff8fa0
export const HAIR = [0x3b2a20, 0x6b4428, 0xa8683a, 0xe8c26a, 0x262a33, 0xc0482f, 0x9aa0aa] as const
export const HAIR_STYLES = ['cap', 'part', 'bun', 'spiky'] as const
export type HairStyle = (typeof HAIR_STYLES)[number]

// ---------- shared caches ----------

const geoCache = new Map<string, BufferGeometry>()
function geo<T extends BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key)
  if (!g) {
    g = make()
    geoCache.set(key, g)
  }
  return g as T
}

const matCache = new Map<string, Material>()

/** Glossy collectible-figure plastic: clear coat over soft colour, a faint sheen for a rim feel. */
export function glossy(params: ConstructorParameters<typeof MeshPhysicalMaterial>[0] = {}): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    roughness: 0.35,
    metalness: 0,
    clearcoat: 0.8,
    clearcoatRoughness: 0.25,
    sheen: 0.35,
    sheenRoughness: 0.4,
    sheenColor: 0xffffff,
    ...params,
  })
}

/** Shared glossy toy material per colour. */
export function toy(color: number, roughness = 0.35): MeshStandardMaterial {
  const key = `toy:${color}:${roughness}`
  let m = matCache.get(key)
  if (!m) {
    m = glossy({ color, roughness })
    matCache.set(key, m)
  }
  return m as MeshStandardMaterial
}
function flat(color: number, opacity = 1): MeshBasicMaterial {
  const key = `flat:${color}:${opacity}`
  let m = matCache.get(key)
  if (!m) {
    m = new MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 })
    matCache.set(key, m)
  }
  return m as MeshBasicMaterial
}

// ---------- shapes ----------

/** Rounded torso: a lathe with soft shoulders and a slight waist. */
export function torsoGeometry(segments = 32, offset = 0): LatheGeometry {
  const b = BODY.torsoBottom
  const t = BODY.torsoTop
  const prof: [number, number][] = [
    [0, t], [0.1, t - 0.005], [0.17, t - 0.025], [0.215, t - 0.06], [0.235, t - 0.11], [0.238, t - 0.18],
    [0.228, t - 0.27], [0.212, t - 0.36], [0.206, b + 0.06], [0.19, b + 0.015], [0.12, b - 0.01], [0, b - 0.015],
  ]
  return new LatheGeometry(prof.map(([r, y]) => new Vector2(r > 0 ? r * 1.05 + offset : 0, y)), segments, Math.PI, Math.PI * 2)
}

/** Rounded hips (shorts). Local origin at the hips centre. */
export const hipsGeometry = (): BufferGeometry => new SphereGeometry(0.2, 28, 16).scale(1.04, 0.85, 0.92)

const Z = new Vector3(0, 0, 1)

/** Places obj on a sphere of radius r (head space) at elevation el and azimuth az (0 = front), facing out. */
export function onHead(obj: Object3D, el: number, az: number, lift = 0, r = BODY.headR): Object3D {
  const n = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
  obj.position.copy(n).multiplyScalar(r + lift)
  obj.quaternion.multiply(new Quaternion().setFromUnitVectors(Z, n))
  return obj
}

const UP = new Vector3(0, 1, 0)
const span = new Vector3()

/** Unit arm tube (length 1 along y, centred). Stretch it between two points with stretchArm. */
export const armGeometry = (): BufferGeometry => geo('arm', () => new CylinderGeometry(0.052, 0.058, 1, 14, 1, true))

/** Places a unit-length arm mesh between shoulder and hand (both in the parent's space). */
export function stretchArm(arm: Object3D, shoulder: Vector3, hand: Vector3): void {
  span.copy(hand).sub(shoulder)
  const len = Math.max(0.02, span.length())
  arm.position.copy(shoulder).addScaledVector(span, 0.5)
  arm.quaternion.setFromUnitVectors(UP, span.multiplyScalar(1 / len))
  arm.scale.set(1, len, 1)
}

/** Shoulder joint (foot space, REF size) for side -1/1. */
export const SHOULDER = { x: 0.205, y: 1.17 } as const

// ---------- face and hair ----------

export type BrowStyle = 'determined' | 'happy' | 'none'

/** Oval eyes with glints, short brows, nose bump, cheeks and a small smile, in head space. */
export function buildFace(brows: BrowStyle = 'happy', noseMat?: Material): Group {
  const face = new Group()
  face.name = 'face'
  const eyeGeo = geo('eye', () => new SphereGeometry(0.03, 16, 12))
  const glintGeo = geo('glint', () => new SphereGeometry(0.009, 8, 6))
  const browGeo = geo('brow', () => new CapsuleGeometry(0.009, 0.042, 3, 6).rotateZ(Math.PI / 2))
  const cheekGeo = geo('cheek', () => new CircleGeometry(0.03, 18))
  const mouthGeo = geo('mouth', () => new TorusGeometry(0.026, 0.0075, 6, 14, Math.PI).rotateZ(Math.PI))
  const noseGeo = geo('nose', () => new SphereGeometry(0.026, 14, 10))
  const eyeMat = toy(INK, 0.2)
  for (const side of [-1, 1]) {
    const eye = onHead(new Mesh(eyeGeo, eyeMat), 0.06, side * 0.34, -0.006)
    eye.scale.set(0.78, 1.22, 0.5)
    const glint = new Mesh(glintGeo, flat(0xffffff))
    glint.position.set(0.009, 0.014, 0.028)
    glint.scale.set(1 / 0.78, 1 / 1.22, 1 / 0.5)
    eye.add(glint)
    face.add(eye)
    if (brows !== 'none') {
      const brow = onHead(new Mesh(browGeo, eyeMat), 0.3, side * 0.36, 0.002)
      brow.rotateZ(side * (brows === 'determined' ? 0.4 : -0.15))
      face.add(brow)
    }
    const cheek = onHead(new Mesh(cheekGeo, flat(CHEEK, 0.6)), -0.12, side * 0.62, 0.004)
    cheek.scale.set(1, 0.68, 1)
    face.add(cheek)
  }
  if (noseMat) {
    const nose = onHead(new Mesh(noseGeo, noseMat), -0.1, 0, -0.012)
    nose.scale.set(1, 0.85, 0.8)
    face.add(nose)
  }
  face.add(onHead(new Mesh(mouthGeo, eyeMat), -0.33, 0, 0.001))
  return face
}

/** Hair cap plus a style detail, in head space. */
export function buildHair(style: HairStyle, color: number): Group {
  const hair = new Group()
  hair.name = 'hair'
  const mat = toy(color, 0.3)
  // Cap: top of a slightly larger sphere, tipped back so the forehead shows and the back is covered.
  const cap = new Mesh(geo('hair-cap', () => new SphereGeometry(BODY.headR * 1.07, 32, 14, 0, Math.PI * 2, 0, 1.45)), mat)
  cap.rotation.x = -0.42
  hair.add(cap)
  if (style === 'part') {
    const swoop = new Mesh(geo('hair-swoop', () => new SphereGeometry(0.11, 18, 12)), mat)
    swoop.scale.set(1.25, 0.55, 0.8)
    swoop.position.set(-0.07, 0.15, 0.1)
    swoop.rotation.z = 0.35
    hair.add(swoop)
  } else if (style === 'bun') {
    const bun = new Mesh(geo('hair-bun', () => new SphereGeometry(0.085, 18, 12)), mat)
    bun.position.set(0, 0.2, -0.1)
    hair.add(bun)
  } else if (style === 'spiky') {
    const spike = geo('hair-spike', () => new ConeGeometry(0.05, 0.12, 10))
    for (const [x, z, rz, rx] of [[0, 0.06, 0, 0.5], [-0.07, 0.02, 0.45, 0.25], [0.07, 0.02, -0.45, 0.25], [0, -0.06, 0, -0.2]] as const) {
      const s = new Mesh(spike, mat)
      s.position.set(x, 0.2, z)
      s.rotation.set(rx, 0, rz)
      hair.add(s)
    }
  }
  return hair
}

// ---------- humanoid ----------

export interface BeanOptions {
  skin?: number
  outfit?: number
  accent?: number
  /** Standing height feet to crown, metres (default 1.75). */
  height?: number
  /** Seated pose: hips at y=0, legs forward over the seat edge. */
  seated?: boolean
  /** Picks colours and hairstyle from the palette when not given. */
  seed?: number
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(arr: ReadonlyArray<T>, r: () => number): T => arr[Math.floor(r() * arr.length) % arr.length]

export interface FigureMaterials {
  skin: Material
  /** Head skin (separate so the boxer's head can flash on its own). Defaults to skin. */
  head?: Material
  shirt: Material
  shorts: Material
  shoes: Material
}

export interface FigureParts {
  /** Foot space at REF size. */
  fig: Group
  /** Head group, origin at the head centre (scaled egg). */
  head: Group
  face: Group
  torso: Mesh
  hips: Mesh
  hands: Mesh[]
}

/** Builds the humanoid in foot space. hands=false leaves the hands out (the boxer uses gloves). */
export function buildFigure(
  mats: FigureMaterials,
  opts: { hair?: HairStyle | 'none'; hairColor?: number; brows?: BrowStyle; hands?: boolean; seated?: boolean } = {},
): FigureParts {
  const fig = new Group()
  const drop = opts.seated ? BODY.seatDrop : 0
  const headMat = mats.head ?? mats.skin

  const head = new Group()
  head.position.set(0, BODY.headY - drop, BODY.headZ)
  head.scale.set(...BODY.headScale)
  head.add(new Mesh(geo('head', () => new SphereGeometry(BODY.headR, 36, 24)), headMat))
  const earGeo = geo('ear', () => new SphereGeometry(0.045, 14, 10))
  for (const side of [-1, 1]) {
    const ear = new Mesh(earGeo, headMat)
    ear.position.set(side * 0.195, -0.01, -0.01)
    ear.scale.set(0.45, 0.9, 0.75)
    head.add(ear)
  }
  const face = buildFace(opts.brows ?? 'happy', headMat)
  head.add(face)
  if (opts.hair !== 'none') head.add(buildHair(opts.hair ?? 'cap', opts.hairColor ?? HAIR[0]))

  const neck = new Mesh(geo('neck', () => new CylinderGeometry(0.06, 0.07, 0.12, 14)), mats.skin)
  neck.position.y = BODY.torsoTop + 0.03 - drop
  const torso = new Mesh(geo('torso', () => torsoGeometry()), mats.shirt)
  torso.position.y = -drop
  const hips = new Mesh(geo('hips', hipsGeometry), mats.shorts)
  hips.position.y = BODY.hipsY - drop
  fig.add(head, neck, torso, hips)

  const legGeo = geo('leg', () => new CapsuleGeometry(0.092, 0.26, 4, 12))
  const shoeGeo = geo('shoe', () => new SphereGeometry(0.1, 16, 10))
  for (const side of [-1, 1]) {
    const shoe = new Mesh(shoeGeo, mats.shoes)
    shoe.scale.set(1, 0.62, 1.45)
    if (opts.seated) {
      const thigh = new Mesh(legGeo, mats.skin)
      thigh.rotation.x = Math.PI / 2
      thigh.scale.set(1, 0.7, 1)
      thigh.position.set(side * BODY.legX, BODY.hipsY - drop - 0.02, 0.2)
      const shin = new Mesh(legGeo, mats.skin)
      shin.scale.set(1, 0.85, 1)
      shin.position.set(side * BODY.legX, BODY.hipsY - drop - 0.25, 0.38)
      shoe.position.set(side * BODY.legX, BODY.hipsY - drop - 0.5, 0.42)
      fig.add(thigh, shin)
    } else {
      const leg = new Mesh(legGeo, mats.skin)
      leg.position.set(side * BODY.legX, 0.33, 0)
      shoe.position.set(side * BODY.legX, 0.062, 0.035)
      fig.add(leg)
    }
    fig.add(shoe)
  }

  const hands: Mesh[] = []
  if (opts.hands !== false) {
    const handGeo = geo('hand', () => new SphereGeometry(0.075, 18, 12))
    const thumbGeo = geo('thumb', () => new SphereGeometry(0.03, 10, 8))
    const shoulderGeo = geo('shoulder', () => new SphereGeometry(0.068, 14, 10))
    for (const side of [-1, 1]) {
      const hand = new Mesh(handGeo, mats.skin)
      hand.scale.set(0.82, 1, 0.78)
      hand.position.set(side * BODY.handX, BODY.handY - drop * (opts.seated ? 0.85 : 1), opts.seated ? 0.12 : 0.03)
      // Short stubby arm from the shoulder into the mitten.
      const shoulderAt = new Vector3(side * SHOULDER.x, SHOULDER.y - drop, 0)
      const shoulder = new Mesh(shoulderGeo, mats.shirt)
      shoulder.position.copy(shoulderAt)
      const arm = new Mesh(armGeometry(), mats.skin)
      stretchArm(arm, shoulderAt, hand.position.clone().add(new Vector3(0, 0.04, 0)))
      fig.add(shoulder, arm)
      const thumb = new Mesh(thumbGeo, mats.skin)
      thumb.position.set(-side * 0.05, 0.02, 0.05)
      hand.add(thumb)
      hands.push(hand)
      fig.add(hand)
    }
  }
  fig.traverse((o) => {
    const m = o as Mesh
    if (m.isMesh && !(m.material as Material).transparent) m.castShadow = true
  })
  return { fig, head, face, torso, hips, hands }
}

/** A standing (feet at y=0) or seated (hips at y=0) humanoid with seeded colours and hairstyle. */
export function buildHumanoid(opts: BeanOptions = {}): { root: Group; face: Group; dispose(): void } {
  const r = rng(opts.seed ?? 1)
  const skin = opts.skin ?? pick(SKIN, r)
  const outfit = opts.outfit ?? pick(OUTFIT, r)
  const accent = opts.accent ?? pick(OUTFIT.filter((c) => c !== outfit), r)
  const hair = pick(HAIR_STYLES, r)
  const hairColor = pick(HAIR, r)
  const s = (opts.height ?? REF_HEIGHT) / REF_HEIGHT
  const root = new Group()
  const parts = buildFigure(
    { skin: toy(skin), shirt: toy(outfit), shorts: toy(accent), shoes: toy(0xffffff) },
    { hair, hairColor, seated: opts.seated },
  )
  parts.fig.scale.setScalar(s)
  root.add(parts.fig)
  return {
    root,
    face: parts.face,
    dispose() {
      // Geometries and materials are shared through the kit caches; only detach.
      root.removeFromParent()
    },
  }
}

/** Kept name from the first kit: builds a humanoid. */
export const buildBean = buildHumanoid

// ---------- figurine ----------

/** A standing humanoid on a round glossy display base, for menus and result screens. base: base colour. */
export function buildFigurine(opts: BeanOptions & { base?: number } = {}): Group {
  const s = (opts.height ?? REF_HEIGHT) / REF_HEIGHT
  const group = new Group()
  group.name = 'figurine'
  const baseColor = opts.base ?? 0xffffff
  const baseMat = glossy({ color: baseColor, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.12 })
  const ringMat = glossy({ color: new Color(baseColor).multiplyScalar(0.82).getHex(), roughness: 0.25, clearcoat: 1 })
  const h = 0.12 * s
  const r = 0.5 * s
  const plinth = new Mesh(geo('fig-base', () => new CylinderGeometry(1, 1.06, 1, 48, 1)), baseMat)
  plinth.scale.set(r, h, r)
  plinth.position.y = h / 2
  const bevel = new Mesh(geo('fig-bevel', () => new TorusGeometry(1, 0.035, 10, 64)), ringMat)
  bevel.rotation.x = Math.PI / 2
  bevel.scale.set(r, r, r)
  bevel.position.y = h
  const lip = new Mesh(geo('fig-lip', () => new TorusGeometry(1.06, 0.03, 8, 64)), ringMat)
  lip.rotation.x = Math.PI / 2
  lip.scale.set(r, r, r)
  lip.position.y = 0.01 * s
  plinth.castShadow = plinth.receiveShadow = true
  const person = buildHumanoid({ ...opts, seated: false })
  person.root.position.y = h
  group.add(plinth, bevel, lip, person.root)
  return group
}

// ---------- crowd ----------

export interface Seat {
  x: number
  y: number
  z: number
  /** Yaw (rotation.y) of the spectator; 0 faces +z. */
  faceY: number
}

interface Fan {
  base: Matrix4
  phase: number
  cheer: number // <0: waiting to start, 0..CHEER_S running, >= CHEER_S idle
  wave: number
}

const CHEER_S = 1.1

/** Seated spectators drawn with a handful of InstancedMeshes. update() idles, cheer() makes them hop and wave. */
export function buildCrowd(
  seats: ReadonlyArray<Seat>,
  seed = 7,
): { root: Group; update(dtSeconds: number): void; cheer(): void } {
  const r = rng(seed)
  const n = seats.length
  const root = new Group()
  root.name = 'crowd'
  // Cheaper standard materials for the crowd; colour per instance.
  const cheap = (rough = 0.4): MeshStandardMaterial => new MeshStandardMaterial({ color: 0xffffff, roughness: rough })
  const drop = BODY.seatDrop

  const im = (g: BufferGeometry, m: Material, count: number): InstancedMesh => {
    const mesh = new InstancedMesh(g, m, count)
    mesh.frustumCulled = false
    root.add(mesh)
    return mesh
  }
  const head = im(geo('crowd-head', () => new SphereGeometry(BODY.headR, 16, 12).scale(...BODY.headScale)), cheap(), n)
  const hair = im(geo('crowd-hair', () => new SphereGeometry(BODY.headR * 1.07, 16, 8, 0, Math.PI * 2, 0, 1.45).rotateX(-0.42).scale(...BODY.headScale)), cheap(0.3), n)
  const torso = im(geo('crowd-torso', () => torsoGeometry(14)), cheap(), n)
  const hips = im(geo('crowd-hips', () => new SphereGeometry(0.2, 14, 8).scale(1.04, 0.85, 0.92)), cheap(), n)
  const eyes = im(geo('crowd-eye', () => new SphereGeometry(0.032, 8, 6)), new MeshStandardMaterial({ color: INK, roughness: 0.3 }), n * 2)
  const hands = im(geo('crowd-hand', () => new SphereGeometry(0.075, 10, 8).scale(0.82, 1, 0.78)), cheap(), n * 2)
  const arms = im(armGeometry(), cheap(), n * 2)
  const thighs = im(geo('crowd-thigh', () => new CapsuleGeometry(0.09, 0.22, 3, 8).rotateX(Math.PI / 2)), cheap(), n * 2)
  const shins = im(geo('crowd-shin', () => new CapsuleGeometry(0.088, 0.26, 3, 8)), cheap(), n * 2)
  head.castShadow = torso.castShadow = true

  // Fixed part transforms (seated space, hips at y=0, REF size).
  const at = (x: number, y: number, z: number): Matrix4 => new Matrix4().makeTranslation(x, y, z)
  const headL = at(0, BODY.headY - drop, BODY.headZ)
  const torsoL = at(0, -drop, 0)
  const hipsL = at(0, BODY.hipsY - drop, 0)
  const eyeL: Matrix4[] = []
  for (const side of [-1, 1]) {
    const e = onHead(new Group(), 0.06, side * 0.34, -0.008)
    e.scale.set(0.78, 1.22, 0.5)
    e.updateMatrix()
    eyeL.push(new Matrix4().makeScale(...BODY.headScale).premultiply(headL).multiply(e.matrix))
  }
  const legL = [-1, 1].flatMap((side) => [
    at(side * BODY.legX, BODY.hipsY - drop - 0.02, 0.17),
    at(side * BODY.legX, BODY.hipsY - drop - 0.22, 0.34),
  ])

  const fans: Fan[] = []
  const color = new Color()
  const q = new Quaternion()
  const yAxis = new Vector3(0, 1, 0)
  seats.forEach((seat, i) => {
    const sc = 0.62 + r() * 0.14
    q.setFromAxisAngle(yAxis, seat.faceY)
    fans.push({
      base: new Matrix4().compose(new Vector3(seat.x, seat.y, seat.z), q, new Vector3(sc, sc, sc)),
      phase: r() * Math.PI * 2,
      cheer: CHEER_S,
      wave: 0.8 + r() * 0.6,
    })
    color.setHex(pick(SKIN, r))
    head.setColorAt(i, color)
    for (let s = 0; s < 2; s++) {
      hands.setColorAt(i * 2 + s, color)
      arms.setColorAt(i * 2 + s, color)
      shins.setColorAt(i * 2 + s, color)
    }
    hair.setColorAt(i, color.setHex(pick(HAIR, r)))
    torso.setColorAt(i, color.setHex(pick(OUTFIT, r)))
    color.setHex(pick(OUTFIT, r))
    hips.setColorAt(i, color)
    for (let s = 0; s < 2; s++) thighs.setColorAt(i * 2 + s, color)
  })
  for (const m of [head, hair, torso, hips, hands, arms, thighs, shins]) if (m.instanceColor) m.instanceColor.needsUpdate = true
  // Thighs and shins never move with the hop body, so place them once.
  const tmp = new Matrix4()
  fans.forEach((f, i) => {
    for (let s = 0; s < 2; s++) {
      thighs.setMatrixAt(i * 2 + s, tmp.copy(f.base).multiply(legL[s * 2]))
      shins.setMatrixAt(i * 2 + s, tmp.copy(f.base).multiply(legL[s * 2 + 1]))
    }
  })
  thighs.instanceMatrix.needsUpdate = shins.instanceMatrix.needsUpdate = true

  const m = new Matrix4()
  const rot = new Matrix4()
  const handM = new Matrix4()
  const armObj = new Group()
  const handP = new Vector3()
  const shoulderP = [new Vector3(-SHOULDER.x, SHOULDER.y - drop, 0), new Vector3(SHOULDER.x, SHOULDER.y - drop, 0)]
  let time = 0

  function place(): void {
    for (let i = 0; i < n; i++) {
      const f = fans[i]
      let hop = 0
      let raise = 0
      if (f.cheer >= 0 && f.cheer < CHEER_S) {
        const k = f.cheer / CHEER_S
        const env = Math.sin(Math.PI * k)
        hop = Math.abs(Math.sin(k * Math.PI * 3)) * 0.14 * env
        raise = Math.min(1, env * 2.2)
      }
      const bob = Math.sin(time * 2.1 + f.phase) * 0.012
      m.copy(f.base).multiply(tmp.makeTranslation(0, bob + hop, 0))
      m.multiply(rot.makeRotationZ(Math.sin(time * 1.3 + f.phase) * 0.035))
      head.setMatrixAt(i, tmp.copy(m).multiply(headL))
      hair.setMatrixAt(i, tmp)
      torso.setMatrixAt(i, tmp.copy(m).multiply(torsoL))
      hips.setMatrixAt(i, tmp.copy(m).multiply(hipsL))
      for (let s = 0; s < 2; s++) {
        eyes.setMatrixAt(i * 2 + s, tmp.copy(m).multiply(eyeL[s]))
        const side = s === 0 ? -1 : 1
        // Hands rest on the lap, rise overhead and wave while cheering.
        const wave = raise * Math.sin(time * 13 * f.wave + f.phase + s * 2) * 0.07
        handP.set(side * (BODY.handX + raise * 0.06) + wave, 0.26 + raise * 0.62, 0.12 - raise * 0.06)
        hands.setMatrixAt(i * 2 + s, tmp.copy(m).multiply(handM.makeTranslation(handP.x, handP.y, handP.z)))
        stretchArm(armObj, shoulderP[s], handP)
        armObj.updateMatrix()
        arms.setMatrixAt(i * 2 + s, tmp.copy(m).multiply(armObj.matrix))
      }
    }
    for (const x of [head, hair, torso, hips, eyes, hands, arms]) x.instanceMatrix.needsUpdate = true
  }
  place()

  return {
    root,
    update(dt) {
      time += dt
      for (const f of fans) if (f.cheer < CHEER_S) f.cheer += dt
      place()
    },
    cheer() {
      for (const f of fans) f.cheer = -r() * 0.25
    },
  }
}
