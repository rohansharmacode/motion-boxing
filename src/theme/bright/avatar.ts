// Bright theme character kit: original "gummy bean" folk. One rounded body (head and torso are the same
// shape), simple dot eyes with glints, rosy cheeks, stubby limbs. Shared by the boxing opponent, the crowd
// and any other sport. Geometries and materials are cached and shared between beans.
import {
  CapsuleGeometry,
  CircleGeometry,
  Color,
  Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  CylinderGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import type { BufferGeometry, Material, Object3D } from 'three'
import { OUTFIT, SKIN } from './palette.ts'

/** Reference design height (feet to crown) in metres. Everything below is authored at this size. */
export const REF_HEIGHT = 1.75

/** The bean body in "foot space" (feet at y=0) at REF_HEIGHT. */
// Head-heavy toy silhouette: the upper bean (face) is wider than the belly.
export const BEAN = { bottom: 0.48, top: 1.75, wBottom: 0.3, wTop: 0.355, k: 2.6 } as const
const HALF = (BEAN.top - BEAN.bottom) / 2
const MID = BEAN.bottom + HALF

/** Where the face sits (foot space, REF_HEIGHT). */
export const FACE = { eyeY: 1.5, browY: 1.575, cheekY: 1.44, mouthY: 1.405, eyeTheta: 0.3 } as const

export const INK = 0x28344a
export const CHEEK = 0xff8fa0

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Bean radius at height y (foot space). A superellipse that is a little wider at the belly. */
export function beanRadius(y: number): number {
  const u = clamp((y - MID) / HALF, -1, 1)
  const w = BEAN.wBottom + (BEAN.wTop - BEAN.wBottom) * smooth(-0.55, 0.35, u)
  return w * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), BEAN.k)), 1 / BEAN.k)
}

/** Lathe profile from u0 to u1 (-1 bottom, 1 top), denser near the rounded ends. */
function beanProfile(rows: number, offset: number, u0 = -1, u1 = 1): Vector2[] {
  const p0 = Math.acos(-u0)
  const p1 = Math.acos(-u1)
  const pts: Vector2[] = []
  for (let i = 0; i <= rows; i++) {
    const u = -Math.cos(p0 + ((p1 - p0) * i) / rows)
    const y = MID + u * HALF
    const r = beanRadius(y)
    pts.push(new Vector2(r > 1e-4 ? r + offset : 0, y))
  }
  return pts
}

/** Full bean or a band of it (u0..u1), seam at the back. offset pushes it out (clothes). */
export function beanGeometry(segments: number, rows: number, offset = 0, u0 = -1, u1 = 1): LatheGeometry {
  return new LatheGeometry(beanProfile(rows, offset, u0, u1), segments, Math.PI, Math.PI * 2)
}

/** u parameter for a height (foot space). */
export const beanU = (y: number): number => (y - MID) / HALF

/** Reorders an indexed geometry into two material groups by each triangle's lowest vertex: below yCut (group 0) and above (group 1). */
export function splitByHeight(geo: BufferGeometry, yCut: number): BufferGeometry {
  const index = geo.getIndex()
  const pos = geo.getAttribute('position')
  if (!index) return geo
  const low: number[] = []
  const high: number[] = []
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t)
    const b = index.getX(t + 1)
    const c = index.getX(t + 2)
    const y = Math.min(pos.getY(a), pos.getY(b), pos.getY(c)) // whole lathe quads stay together
    ;(y > yCut ? high : low).push(a, b, c)
  }
  geo.setIndex([...low, ...high])
  geo.clearGroups()
  geo.addGroup(0, low.length, 0)
  geo.addGroup(low.length, high.length, 1)
  return geo
}

const Z = new Vector3(0, 0, 1)

/** Places obj on the bean surface at height y, angle theta (0 = front, +x side positive), facing out. */
export function onSurface(obj: Object3D, y: number, theta: number, lift = 0): Object3D {
  const r = beanRadius(y)
  const dr = (beanRadius(y + 0.005) - beanRadius(y - 0.005)) / 0.01
  const s = Math.sin(theta)
  const c = Math.cos(theta)
  obj.position.set((r + lift) * s, y, (r + lift) * c)
  const n = new Vector3(s, -dr, c).normalize()
  obj.quaternion.multiply(new Quaternion().setFromUnitVectors(Z, n))
  return obj
}

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
/** Soft toy plastic, shared per colour. */
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

