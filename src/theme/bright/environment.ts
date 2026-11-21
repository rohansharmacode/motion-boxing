// Bright theme world: sunny island resort sky, lights, sea and props. Original low-poly art from primitives only.
import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
  EquirectangularReflectionMapping,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  PCFShadowMap,
  PlaneGeometry,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Vector3,
} from 'three'
import type { Material, Scene, WebGLRenderer } from 'three'
import { CLOUD, LAND, OUTFIT, PALM, SEA, SKY, hex } from './palette.ts'

export interface BrightEnvironment {
  update(dtSeconds: number): void
  dispose(): void
  sun: DirectionalLight
}

export interface EnvironmentOptions {
  shadowFocus?: Vector3
  shadowSize?: number
  fogNear?: number
  fogFar?: number
}

export interface PlayArea {
  halfWidth: number
  near: number
  far: number
}

export interface BackdropOptions {
  /** Rectangle (x in [-halfWidth, halfWidth], z in [far, near]) kept clear of props. */
  exclude?: PlayArea
  /** Height of the sand top. Default -0.02 (just under a y = 0 play floor). */
  groundY?: number
}

/** Direction the sunlight comes from: high, behind-left of a camera looking down -z. */
const SUN_DIR = new Vector3(-0.5, 0.82, 0.38).normalize()
const TICK_KEY = 'brightTick'
/** Sand pushed a little warmer than LAND.sand so it survives ACES desaturation. */
const SAND_LIT = 0xffdb94
type Tick = (dt: number, t: number) => void

// ---------- small helpers ----------

/** Deterministic PRNG so the island looks the same every load. */
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

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')]
}

const lambert = (color: number, flat = true): MeshLambertMaterial =>
  new MeshLambertMaterial({ color, flatShading: flat })

function shadowed<T extends Object3D>(o: T, cast: boolean, receive: boolean): T {
  o.castShadow = cast
  o.receiveShadow = receive
  return o
}

// ---------- sky ----------

function makeSkyTexture(): CanvasTexture {
  const W = 1024
  const H = 512
  const [c, g] = canvas(W, H)
  if (g) {
    // Rows: v = 1 (top) is straight up, the middle row is the horizon.
    const grd = g.createLinearGradient(0, 0, 0, H)
    grd.addColorStop(0, hex(SKY.top))
    grd.addColorStop(0.3, hex(SKY.top))
    grd.addColorStop(0.43, hex(SKY.mid))
    grd.addColorStop(0.488, hex(SKY.horizon))
    grd.addColorStop(0.5, hex(SKY.haze))
    grd.addColorStop(0.53, hex(SKY.haze))
    grd.addColorStop(1, hex(SEA.deep))
    g.fillStyle = grd
    g.fillRect(0, 0, W, H)
    // Sun disc and glow at the real light direction (equirect u = atan2(z, x) / 2pi + 0.5).
    const u = Math.atan2(SUN_DIR.z, SUN_DIR.x) / (Math.PI * 2) + 0.5
    const v = Math.asin(SUN_DIR.y) / Math.PI + 0.5
    const sx = u * W
    const sy = (1 - v) * H
    for (const dx of [-W, 0, W]) {
      const glow = g.createRadialGradient(sx + dx, sy, 0, sx + dx, sy, 120)
      glow.addColorStop(0, 'rgba(255,253,235,1)')
      glow.addColorStop(0.12, 'rgba(255,248,220,0.95)')
      glow.addColorStop(0.2, 'rgba(255,240,200,0.45)')
      glow.addColorStop(1, 'rgba(255,240,200,0)')
      g.fillStyle = glow
      g.fillRect(sx + dx - 130, sy - 130, 260, 260)
    }
  }
  const tex = new CanvasTexture(c)
  tex.mapping = EquirectangularReflectionMapping
  tex.colorSpace = SRGBColorSpace
  return tex
}

/** Soft radial dot, white centre to transparent edge. */
function makeDotTexture(inner: string, outer: string, size = 128): CanvasTexture {
  const [c, g] = canvas(size, size)
  if (g) {
    const h = size / 2
    const grd = g.createRadialGradient(h, h, 0, h, h, h)
    grd.addColorStop(0, inner)
    grd.addColorStop(0.45, inner.replace(/[\d.]+\)$/, (m) => `${parseFloat(m) * 0.6})`))
    grd.addColorStop(1, outer)
    g.fillStyle = grd
    g.fillRect(0, 0, size, size)
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  return tex
}

