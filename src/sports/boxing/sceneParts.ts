// Mesh builders for the boxing scene. Original low-poly art: arena, neon gloves, cyber-drone, pooled sparks.
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DynamicDrawUsage,
  EdgesGeometry,
  GridHelper,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { Texture } from 'three'
import type { Hand } from '../../pose/types.ts'
import { isBright } from '../../theme/index.ts'
import { BOXING as BRIGHT_COLORS } from '../../theme/bright/palette.ts'

const NEON_COLORS = {
  bg: 0x07080c,
  left: 0x38c8ff,
  right: 0xff5a1f,
  drone: 0xa47bff,
  droneCore: 0xe2d4ff,
  telegraph: 0xff2a3d,
  counter: 0xffc83a,
} as const

/** Scene colours for the active theme (bright is the default, ?theme=neon is the original look). */
export const COLORS: { readonly [K in keyof typeof NEON_COLORS]: number } = isBright() ? BRIGHT_COLORS : NEON_COLORS

/**
 * Drone layout in metres. The chest centre floats at (0, y, z); the head sits headY above it.
 * pod*, orbZ and ring* are the rest offsets the scene animates from; restY is the chest height lying on the floor.
 */
export const DRONE = {
  y: 1.0,
  z: -2.1,
  headY: 0.52,
  headRadius: 0.2,
  chestRadius: 0.26,
  podX: 0.5,
  podY: 0.04,
  podZ: 0.02,
  orbZ: 0.24,
  ringY: 0.22,
  ringZ: 0.1,
  restY: 0.27,
} as const

/** Resting opacity of the faint holo spheres that mark the hit zones. */
export const HALO_OPACITY = 0.07

/** A colour pushed above 1 so it crosses the bloom threshold. On low quality it just clips. */
export const hdr = (hex: number, k: number): Color => new Color(hex).multiplyScalar(isBright() ? 1 : k) // no bloom in bright: keep colours in range

/** Neon colours the scene animates from. Copy them, never mutate them. */
export const NEON = {
  accent: hdr(COLORS.drone, 2.2),
  core: hdr(COLORS.droneCore, 1.5),
  telegraph: hdr(COLORS.telegraph, 3),
  white: hdr(0xffffff, 1.8),
} as const

function radialTexture(stops: ReadonlyArray<readonly [number, string]>): CanvasTexture {
  const size = 128
  const half = size / 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half)
    for (const [at, color] of stops) gradient.addColorStop(at, color)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, size, size)
  }
  return new CanvasTexture(canvas)
}

/** Soft round dot for sparks and floor glows. */
export const createGlowTexture = (): CanvasTexture =>
  radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.3, 'rgba(255,255,255,0.7)'],
    [1, 'rgba(255,255,255,0)'],
  ])

/** Clear centre, solid edges. Tinted red for the took-a-hit vignette. */
export const createVignetteTexture = (): CanvasTexture =>
  radialTexture([
    [0.55, 'rgba(255,255,255,0)'],
    [1, 'rgba(255,255,255,1)'],
  ])

const additive = (color: number, opacity: number): MeshBasicMaterial =>
  new MeshBasicMaterial({ color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false })

/** Dark faceted armour. polygonOffset keeps the neon edge lines on top without z-fighting. */
const armour = (): MeshStandardMaterial =>
  new MeshStandardMaterial({
    color: 0x1d2132,
    roughness: 0.42,
    metalness: 0.35,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })

// ---------- arena ----------

const RING = { halfWidth: 2.3, near: 0.9, far: -5.3, ropes: [0.45, 0.85, 1.25] } as const