// ---------- face ----------

export type BrowStyle = 'determined' | 'happy' | 'none'

/** Dot eyes with glints, brows, cheeks and a small smile, laid on the bean surface (foot space). */
export function buildFace(brows: BrowStyle = 'happy', dy = 0): Group {
  const face = new Group()
  face.name = 'face'
  const eyeGeo = geo('eye', () => new SphereGeometry(0.054, 16, 12))
  const glintGeo = geo('glint', () => new SphereGeometry(0.012, 8, 6))
  const browGeo = geo('brow', () => new CapsuleGeometry(0.011, 0.05, 3, 6).rotateZ(Math.PI / 2))
  const cheekGeo = geo('cheek', () => new CircleGeometry(0.042, 18))
  const mouthGeo = geo('mouth', () => new TorusGeometry(0.03, 0.0085, 6, 14, Math.PI).rotateZ(Math.PI))
  const eyeMat = toy(INK, 0.25)
  const glintMat = flat(0xffffff)
  const cheekMat = flat(CHEEK, 0.6)

  for (const side of [-1, 1]) {
    const eye = onSurface(new Mesh(eyeGeo, eyeMat), FACE.eyeY + dy, side * FACE.eyeTheta, -0.008)
    eye.scale.set(0.82, 1.18, 0.5)
    const glint = new Mesh(glintGeo, glintMat)
    glint.position.set(0.012, 0.02, 0.04) // eye space; upper-right glint on both eyes (one light)
    glint.scale.set(1 / 0.82, 1 / 1.18, 1 / 0.5)
    eye.add(glint)
    face.add(eye)

    if (brows !== 'none') {
      const brow = onSurface(new Mesh(browGeo, eyeMat), FACE.browY + dy, side * (FACE.eyeTheta + 0.02), 0.002)
      // determined: inner ends low; happy: gentle arch (inner ends a touch high)
      brow.rotateZ(side * (brows === 'determined' ? 0.38 : -0.16))
      face.add(brow)
    }
    const cheek = onSurface(new Mesh(cheekGeo, cheekMat), FACE.cheekY + dy, side * 0.52, 0.007)
    cheek.scale.set(1, 0.66, 1)
    face.add(cheek)
  }
  const mouth = onSurface(new Mesh(mouthGeo, eyeMat), FACE.mouthY + dy, 0, 0.002)
  face.add(mouth)
  return face
}

// ---------- single bean ----------