// ---------- environment (renderer, sky, fog, lights) ----------

export function applyBrightEnvironment(
  scene: Scene,
  renderer: WebGLRenderer,
  opts: EnvironmentOptions = {},
): BrightEnvironment {
  const focus = opts.shadowFocus ?? new Vector3(0, 0, -2)
  const size = opts.shadowSize ?? 12

  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFShadowMap
  renderer.setClearColor(SKY.mid, 1)

  const prevBackground = scene.background
  const prevFog = scene.fog
  const sky = makeSkyTexture()
  scene.background = sky
  scene.backgroundIntensity = 1.0
  scene.fog = new Fog(SKY.haze, opts.fogNear ?? 22, opts.fogFar ?? 75)

  const hemi = new HemisphereLight(0xcdeaff, 0xf2d6a0, 1.15)
  const sun = new DirectionalLight(0xffeccc, 1.75)
  sun.position.copy(focus).addScaledVector(SUN_DIR, 30)
  sun.target.position.copy(focus)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  const cam = sun.shadow.camera
  cam.left = -size / 2
  cam.right = size / 2
  cam.top = size / 2
  cam.bottom = -size / 2
  cam.near = 1
  cam.far = 70
  cam.updateProjectionMatrix()
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.025
  sun.shadow.radius = 4
  // Weak cool fill from the front-right so shadowed faces stay soft and readable.
  const fill = new DirectionalLight(0xd8ecff, 0.45)
  fill.position.set(4, 3, -6)
  scene.add(hemi, sun, sun.target, fill)

  let ticks: Tick[] = []
  let rescan = 0
  let time = 0
  const scan = (): void => {
    ticks = []
    scene.traverse((o) => {
      const t = o.userData[TICK_KEY] as Tick | undefined
      if (typeof t === 'function') ticks.push(t)
    })
  }

  return {
    sun,
    update(dt) {
      time += dt
      rescan -= dt
      if (rescan <= 0) {
        scan()
        rescan = 1
      }
      for (const t of ticks) t(dt, time)
    },
    dispose() {
      scene.remove(hemi, sun, sun.target, fill)
      sun.dispose()
      fill.dispose()
      hemi.dispose()
      sky.dispose()
      if (scene.background === sky) scene.background = prevBackground
      scene.fog = prevFog
      scene.backgroundIntensity = 1
      ticks = []
    },
  }
}

// ---------- blob shadow ----------

/** Cheap soft contact shadow for a character: a dark radial gradient on a floor plane. Position it at the feet. */
export function makeBlobShadow(radius: number): Mesh {
  const tex = makeDotTexture('rgba(20,40,60,1)', 'rgba(20,40,60,0)')
  const mesh = new Mesh(
    new PlaneGeometry(radius * 2, radius * 2),
    new MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = 0.005
  mesh.renderOrder = 1
  return mesh
}

// ---------- props ----------

interface Kit {
  trunkGeo: CylinderGeometry
  frondGeo: BufferGeometry
  coconutGeo: IcosahedronGeometry
  cloudGeo: IcosahedronGeometry
  trunk: MeshLambertMaterial
  trunkRing: MeshLambertMaterial
  leaf: MeshLambertMaterial
  leafLight: MeshLambertMaterial
  coconut: MeshLambertMaterial
  cloud: MeshLambertMaterial
  white: MeshLambertMaterial
  wood: MeshLambertMaterial
}

/** One drooping palm frond along +x with a V-folded midrib. */
function makeFrondGeometry(): BufferGeometry {
  const N = 6
  const L = 1.9
  const pos: number[] = []
  const pts: Array<{ c: Vector3; l: Vector3; r: Vector3 }> = []
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const x = L * t
    const y = Math.sin(t * Math.PI * 0.55) * 0.42 - t * t * 1.05
    const w = 0.3 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.08)), 0.75) + (i === 0 ? 0.03 : 0)
    pts.push({ c: new Vector3(x, y, 0), l: new Vector3(x, y - w * 0.4, -w), r: new Vector3(x, y - w * 0.4, w) })
  }
  const tri = (a: Vector3, b: Vector3, c: Vector3): void => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  }
  for (let i = 0; i < N; i++) {
    const p = pts[i]
    const q = pts[i + 1]
    tri(p.c, q.c, p.l)
    tri(p.l, q.c, q.l)
    tri(p.c, p.r, q.c)
    tri(p.r, q.r, q.c)
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geo.computeVertexNormals()
  return geo
}