export function buildArena(): Group {
  const arena = new Group()

  const floor = new Mesh(new PlaneGeometry(40, 40), new MeshStandardMaterial({ color: 0x0a0c13, roughness: 0.95 }))
  floor.rotation.x = -Math.PI / 2
  const grid = new GridHelper(40, 80, 0x3a4f8f, 0x1c2540)
  grid.position.y = 0.003
  grid.material.transparent = true
  grid.material.opacity = 0.75
  arena.add(floor, grid)

  // Neon ropes on three sides (the fourth is behind the camera), brighter toward the top.
  const { halfWidth: hw, near, far } = RING
  const sideGeo = new BoxGeometry(0.03, 0.03, near - far)
  const backGeo = new BoxGeometry(hw * 2, 0.03, 0.03)
  RING.ropes.forEach((y, i) => {
    const mat = new MeshBasicMaterial({ color: hdr(0x6f88f0, [1, 1.5, 2.4][i]) })
    for (const x of [-hw, hw]) {
      const rope = new Mesh(sideGeo, mat)
      rope.position.set(x, y, (near + far) / 2)
      arena.add(rope)
    }
    const back = new Mesh(backGeo, mat)
    back.position.set(0, y, far)
    arena.add(back)
  })

  // Far corner posts with glowing pads: cyan on the player's left, orange on the right.
  const postMat = armour()
  const postGeo = new BoxGeometry(0.12, 1.45, 0.12)
  const padGeo = new BoxGeometry(0.16, 0.95, 0.16)
  for (const [x, color] of [
    [-hw, COLORS.left],
    [hw, COLORS.right],
  ] as const) {
    const post = new Mesh(postGeo, postMat)
    post.position.set(x, 0.725, far)
    const pad = new Mesh(padGeo, new MeshBasicMaterial({ color: hdr(color, 1.9) }))
    pad.position.set(x, 0.85, far)
    arena.add(post, pad)
  }

  // Ring outline on the floor.
  const outline = new BufferGeometry().setFromPoints([
    new Vector3(-hw, 0, near), new Vector3(-hw, 0, far),
    new Vector3(-hw, 0, far), new Vector3(hw, 0, far),
    new Vector3(hw, 0, far), new Vector3(hw, 0, near),
  ])
  const outlineLines = new LineSegments(outline, new LineBasicMaterial({ color: 0x4a62b0 }))
  outlineLines.position.y = 0.006
  arena.add(outlineLines)

  // Broadcast light frame on the far wall.
  const frameMat = new MeshBasicMaterial({ color: 0x30285c })
  const frameZ = -8.5
  for (const [x, y, w, h] of [
    [0, 4.2, 9.2, 0.06],
    [-4.6, 2.1, 0.06, 4.2],
    [4.6, 2.1, 0.06, 4.2],
    [0, 3.7, 7.6, 0.03],
  ] as const) {
    const bar = new Mesh(new BoxGeometry(w, h, 0.04), frameMat)
    bar.position.set(x, y, frameZ)
    arena.add(bar)
  }
  return arena
}

// ---------- gloves ----------

export interface GloveParts {
  group: Group
  /** Faceted shell: emissiveIntensity rises with guard and punches. */
  shell: MeshStandardMaterial
  /** Additive glow shell around the fist. */
  glow: MeshBasicMaterial
}