export interface BeanOptions {
  skin?: number
  outfit?: number
  accent?: number
  /** Standing height feet to crown, metres (default 1.75). */
  height?: number
  /** Seated pose: hips (bean bottom) at y=0, legs forward. */
  seated?: boolean
  /** Picks skin/outfit/accent from the palette when they are not given. */
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

/** A standing (feet at y=0) or seated (hips at y=0) bean character. */
export function buildBean(opts: BeanOptions = {}): { root: Group; face: Group; dispose(): void } {
  const r = rng(opts.seed ?? 1)
  const skin = opts.skin ?? pick(SKIN, r)
  const outfit = opts.outfit ?? pick(OUTFIT, r)
  const accent = opts.accent ?? pick(OUTFIT.filter((c) => c !== outfit), r)
  const s = (opts.height ?? REF_HEIGHT) / REF_HEIGHT

  const root = new Group()
  const fig = new Group() // foot space at REF size
  fig.scale.setScalar(s)
  if (opts.seated) fig.position.y = -BEAN.bottom * s
  root.add(fig)

  const skinMat = toy(skin)
  const outfitMat = toy(outfit)
  const accentMat = toy(accent)
  const bodyGeo = geo('bean', () => beanGeometry(28, 26))
  const shirtGeo = geo('shirt', () => beanGeometry(28, 12, 0.012, beanU(0.8), beanU(1.27)))
  const shortsGeo = geo('shorts', () => beanGeometry(28, 8, 0.016, -1, beanU(0.8)))
  const legGeo = geo('leg', () => new CapsuleGeometry(0.095, 0.36, 4, 12))
  const shoeGeo = geo('shoe', () => new SphereGeometry(0.11, 16, 10))
  const armGeo = geo('arm', () => new CapsuleGeometry(0.068, 0.2, 4, 10).translate(0, -0.14, 0))
  const handGeo = geo('hand', () => new SphereGeometry(0.085, 14, 10))

  const parts: Mesh[] = [
    new Mesh(bodyGeo, skinMat),
    new Mesh(shirtGeo, outfitMat),
    new Mesh(shortsGeo, accentMat),
  ]
  for (const side of [-1, 1]) {
    const leg = new Mesh(legGeo, skinMat)
    const shoe = new Mesh(shoeGeo, toy(0xffffff))
    shoe.scale.set(1, 0.62, 1.35)
    if (opts.seated) {
      leg.rotation.x = Math.PI / 2
      leg.position.set(side * 0.15, 0.58, 0.26)
      shoe.position.set(side * 0.15, 0.58, 0.52)
      shoe.rotation.x = -1.2
    } else {
      leg.position.set(side * 0.15, 0.36, 0)
      shoe.position.set(side * 0.15, 0.068, 0.04)
    }
    const arm = new Mesh(armGeo, skinMat)
    arm.position.set(side * 0.3, 1.13, 0)
    arm.rotation.z = side * 0.32
    const hand = new Mesh(handGeo, skinMat)
    hand.position.set(0, -0.3, 0)
    arm.add(hand)
    parts.push(leg, shoe, arm)
  }
  for (const p of parts) {
    p.castShadow = true
    fig.add(p)
  }
  const face = buildFace(opts.seed !== undefined && opts.seed % 3 === 0 ? 'none' : 'happy')
  fig.add(face)
  return {
    root,
    face,
    dispose() {
      // Geometries and materials are shared through the kit caches; only detach.
      root.removeFromParent()
    },
  }
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

/** Seated spectators drawn with a handful of InstancedMeshes. update() idles, cheer() makes them hop. */
export function buildCrowd(
  seats: ReadonlyArray<Seat>,
  seed = 7,
): { root: Group; update(dtSeconds: number): void; cheer(): void } {
  const r = rng(seed)
  const n = seats.length
  const root = new Group()
  root.name = 'crowd'
  const white = (): MeshStandardMaterial => glossy({ color: 0xffffff })

  const bodyGeo = geo('crowd-bean', () => beanGeometry(16, 14))
  const shirtGeo = geo('crowd-shirt', () => beanGeometry(16, 6, 0.014, -1, beanU(1.25)))
  const eyeGeo = geo('crowd-eye', () => new SphereGeometry(0.05, 8, 6))
  const cheekGeo = geo('crowd-cheek', () => new CircleGeometry(0.05, 10))
  const armGeo = geo('crowd-arm', () => new CapsuleGeometry(0.075, 0.2, 3, 8).translate(0, -0.15, 0))

  const body = new InstancedMesh(bodyGeo, white(), n)
  const shirt = new InstancedMesh(shirtGeo, white(), n)
  const eyes = new InstancedMesh(eyeGeo, toy(INK, 0.3), n * 2)
  const cheeks = new InstancedMesh(cheekGeo, new MeshBasicMaterial({ color: CHEEK, transparent: true, opacity: 0.6, depthWrite: false }), n * 2)
  const arms = new InstancedMesh(armGeo, white(), n * 2)
  body.castShadow = shirt.castShadow = true
  root.add(body, shirt, eyes, cheeks, arms)

  // Part transforms in seated bean space (hips at 0), REF size.
  const lift = -BEAN.bottom
  const eyeL: Matrix4[] = []
  const cheekL: Matrix4[] = []
  for (const side of [-1, 1]) {
    const e = onSurface(new Group(), FACE.eyeY, side * 0.32, -0.012)
    e.scale.set(0.8, 1.2, 0.5)
    e.position.y += lift
    e.updateMatrix()
    eyeL.push(e.matrix.clone())
    const c = onSurface(new Group(), FACE.cheekY - 0.01, side * 0.55, 0.008)
    c.scale.set(1, 0.65, 1)
    c.position.y += lift
    c.updateMatrix()
    cheekL.push(c.matrix.clone())
  }
  const shift = new Matrix4().makeTranslation(0, lift, 0)

  const fans: Fan[] = []
  const color = new Color()
  const tmp = new Matrix4()
  const q = new Quaternion()
  const yAxis = new Vector3(0, 1, 0)
  seats.forEach((seat, i) => {
    const sc = 0.6 + r() * 0.14
    q.setFromAxisAngle(yAxis, seat.faceY)
    const base = new Matrix4().compose(new Vector3(seat.x, seat.y, seat.z), q, new Vector3(sc, sc, sc))
    fans.push({ base, phase: r() * Math.PI * 2, cheer: CHEER_S, wave: 0.8 + r() * 0.6 })
    const skin = pick(SKIN, r)
    body.setColorAt(i, color.setHex(skin))
    arms.setColorAt(i * 2, color)
    arms.setColorAt(i * 2 + 1, color)
    shirt.setColorAt(i, color.setHex(pick(OUTFIT, r)))
  })

  const m = new Matrix4()
  const armM = new Matrix4()
  const rot = new Matrix4()
  let time = 0

  function place(): void {
    for (let i = 0; i < n; i++) {
      const f = fans[i]
      let hop = 0
      let raise = 0
      if (f.cheer >= 0 && f.cheer < CHEER_S) {
        const k = f.cheer / CHEER_S
        const env = Math.sin(Math.PI * k)
        hop = Math.abs(Math.sin(k * Math.PI * 3)) * 0.16 * env
        raise = Math.min(1, env * 2.2)
      }
      const bob = Math.sin(time * 2.1 + f.phase) * 0.012
      m.copy(f.base).multiply(tmp.makeTranslation(0, bob + hop, 0))
      // Small sway so the crowd never freezes.
      m.multiply(rot.makeRotationZ(Math.sin(time * 1.3 + f.phase) * 0.04))
      body.setMatrixAt(i, tmp.copy(m).multiply(shift))
      shirt.setMatrixAt(i, tmp)
      for (let s = 0; s < 2; s++) {
        eyes.setMatrixAt(i * 2 + s, tmp.copy(m).multiply(eyeL[s]))
        cheeks.setMatrixAt(i * 2 + s, tmp.copy(m).multiply(cheekL[s]))
        const side = s === 0 ? -1 : 1
        const wave = raise * Math.sin(time * 14 * f.wave + f.phase + s) * 0.25
        const angle = side * (0.3 + raise * 2.45 + wave)
        armM.makeTranslation(side * 0.3, 1.12 + lift, 0).multiply(rot.makeRotationZ(angle))
        arms.setMatrixAt(i * 2 + s, tmp.copy(m).multiply(armM))
      }
    }
    for (const im of [body, shirt, eyes, cheeks, arms]) im.instanceMatrix.needsUpdate = true
  }
  place()
  for (const im of [body, shirt, arms]) if (im.instanceColor) im.instanceColor.needsUpdate = true
  for (const im of [body, shirt, eyes, cheeks, arms]) im.frustumCulled = false

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

// ---------- figurine ----------

/** A bean standing on a round glossy display base, for menus and result screens. base: base colour. */
export function buildFigurine(opts: BeanOptions & { base?: number } = {}): Group {
  const s = (opts.height ?? REF_HEIGHT) / REF_HEIGHT
  const fig = new Group()
  fig.name = 'figurine'
  const baseColor = opts.base ?? 0xffffff
  const baseMat = glossy({ color: baseColor, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.12 })
  const ringMat = glossy({ color: new Color(baseColor).multiplyScalar(0.82).getHex(), roughness: 0.25, clearcoat: 1 })
  const h = 0.12 * s
  const r = 0.55 * s
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
  const bean = buildBean({ ...opts, seated: false })
  bean.root.position.y = h
  fig.add(plinth, bevel, lip, bean.root)
  return fig
}