function makeKit(): Kit {
  const leafMat = (c: number): MeshLambertMaterial => new MeshLambertMaterial({ color: c, flatShading: true, side: DoubleSide })
  return {
    trunkGeo: new CylinderGeometry(0.84, 1, 1, 7, 1),
    frondGeo: makeFrondGeometry(),
    coconutGeo: new IcosahedronGeometry(0.11, 0),
    cloudGeo: new IcosahedronGeometry(1, 1),
    trunk: lambert(PALM.trunk),
    trunkRing: lambert(PALM.trunkRing),
    leaf: leafMat(PALM.leaf),
    leafLight: leafMat(PALM.leafLight),
    coconut: lambert(PALM.coconut),
    cloud: new MeshLambertMaterial({
      color: CLOUD,
      emissive: 0xe4f2ff,
      emissiveIntensity: 0.78,
      flatShading: true,
      fog: false,
    }),
    white: lambert(0xffffff),
    wood: lambert(0xd9a86b),
  }
}

/** Curved, banded low-poly palm. Height in metres, lean in radians toward +x before yaw. */
function makePalm(kit: Kit, height: number, lean: number, yaw: number, rand: () => number): Group {
  const palm = new Group()
  const segs = 7
  const len = height / segs
  const p = new Vector3()
  let a = 0
  const bend = lean / segs
  for (let i = 0; i < segs; i++) {
    a += bend * (0.6 + (i / segs) * 0.9)
    const dir = new Vector3(Math.sin(a), Math.cos(a), 0)
    const r = 0.17 - i * 0.012
    const seg = new Mesh(kit.trunkGeo, i % 2 ? kit.trunkRing : kit.trunk)
    seg.scale.set(r, len * 1.04, r)
    seg.position.copy(p).addScaledVector(dir, len / 2)
    seg.rotation.z = -a
    palm.add(shadowed(seg, true, false))
    p.addScaledVector(dir, len)
  }
  const crown = new Group()
  crown.position.copy(p)
  const fronds = 8
  for (let i = 0; i < fronds; i++) {
    const f = new Mesh(kit.frondGeo, i % 2 ? kit.leafLight : kit.leaf)
    f.rotation.y = (i / fronds) * Math.PI * 2 + rand() * 0.3
    f.rotation.z = (rand() - 0.5) * 0.35
    const s = 0.85 + rand() * 0.3
    f.scale.set(s * (height / 5.5), s, s)
    crown.add(shadowed(f, true, false))
  }
  for (let i = 0; i < 3; i++) {
    const c = new Mesh(kit.coconutGeo, kit.coconut)
    const ang = (i / 3) * Math.PI * 2
    c.position.set(Math.cos(ang) * 0.13, -0.12, Math.sin(ang) * 0.13)
    crown.add(shadowed(c, true, false))
  }
  palm.add(crown)
  palm.rotation.y = yaw
  return palm
}

function makeCloud(kit: Kit, rand: () => number, scale: number): Group {
  const cloud = new Group()
  const puffs = 4 + Math.floor(rand() * 3)
  for (let i = 0; i < puffs; i++) {
    const m = new Mesh(kit.cloudGeo, kit.cloud)
    const t = puffs === 1 ? 0 : i / (puffs - 1) - 0.5
    const s = (1.1 - Math.abs(t) * 1.0 + rand() * 0.35) * scale
    m.scale.set(s, s * 0.8, s)
    m.position.set(t * 3.4 * scale, (rand() * 0.4 - Math.abs(t) * 0.6) * scale, (rand() - 0.5) * 1.2 * scale)
    cloud.add(m)
  }
  return cloud
}