/** First-person neon glove. Knuckles face -z, the cuff points back toward the camera (+z). */
export function buildGlove(hand: Hand): GloveParts {
  const color = new Color(hand === 'left' ? COLORS.left : COLORS.right)
  const trimColor = color.clone().lerp(new Color(0xffffff), 0.55)
  /** +1 when +x points toward the body midline (true for the left glove). */
  const inward = hand === 'left' ? 1 : -1

  const shell = new MeshStandardMaterial({
    color: color.clone().multiplyScalar(0.45),
    emissive: color,
    emissiveIntensity: 0.5,
    roughness: 0.35,
    metalness: 0.2,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
  // Neon trim: the facet lines and cuff band carry the bloom glow.
  const neonTrim = trimColor.clone().multiplyScalar(1.3)
  const trim = new MeshBasicMaterial({ color: neonTrim })
  const glow = new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.08,
    blending: AdditiveBlending,
    depthWrite: false,
    side: BackSide,
  })

  const fistGeo = new IcosahedronGeometry(0.085, 1)
  const fist = new Mesh(fistGeo, shell)
  fist.scale.set(1, 0.88, 1.15)
  const facets = new LineSegments(
    new EdgesGeometry(fistGeo, 1),
    new LineBasicMaterial({ color: neonTrim, transparent: true, opacity: 0.6 }),
  )
  facets.scale.copy(fist.scale)

  const thumb = new Mesh(new IcosahedronGeometry(0.034, 0), shell)
  thumb.position.set(inward * 0.068, 0.018, -0.03)
  thumb.scale.set(0.9, 1, 1.5)

  const cuffMat = new MeshStandardMaterial({
    color: color.clone().multiplyScalar(0.25),
    emissive: color.clone().multiplyScalar(0.12),
    roughness: 0.5,
    flatShading: true,
  })
  const cuff = new Mesh(new CylinderGeometry(0.056, 0.062, 0.06, 8), cuffMat)
  cuff.rotation.x = Math.PI / 2
  cuff.position.z = 0.1
  const band = new Mesh(new TorusGeometry(0.062, 0.008, 6, 20), trim)
  band.position.z = 0.078

  const halo = new Mesh(new IcosahedronGeometry(0.11, 2), glow)
  halo.scale.copy(fist.scale)

  const model = new Group()
  model.add(fist, facets, thumb, cuff, band, halo)
  model.scale.setScalar(0.68)
  const group = new Group()
  group.add(model)
  return { group, shell, glow }
}

// ---------- drone ----------

export interface DroneHitPart {
  /** Hit sphere centre in drone body space, metres. */
  center: Vector3
  /** Visual hit sphere radius, metres. */
  radius: number
  /** Armour that flashes white on a hit. */
  shell: MeshStandardMaterial
  /** Faint holo sphere that marks the zone. */
  halo: MeshBasicMaterial
  /** Glowing core (chest orb or visor), tinted red while charging. */
  core: MeshBasicMaterial
}

export interface DroneParts {
  /** Position: hover, lunge, knockback. */
  root: Group
  /** Rotation: sway, tilt, KO tumble. */
  body: Group
  head: DroneHitPart
  chest: DroneHitPart
  /** Neon edge lines on the armour, and the solid neon trim (neck ring, pod tips). */
  accent: LineBasicMaterial
  accentSolid: MeshBasicMaterial
  /** Chest reactor orb: pulls back into the hull while a straight attack charges. */
  orb: Mesh
  neckRing: Mesh
  /** [left, right]. */
  pods: Group[]
  thruster: Mesh<ConeGeometry, MeshBasicMaterial>
  /** Lives in the scene, not in root, so it stays on the floor. */
  floorGlow: Mesh<PlaneGeometry, MeshBasicMaterial>
  /** Charging ring (grows) and the static guide ring it grows into. */
  telegraph: Mesh<TorusGeometry, MeshBasicMaterial>
  telegraphGuide: Mesh<TorusGeometry, MeshBasicMaterial>
}