/** Beach umbrella with vertex-coloured stripes, plus a pole. */
function makeUmbrella(kit: Kit, a: number, b: number): Group {
  const g = new Group()
  const canopy = new ConeGeometry(1.05, 0.42, 10, 1, true).toNonIndexed()
  const pos = canopy.getAttribute('position')
  const colors = new Float32Array(pos.count * 3)
  const ca = new Color(a)
  const cb = new Color(b)
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3
    const seg = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * 10 + 0.5) % 2
    const c = seg ? ca : cb
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (i + k) * 3)
  }
  canopy.setAttribute('color', new BufferAttribute(colors, 3))
  const top = new Mesh(canopy, new MeshLambertMaterial({ vertexColors: true, flatShading: true, side: DoubleSide }))
  top.position.y = 2.05
  const pole = new Mesh(new CylinderGeometry(0.03, 0.03, 2.2, 5), kit.white)
  pole.position.y = 1.1
  const knob = new Mesh(new SphereGeometry(0.06, 6, 4), kit.white)
  knob.position.y = 2.28
  g.add(shadowed(top, true, false), shadowed(pole, true, false), knob)
  return g
}

/** Striped lounge chair facing +z. */
function makeDeckChair(kit: Kit, color: number): Group {
  const g = new Group()
  const seat = new Mesh(new PlaneGeometry(0.55, 1.0, 1, 1), new MeshLambertMaterial({ color, side: DoubleSide }))
  seat.rotation.x = -Math.PI / 2 + 0.12
  seat.position.set(0, 0.32, 0.15)
  const back = new Mesh(new PlaneGeometry(0.55, 0.7), new MeshLambertMaterial({ color, side: DoubleSide }))
  back.rotation.x = -0.75
  back.position.set(0, 0.55, -0.55)
  const stripe = new Mesh(new PlaneGeometry(0.18, 1.0), new MeshLambertMaterial({ color: 0xffffff, side: DoubleSide }))
  stripe.rotation.copy(seat.rotation)
  stripe.position.copy(seat.position).add(new Vector3(0, 0.004, 0))
  const legGeo = new CylinderGeometry(0.025, 0.025, 0.36, 4)
  for (const [x, z] of [
    [-0.26, 0.6],
    [0.26, 0.6],
    [-0.26, -0.3],
    [0.26, -0.3],
  ] as const) {
    const leg = new Mesh(legGeo, kit.wood)
    leg.position.set(x, 0.18, z)
    g.add(leg)
  }
  g.add(shadowed(seat, true, true), shadowed(back, true, false), stripe)
  return g
}

function makeSailboat(kit: Kit, sail: number): Group {
  const g = new Group()
  const hull = new Mesh(new CylinderGeometry(0.5, 0.32, 0.35, 6, 1), lambert(0xffffff))
  hull.scale.set(1, 1, 2.6)
  hull.position.y = 0.12
  const stripe = new Mesh(new CylinderGeometry(0.505, 0.47, 0.08, 6, 1), lambert(0x2f9bff))
  stripe.scale.set(1, 1, 2.6)
  stripe.position.y = 0.24
  const mast = new Mesh(new CylinderGeometry(0.03, 0.03, 2.6, 4), kit.wood)
  mast.position.y = 1.5
  const shape = new Shape()
  shape.moveTo(0, 0)
  shape.lineTo(0, 2.2)
  shape.lineTo(1.2, 0)
  shape.closePath()
  const s = new Mesh(new ShapeGeometry(shape), new MeshLambertMaterial({ color: sail, side: DoubleSide }))
  s.position.set(0.04, 0.4, 0)
  s.rotation.y = Math.PI / 2
  const jib = new Mesh(new ShapeGeometry(shape), new MeshLambertMaterial({ color: 0xffffff, side: DoubleSide }))
  jib.scale.set(-0.65, 0.85, 1)
  jib.position.set(0.0, 0.4, 0)
  jib.rotation.y = Math.PI / 2
  g.add(hull, stripe, mast, s, jib)
  return g
}

function makeDistantIsland(kit: Kit, rand: () => number, size: number, seaY: number): Group {
  const g = new Group()
  const sand = new Mesh(new CylinderGeometry(size, size * 1.15, 0.6, 12), lambert(SAND_LIT))
  sand.position.y = seaY + 0.1
  sand.scale.z = 0.6
  g.add(sand)
  const hillMats = [lambert(LAND.grass), lambert(LAND.grassShade)]
  const hills = 2 + Math.floor(rand() * 2)
  for (let i = 0; i < hills; i++) {
    const h = size * (0.32 + rand() * 0.25) * (i === 0 ? 1.25 : 0.8)
    const hill = new Mesh(new IcosahedronGeometry(1, 1), hillMats[i % 2])
    hill.scale.set(size * (0.55 + rand() * 0.2), h, size * 0.42)
    hill.position.set((i - (hills - 1) / 2) * size * 0.55 + (rand() - 0.5) * size * 0.2, seaY + 0.3, (rand() - 0.5) * size * 0.2)
    g.add(hill)
  }
  for (let i = 0; i < 2; i++) {
    const p = makePalm(kit, 2.4 + rand(), 0.4, rand() * 6, rand)
    p.position.set((rand() - 0.5) * size * 1.4, seaY + 0.38, size * 0.35)
    p.traverse((o) => (o.castShadow = false))
    g.add(p)
  }
  return g
}

// ---------- sea ----------

/** Sea disc with a vertex-colour ramp: shallow lagoon near the island, deep blue, then haze at the horizon edge. */
function makeSea(radius: number, island: { cx: number; cz: number; rx: number; rz: number }, y: number): Mesh {
  const geo = new RingGeometry(0.01, radius, 64, 22)
  const pos = geo.getAttribute('position')
  const colors = new Float32Array(pos.count * 3)
  const shallow = new Color(SEA.shallow)
  const deep = new Color(SEA.deep)
  const haze = new Color(SKY.haze)
  const c = new Color()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = -pos.getY(i) // ring is built in xy, rotated to xz below
    const e = Math.hypot((x - island.cx) / island.rx, (z - island.cz) / island.rz)
    const d = Math.hypot(x, z) / radius
    const t = Math.min(1, Math.max(0, (e - 1.05) / 0.9))
    c.copy(shallow).lerp(deep, t * t * (3 - 2 * t))
    const h = Math.min(1, Math.max(0, (d - 0.55) / 0.45))
    c.lerp(haze, h * h)
    colors.set([c.r, c.g, c.b], i * 3)
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3))
  geo.rotateX(-Math.PI / 2)
  const sea = new Mesh(geo, new MeshBasicMaterial({ vertexColors: true }))
  sea.position.y = y
  sea.receiveShadow = false
  return sea
}