/** Sparring drone: faceted gem core, arc visor, crest fin, side pods, ion thruster. */
export function buildDrone(glowMap: Texture): DroneParts {
  const root = new Group()
  root.position.set(0, DRONE.y, DRONE.z)
  const body = new Group()
  root.add(body)
  const accent = new LineBasicMaterial({ color: NEON.accent, transparent: true, opacity: 0.9 })
  const accentSolid = new MeshBasicMaterial({ color: NEON.accent })

  // Chest: faceted core with a reactor orb and a holo hit sphere.
  const chestShell = armour()
  const coreGeo = new IcosahedronGeometry(0.3, 0)
  const core = new Mesh(coreGeo, chestShell)
  core.scale.set(1.15, 1.2, 0.85)
  const coreEdges = new LineSegments(new EdgesGeometry(coreGeo), accent)
  coreEdges.scale.copy(core.scale)
  const orbMat = new MeshBasicMaterial({ color: NEON.core })
  const orb = new Mesh(new IcosahedronGeometry(0.09, 1), orbMat)
  orb.position.z = DRONE.orbZ
  const chestHalo = additive(COLORS.drone, HALO_OPACITY)
  const chestCenter = new Vector3(0, 0, 0.12)
  const chestSphere = new Mesh(new SphereGeometry(DRONE.chestRadius, 20, 14), chestHalo)
  chestSphere.position.copy(chestCenter)
  body.add(core, coreEdges, orb, chestSphere)

  // Neck: a floating ring between the segments.
  const neckRing = new Mesh(new TorusGeometry(0.1, 0.014, 6, 24), accentSolid)
  neckRing.rotation.x = Math.PI / 2
  neckRing.position.y = 0.335
  body.add(neckRing)

  // Head: faceted helmet, arc visor wrapped around the front, crest fin, holo hit sphere.
  const headShell = armour()
  const head = new Group()
  head.position.y = DRONE.headY
  const headGeo = new DodecahedronGeometry(0.17, 0)
  const helmet = new Mesh(headGeo, headShell)
  helmet.scale.set(1.2, 0.95, 1)
  const helmetEdges = new LineSegments(new EdgesGeometry(headGeo), accent)
  helmetEdges.scale.copy(helmet.scale)
  const visorMat = new MeshBasicMaterial({ color: NEON.core })
  const visorGeo = new TorusGeometry(0.19, 0.022, 4, 20, 2)
  visorGeo.rotateZ(Math.PI / 2 - 1) // centre the 2 rad arc on +y
  visorGeo.rotateX(Math.PI / 2) // then +y becomes +z (facing the player)
  const visor = new Mesh(visorGeo, visorMat)
  visor.position.y = 0.01
  const crest = new Mesh(new BoxGeometry(0.025, 0.07, 0.2), headShell)
  crest.position.set(0, 0.17, -0.01)
  const headHalo = additive(COLORS.drone, HALO_OPACITY)
  const headCenter = new Vector3(0, DRONE.headY, 0.04)
  const headSphere = new Mesh(new SphereGeometry(DRONE.headRadius, 18, 12), headHalo)
  headSphere.position.set(0, 0, headCenter.z)
  head.add(helmet, helmetEdges, visor, crest, headSphere)
  body.add(head)

  // Side pods on short struts.
  const podShell = armour()
  const podGeo = new CapsuleGeometry(0.06, 0.16, 3, 8)
  const tipGeo = new TorusGeometry(0.048, 0.012, 6, 16)
  const strutGeo = new BoxGeometry(0.12, 0.03, 0.05)
  const pods = [-1, 1].map((side) => {
    const pod = new Group()
    pod.position.set(side * DRONE.podX, DRONE.podY, DRONE.podZ)
    const hull = new Mesh(podGeo, podShell)
    hull.rotation.x = Math.PI / 2
    const tip = new Mesh(tipGeo, accentSolid)
    tip.position.z = 0.15
    const strut = new Mesh(strutGeo, podShell)
    strut.position.x = -side * 0.08
    pod.add(hull, tip, strut)
    body.add(pod)
    return pod
  })

  // Ion thruster under the core.
  const nozzle = new Mesh(new CylinderGeometry(0.07, 0.1, 0.07, 8), podShell)
  nozzle.position.y = -0.3
  const thrusterMat = additive(0x7f6bff, 0.45)
  thrusterMat.color.multiplyScalar(2)
  const thruster = new Mesh(new ConeGeometry(0.09, 0.32, 10, 1, true), thrusterMat)
  thruster.rotation.x = Math.PI
  thruster.position.y = -0.48
  body.add(nozzle, thruster)

  const floorGlow = new Mesh(
    new PlaneGeometry(2, 2),
    new MeshBasicMaterial({
      map: glowMap,
      color: COLORS.drone,
      transparent: true,
      opacity: 0.35,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  )
  floorGlow.rotation.x = -Math.PI / 2
  floorGlow.position.set(0, 0.01, DRONE.z)

  const telegraph = new Mesh(new TorusGeometry(0.8, 0.03, 8, 72), additive(COLORS.telegraph, 0))
  telegraph.material.color.copy(NEON.telegraph)
  const telegraphGuide = new Mesh(new TorusGeometry(0.8, 0.008, 6, 72), additive(COLORS.telegraph, 0))
  for (const ring of [telegraph, telegraphGuide]) {
    ring.position.set(0, DRONE.ringY, DRONE.ringZ)
    ring.visible = false
    root.add(ring)
  }

  return {
    root,
    body,
    head: { center: headCenter, radius: DRONE.headRadius, shell: headShell, halo: headHalo, core: visorMat },
    chest: { center: chestCenter, radius: DRONE.chestRadius, shell: chestShell, halo: chestHalo, core: orbMat },
    accent,
    accentSolid,
    orb,
    neckRing,
    pods,
    thruster,
    floorGlow,
    telegraph,
    telegraphGuide,
  }
}

// ---------- sparks ----------

export interface Sparks {
  readonly points: Points
  /** Scales every burst count (low quality uses fewer sparks). */
  density: number
  /** Spray n sparks from origin. dir biases the spray, speed in m/s, life in seconds. */
  burst(origin: Vector3, n: number, color: Color, speed: number, dir: Vector3, life: number): void
  update(dt: number): void
  clear(): void
}

/** Pooled additive point sparks. Dead sparks are black, which is invisible with additive blending. */
export function createSparks(max: number, size: number, map: Texture): Sparks {
  const positions = new Float32Array(max * 3)
  const colors = new Float32Array(max * 3)
  const base = new Float32Array(max * 3)
  const velocity = new Float32Array(max * 3)
  const life = new Float32Array(max)
  const span = new Float32Array(max)
  const posAttr = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage)
  const colAttr = new BufferAttribute(colors, 3).setUsage(DynamicDrawUsage)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', posAttr)
  geometry.setAttribute('color', colAttr)
  const material = new PointsMaterial({
    size,
    map,
    color: hdr(0xffffff, 1.4), // bright sparks bloom
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  const points = new Points(geometry, material)
  points.frustumCulled = false
  let next = 0
  let active = false

  return {
    points,
    density: 1,
    burst(origin, n, color, speed, dir, lifeS) {
      const count = Math.max(1, Math.round(n * this.density))
      for (let i = 0; i < count; i++) {
        const k = next
        const j = k * 3
        next = (next + 1) % max
        // Random unit vector plus the bias direction.
        const u = Math.random() * 2 - 1
        const a = Math.random() * Math.PI * 2
        const r = Math.sqrt(1 - u * u)
        const s = speed * (0.35 + Math.random() * 0.65)
        velocity[j] = (r * Math.cos(a) + dir.x) * s
        velocity[j + 1] = (u + dir.y) * s
        velocity[j + 2] = (r * Math.sin(a) + dir.z) * s
        positions[j] = origin.x
        positions[j + 1] = origin.y
        positions[j + 2] = origin.z
        const whiten = Math.random() * 0.6
        base[j] = color.r + (1 - color.r) * whiten
        base[j + 1] = color.g + (1 - color.g) * whiten
        base[j + 2] = color.b + (1 - color.b) * whiten
        span[k] = lifeS * (0.6 + Math.random() * 0.8)
        life[k] = span[k]
      }
      active = true
    },
    update(dt) {
      if (!active) return
      let any = false
      const drag = Math.max(0, 1 - 2.2 * dt)
      for (let k = 0; k < max; k++) {
        if (life[k] <= 0) continue
        const j = k * 3
        life[k] -= dt
        if (life[k] <= 0) {
          colors[j] = colors[j + 1] = colors[j + 2] = 0
          continue
        }
        any = true
        velocity[j + 1] -= 5.5 * dt
        for (let c = 0; c < 3; c++) {
          velocity[j + c] *= drag
          positions[j + c] += velocity[j + c] * dt
        }
        const fade = life[k] / span[k]
        colors[j] = base[j] * fade
        colors[j + 1] = base[j + 1] * fade
        colors[j + 2] = base[j + 2] * fade
      }
      posAttr.needsUpdate = true
      colAttr.needsUpdate = true
      active = any
    },
    clear() {
      life.fill(0)
      colors.fill(0)
      colAttr.needsUpdate = true
      active = false
    },
  }
}