function makeGlintTexture(): CanvasTexture {
  const [c, g] = canvas(256, 256)
  if (g) {
    const r = rng(7)
    g.fillStyle = 'rgba(255,255,255,0.95)'
    for (let i = 0; i < 70; i++) {
      const x = r() * 256
      const y = r() * 256
      const w = 3 + r() * 9
      g.beginPath()
      g.ellipse(x, y, w, 1.1 + r() * 0.8, 0, 0, Math.PI * 2)
      g.fill()
    }
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.repeat.set(14, 14)
  return tex
}

// ---------- backdrop ----------

/**
 * The tropical resort around a play area: sea to the horizon, sand island, grass, palms, distant islands,
 * clouds, umbrellas, deck chairs and a sailboat. All props stay outside `exclude` (plus a margin).
 * Animated bits register a tick in userData; BrightEnvironment.update() drives them.
 */
export function buildIslandBackdrop(opts: BackdropOptions = {}): Group {
  const ex = opts.exclude ?? { halfWidth: 3, near: 1, far: -6 }
  const groundY = opts.groundY ?? -0.02
  const seaY = groundY - 0.22
  const kit = makeKit()
  const rand = rng(1234)
  const root = new Group()
  root.name = 'bright-island'

  const island = {
    cx: 0,
    cz: (ex.near + ex.far) / 2 - 2,
    rx: ex.halfWidth + 12,
    rz: (ex.near - ex.far) / 2 + 11,
  }
  const inExclude = (x: number, z: number, m: number): boolean =>
    Math.abs(x) < ex.halfWidth + m && z < ex.near + m && z > ex.far - m

  // Sand island: low-poly faceted disc, sloping into the water.
  const sandGeo = new CylinderGeometry(1, 1.1, 1, 36, 1)
  const sandMat = new MeshLambertMaterial({ color: SAND_LIT })
  const sand = new Mesh(sandGeo, sandMat)
  sand.scale.set(island.rx, 0.8, island.rz)
  sand.position.set(island.cx, groundY - 0.4, island.cz)
  root.add(shadowed(sand, false, true))
  // A darker wet-sand band at the waterline.
  const wet = new Mesh(new CylinderGeometry(1.1, 1.16, 1, 36, 1, true), lambert(LAND.sandShade, false))
  wet.scale.set(island.rx, 0.4, island.rz)
  wet.position.set(island.cx, seaY - 0.05, island.cz)
  root.add(wet)

  // Foam ring hugging the shore.
  const foam = new Mesh(
    new RingGeometry(1.08, 1.17, 48, 1),
    new MeshBasicMaterial({ color: SEA.foam, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
  )
  foam.rotation.x = -Math.PI / 2
  foam.scale.set(island.rx, island.rz, 1)
  foam.position.set(island.cx, seaY + 0.02, island.cz)
  root.add(foam)

  // Sea and sparkles.
  const sea = makeSea(58, island, seaY)
  root.add(sea)
  const glintTex = makeGlintTexture()
  const glintMat = new MeshBasicMaterial({
    map: glintTex,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  })
  const glints = new Mesh(new CircleGeometry(40, 32), glintMat)
  glints.rotation.x = -Math.PI / 2
  glints.position.y = seaY + 0.03
  root.add(glints)

  // Grass patches and bushes on the island, outside the play area.
  const grassMat = lambert(LAND.grass)
  const grassShadeMat = lambert(LAND.grassShade)
  const patchGeo = new CylinderGeometry(1, 1.05, 0.12, 9, 1)
  const bushGeo = new IcosahedronGeometry(0.5, 0)
  const rockGeo = new DodecahedronGeometry(0.45, 0)
  const rockMat = lambert(LAND.rock)
  const patchSpots: Array<[number, number, number]> = [
    [-(ex.halfWidth + 4.5), ex.far - 3.5, 3.2],
    [ex.halfWidth + 5, ex.far - 2, 3.6],
    [-(ex.halfWidth + 7), ex.near - 1, 2.8],
    [ex.halfWidth + 6.5, ex.near + 1, 2.6],
    [2.5, ex.far - 6.5, 2.4],
  ]
  for (const [x, z, r] of patchSpots) {
    if (inExclude(x, z, r * 0.5)) continue
    const patch = new Mesh(patchGeo, grassMat)
    patch.scale.set(r, 1, r * 0.7)
    patch.rotation.y = rand() * Math.PI
    patch.position.set(x, groundY + 0.03, z)
    root.add(shadowed(patch, false, true))
    for (let i = 0; i < 3; i++) {
      const b = new Mesh(bushGeo, i % 2 ? grassMat : grassShadeMat)
      const s = 0.6 + rand() * 0.7
      b.scale.set(s, s * 0.75, s)
      b.position.set(x + (rand() - 0.5) * r * 1.2, groundY + 0.2 * s, z + (rand() - 0.5) * r * 0.8)
      root.add(shadowed(b, true, true))
    }
  }
  for (let i = 0; i < 7; i++) {
    const ang = rand() * Math.PI * 2
    const x = island.cx + Math.cos(ang) * island.rx * 1.02
    const z = island.cz + Math.sin(ang) * island.rz * 1.02
    const rock = new Mesh(rockGeo, rockMat)
    const s = 0.6 + rand() * 1.1
    rock.scale.set(s, s * 0.7, s)
    rock.rotation.set(rand(), rand() * 3, 0)
    rock.position.set(x, seaY + 0.1, z)
    root.add(rock)
  }

  // Palms: framed left, right and behind the play area.
  const hw = ex.halfWidth
  const palmSpots: Array<[number, number, number]> = [
    [-(hw + 2.2), ex.far - 2.4, 6.2],
    [hw + 2.8, ex.far - 1.2, 5.6],
    [-(hw * 0.4 + 1.5), ex.far - 4.2, 5.2],
    [hw * 0.55 + 2, ex.far - 5.2, 6.6],
    [-(hw + 5), ex.far + 1.5, 5.0],
    [hw + 5.5, ex.far * 0.35, 5.8],
    [-(hw + 3.5), ex.near + 2.5, 5.4],
    [hw + 3, ex.near + 3.5, 5.0],
  ]
  for (const [x, z, h] of palmSpots) {
    if (inExclude(x, z, 1)) continue
    // Lean away from the play area centre.
    const yaw = -Math.atan2(z - (ex.near + ex.far) / 2, x)
    const palm = makePalm(kit, h, 0.35 + rand() * 0.25, yaw, rand)
    palm.position.set(x, groundY, z)
    root.add(palm)
  }

  // Umbrellas and deck chairs on the beach.
  const props: Array<[number, number, number, number]> = [
    [-(hw + 3.6), ex.far - 0.2, OUTFIT[0], OUTFIT[3]],
    [hw + 3.4, ex.far + 2.0, OUTFIT[1], 0xffffff],
    [hw * 0.2 + 5.5, ex.far - 7.5, OUTFIT[4], OUTFIT[3]],
  ]
  props.forEach(([x, z, a, b], i) => {
    if (inExclude(x, z, 1)) return
    const u = makeUmbrella(kit, a, b)
    u.position.set(x, groundY, z)
    u.rotation.z = (i % 2 ? 1 : -1) * 0.08
    root.add(u)
    for (const dx of [-0.45, 0.45]) {
      const chair = makeDeckChair(kit, i % 2 ? OUTFIT[2] : OUTFIT[5])
      chair.position.set(x + dx, groundY, z + 1.1)
      chair.rotation.y = Math.PI + (x > 0 ? 0.5 : -0.5)
      root.add(chair)
    }
  })

  // Distant islands with green hills.
  const far: Array<[number, number, number]> = [
    [-26, -38, 7],
    [21, -44, 9],
    [43, -18, 6],
    [-44, -8, 5],
    [6, 46, 8],
  ]
  for (const [x, z, s] of far) {
    const isle = makeDistantIsland(kit, rand, s, seaY)
    isle.position.set(x, 0, z)
    isle.rotation.y = rand() * 0.6 - 0.3
    root.add(isle)
  }

  // Sailboats bobbing.
  const boats = [makeSailboat(kit, OUTFIT[0]), makeSailboat(kit, OUTFIT[3])]
  boats[0].position.set(13, seaY, -30)
  boats[0].rotation.y = 0.7
  boats[1].position.set(-17, seaY, -27)
  boats[1].rotation.y = -0.5
  boats[1].scale.setScalar(0.8)
  root.add(...boats)

  // Clouds.
  const clouds: Group[] = []
  const cloudSpots: Array<[number, number, number, number]> = [
    [-24, 15, -42, 2.2],
    [-6, 19, -48, 2.8],
    [14, 13, -40, 2.0],
    [30, 17, -34, 2.4],
    [-36, 12, -26, 1.8],
    [5, 9, -50, 1.6],
    [-14, 16, 38, 2.4],
    [24, 14, 32, 2.0],
  ]
  for (const [x, y, z, s] of cloudSpots) {
    const c = makeCloud(kit, rand, s)
    c.position.set(x, y, z)
    c.rotation.y = rand() * 0.5
    clouds.push(c)
    root.add(c)
  }

  const boatBase = boats.map((b) => b.position.clone())
  const tick: Tick = (dt, t) => {
    for (const c of clouds) {
      c.position.x += dt * 0.35
      if (c.position.x > 38) c.position.x = -38
    }
    glintTex.offset.x = (glintTex.offset.x + dt * 0.012) % 1
    glintTex.offset.y = (glintTex.offset.y + dt * 0.007) % 1
    glintMat.opacity = 0.3 + Math.sin(t * 1.7) * 0.08
    boats.forEach((b, i) => {
      b.position.y = boatBase[i].y + Math.sin(t * 1.3 + i * 2) * 0.06
      b.rotation.z = Math.sin(t * 1.1 + i) * 0.05
    })
  }
  root.userData[TICK_KEY] = tick
  return root
}

/** Dispose every geometry, material and texture under a backdrop or arena group. */
export function disposeWorld(root: Object3D): void {
  const geos = new Set<BufferGeometry>()
  const mats = new Set<Material>()
  root.traverse((o) => {
    if (o instanceof Mesh) {
      geos.add(o.geometry as BufferGeometry)
      const m = o.material as Material | Material[]
      for (const mm of Array.isArray(m) ? m : [m]) mats.add(mm)
    }
  })
  for (const g of geos) g.dispose()
  for (const m of mats) {
    const map = (m as MeshBasicMaterial).map
    if (map) map.dispose()
    m.dispose()
  }
}

/** Shared material helper for arena pieces (exported so arena.ts stays consistent). */
export const brightMat = (color: number, flat = false): MeshStandardMaterial =>
  new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: flat })
