// Mesh builders for the boxing scene. Original low-poly art: arena, neon gloves, cyber-drone, pooled sparks.
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  GridHelper,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  MeshStandardMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { Texture } from 'three'
import type { Hand } from '../../pose/types.ts'
import { isBright } from '../../theme/index.ts'
import { BOXING as BRIGHT_COLORS } from '../../theme/bright/palette.ts'
import { gloveColors, schemeOf } from '../../custom/look.ts'
import type { RobotLook } from '../../custom/look.ts'
import { buildHead } from '../../custom/robot.ts'

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

/** Opponent accent (muted violet) for the neon look. */
const OPPONENT_ACCENT_HEX = 0x8b7cf6

/** Neon colours the scene animates from. Copy them, never mutate them. */
export const NEON = {
  accent: hdr(isBright() ? COLORS.drone : OPPONENT_ACCENT_HEX, 1),
  core: hdr(isBright() ? COLORS.droneCore : 0xf2f2f5, 1),
  telegraph: hdr(COLORS.telegraph, 3),
  white: hdr(0xffffff, 1.5),
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

/** Matte graphite armour: smooth shading, no gloss, so silhouettes and one accent colour do the work. */
const armour = (color = 0x2b2d33): MeshStandardMaterial =>
  new MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.05 })
/** Light matte shell for the opponent's head and chest, so it reads clearly against the dark arena. */
const SHELL_LIGHT = 0xd6d6db
/** The opponent's one accent: a muted violet for visor trim, fists and cuffs. */
const OPPONENT_ACCENT = OPPONENT_ACCENT_HEX

// ---------- arena ----------

/** Ring mat: dark navy weave, a lighter border band, and a centre circle with the game's name. */
function ringCanvasTexture(): CanvasTexture {
  const size = 1024
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#1b1d24'
    ctx.fillRect(0, 0, size, size)
    // Weave: faint crossing threads.
    for (let i = 0; i < size; i += 4) {
      ctx.fillStyle = i % 8 === 0 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.12)'
      ctx.fillRect(i, 0, 2, size)
      ctx.fillRect(0, i, size, 2)
    }
    // Border band.
    ctx.strokeStyle = '#262931'
    ctx.lineWidth = 44
    ctx.strokeRect(22, 22, size - 44, size - 44)
    ctx.strokeStyle = '#3a3e48'
    ctx.lineWidth = 3
    ctx.strokeRect(52, 52, size - 104, size - 104)
    // Centre logo: two rings and the name.
    const mid = size / 2
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(mid, mid, 170, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.14)'
    ctx.font = '600 64px "Geist Sans", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Kinetic Ring', mid, mid)
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  return tex
}

/** Brushed-steel streaks for the corner posts. */
function brushedTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 256
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#c8ccd6'
    ctx.fillRect(0, 0, 64, 256)
    for (let x = 0; x < 64; x++) {
      ctx.fillStyle = `rgba(${x % 3 === 0 ? '255,255,255' : '40,44,60'},${0.08 + ((x * 37) % 11) / 60})`
      ctx.fillRect(x, 0, 1, 256)
    }
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  return tex
}

const RING = { halfWidth: 2.3, near: 0.9, far: -5.3, ropes: [0.45, 0.85, 1.25] } as const

export function buildArena(): Group {
  const arena = new Group()

  const floor = new Mesh(new PlaneGeometry(40, 40), new MeshStandardMaterial({ color: 0x0a0c13, roughness: 0.95 }))
  floor.rotation.x = -Math.PI / 2
  const grid = new GridHelper(40, 80, 0x2a2d36, 0x1a1c22)
  grid.position.y = 0.003
  grid.material.transparent = true
  grid.material.opacity = 0.45
  arena.add(floor, grid)

  // Canvas: woven dark-navy mat with a padded border band and a centre ring logo.
  const { halfWidth: hw, near, far } = RING
  const canvasTex = ringCanvasTexture()
  const canvasMat = new MeshLambertMaterial({ map: canvasTex }) // Lambert: the canvas fills much of the screen
  const canvas = new Mesh(new PlaneGeometry(hw * 2 + 0.5, near - far + 0.5), canvasMat)
  canvas.rotation.x = -Math.PI / 2
  canvas.position.set(0, 0.005, (near + far) / 2)
  arena.add(canvas)
  // Raised apron edge around the canvas with a neon trim line.
  const apronMat = armour()
  const trimMat = new MeshBasicMaterial({ color: 0x3a3e48 })
  const ax = hw + 0.32
  const az0 = near + 0.32
  const az1 = far - 0.32
  for (const [w, d, x, z] of [
    [ax * 2 + 0.12, 0.12, 0, az1],
    [ax * 2 + 0.12, 0.12, 0, az0],
    [0.12, az0 - az1, -ax, (az0 + az1) / 2],
    [0.12, az0 - az1, ax, (az0 + az1) / 2],
  ] as const) {
    const edge = new Mesh(new BoxGeometry(w, 0.08, d), apronMat)
    edge.position.set(x, 0.04, z)
    const trim = new Mesh(new BoxGeometry(w + 0.004, 0.012, d + 0.004), trimMat)
    trim.position.y = 0.03
    edge.add(trim)
    arena.add(edge)
  }

  // Round ropes on three sides (the fourth is behind the camera): off-white, with the top rope in
  // the player's accent. Matte, shaded by the key light, with only a faint emissive lift.
  const ropeTint = [0xd9dbe1, 0xd9dbe1, COLORS.left]
  const sideGeo = new CylinderGeometry(0.024, 0.024, near - far, 10)
  sideGeo.rotateX(Math.PI / 2)
  const backGeo = new CylinderGeometry(0.024, 0.024, hw * 2, 10)
  backGeo.rotateZ(Math.PI / 2)
  const tieGeo = new CylinderGeometry(0.032, 0.032, 0.05, 10)
  const tieMat = new MeshStandardMaterial({ color: 0x3a3e48, roughness: 0.8 })
  RING.ropes.forEach((y, i) => {
    const mat = new MeshStandardMaterial({
      color: ropeTint[i],
      emissive: new Color(ropeTint[i]).multiplyScalar(0.12),
      roughness: 0.75,
      metalness: 0,
    })
    for (const x of [-hw, hw]) {
      const rope = new Mesh(sideGeo, mat)
      rope.position.set(x, y, (near + far) / 2)
      arena.add(rope)
      // Tape ties at the thirds keep the ropes from looking like light bars.
      for (const t of [1 / 3, 2 / 3]) {
        const tie = new Mesh(tieGeo, tieMat)
        tie.rotation.x = Math.PI / 2
        tie.position.set(x, y, near + (far - near) * t)
        arena.add(tie)
      }
    }
    const back = new Mesh(backGeo, mat)
    back.position.set(0, y, far)
    arena.add(back)
  })
  // Rope spacers: vertical straps joining the three ropes at the middle of each side.
  const strapGeo = new BoxGeometry(0.02, RING.ropes[2] - RING.ropes[0] + 0.06, 0.05)
  for (const x of [-hw, hw]) {
    const strap = new Mesh(strapGeo, tieMat)
    strap.position.set(x, (RING.ropes[0] + RING.ropes[2]) / 2, (near + far) / 2)
    arena.add(strap)
  }

  // Four corner posts (brushed steel) with padded turnbuckle covers: cyan and orange at the far
  // corners like the gloves, white at the near ones.
  const steel = new MeshStandardMaterial({ color: 0x9aa3b8, roughness: 0.3, metalness: 0.85, map: brushedTexture() })
  const postGeo = new CylinderGeometry(0.05, 0.06, 1.45, 12)
  const padGeo = new CylinderGeometry(0.1, 0.1, 0.95, 12)
  const capGeo = new SphereGeometry(0.07, 12, 8)
  for (const [x, z, color] of [
    [-hw, far, COLORS.left],
    [hw, far, COLORS.right],
    [-hw, near, 0x3a3e48],
    [hw, near, 0x3a3e48],
  ] as const) {
    const post = new Mesh(postGeo, steel)
    post.position.set(x, 0.725, z)
    const cap = new Mesh(capGeo, steel)
    cap.position.set(x, 1.45, z)
    const pad = new Mesh(
      padGeo,
      new MeshStandardMaterial({ color, emissive: new Color(color).multiplyScalar(0.08), roughness: 0.8 }),
    )
    pad.position.set(x, 0.85, z)
    arena.add(post, cap, pad)
  }

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
export function buildGlove(hand: Hand, robot?: RobotLook): GloveParts {
  const color = new Color(robot ? gloveColors(robot)[hand === 'left' ? 0 : 1] : hand === 'left' ? COLORS.left : COLORS.right)
  const trimColor = color.clone().lerp(new Color(0xffffff), 0.55)
  /** +1 when +x points toward the body midline (true for the left glove). */
  const inward = hand === 'left' ? 1 : -1

  // Matte glove in the hand's colour; a low emissive keeps the guard and punch pulses subtle.
  const shell = new MeshStandardMaterial({
    color: color.clone().multiplyScalar(0.8),
    emissive: color.clone().multiplyScalar(0.3),
    emissiveIntensity: 0.5,
    roughness: 0.7,
    metalness: 0,
  })
  const trim = new MeshBasicMaterial({ color: trimColor })
  const glow = new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.08,
    blending: AdditiveBlending,
    depthWrite: false,
    side: BackSide,
    visible: false, // solid gloves read cleaner than a see-through glow shell
  })

  const fistGeo = new SphereGeometry(0.085, 24, 16)
  const fist = new Mesh(fistGeo, shell)
  fist.scale.set(1, 0.88, 1.15)

  const thumb = new Mesh(new SphereGeometry(0.034, 12, 8), shell)
  thumb.position.set(inward * 0.068, 0.018, -0.03)
  thumb.scale.set(0.9, 1, 1.5)

  const cuffMat = new MeshStandardMaterial({ color: 0xeeeef0, roughness: 0.8 })
  const cuff = new Mesh(new CylinderGeometry(0.056, 0.062, 0.06, 16), cuffMat)
  cuff.rotation.x = Math.PI / 2
  cuff.position.z = 0.1
  const band = new Mesh(new TorusGeometry(0.062, 0.008, 6, 20), trim)
  band.position.z = 0.078

  const halo = new Mesh(new IcosahedronGeometry(0.11, 2), glow)
  halo.scale.copy(fist.scale)

  const model = new Group()
  model.add(fist, thumb, cuff, band, halo)
  model.scale.setScalar(1.2) // oversized, cartoon proportions to match the big heads
  const group = new Group()
  group.add(model)
  return { group, shell, glow }
}

// ---------- player body ----------

/**
 * The player's own robot for the over-the-shoulder camera, built around the rig origin (the eyes).
 * Solid armour with neon edges: helmet with a cyan visor, neck, shoulders and a short torso. The
 * gloves float in front on their own, so the body has no arms. Faces -z, toward the opponent.
 */
export function buildPlayerBody(_hands: readonly Object3D[] = [], robot?: RobotLook): Group {
  const body = new Group()
  const shell = armour()
  const scheme = robot ? schemeOf(robot) : null
  if (scheme) shell.color.setHex(scheme.armour)
  const edge = new LineBasicMaterial({ color: scheme?.accent ?? COLORS.left, transparent: true, opacity: 0.55 })
  const visorMat = new MeshBasicMaterial({ color: scheme?.accent ?? COLORS.left })
  // No outline wireframes: clean matte shapes read better than neon edges.
  const withEdges = (mesh: Mesh, _geo?: BufferGeometry): Mesh => mesh

  // Bobblehead helmet seen from behind: big rounded shell, a cyan stripe down the back, crest.
  const helmet = withEdges(new Mesh(new SphereGeometry(0.115, 32, 20), shell))
  helmet.scale.set(1.12, 1, 1.05)
  helmet.position.set(0, -0.13, 0.08)
  const stripe = new Mesh(new BoxGeometry(0.025, 0.16, 0.02), visorMat)
  stripe.position.set(0, 0.02, 0.115)
  stripe.rotation.x = -0.35
  helmet.add(stripe)
  const crest = withEdges(new Mesh(new BoxGeometry(0.022, 0.05, 0.16), shell))
  crest.position.set(0, 0.12, 0.01)
  helmet.add(crest)
  // A customised head style replaces the default helmet (face toward -z, the opponent).
  const head =
    robot && robot.head !== 'visor' ? buildHead(robot.head, { shell, edge, visor: visorMat }, 0.115, -1) : helmet
  head.position.copy(helmet.position)

  const neck = new Mesh(new CylinderGeometry(0.04, 0.05, 0.1, 8), shell)
  neck.position.set(0, -0.25, 0.08)
  const torso = withEdges(new Mesh(new CylinderGeometry(0.19, 0.13, 0.32, 20), shell))
  torso.scale.z = 0.6
  torso.position.set(0, -0.45, 0.1)
  const chestLight = new Mesh(new BoxGeometry(0.12, 0.02, 0.01), visorMat)
  chestLight.position.set(0, 0.07, -0.17)
  torso.add(chestLight)
  body.add(head, neck, torso)
  // No arms: the gloves float free of the body, casual-sports style.
  for (const side of [-1, 1]) {
    const shoulder = withEdges(new Mesh(new SphereGeometry(0.08, 16, 10), shell))
    shoulder.position.set(side * 0.22, -0.3, 0.1)
    body.add(shoulder)
  }
  return body
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
  /** The whole head as one group in body space, so a KO can knock it off. */
  headRoot: Group
  head: DroneHitPart
  chest: DroneHitPart
  /** Neon edge lines on the armour, and the solid neon trim (neck ring, pod tips). */
  accent: LineBasicMaterial
  accentSolid: MeshBasicMaterial
  /** Helmet, visor, crest and ears inside headRoot (not the hit sphere), so a 1v1 friend's head style can replace them. */
  headModel?: Group
  /** Armour materials (chest, head, limbs) and the glowing fist shell, for recolouring a 1v1 opponent. */
  armour?: MeshStandardMaterial[]
  fistShell?: MeshStandardMaterial
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

/** Arm or leg segment from a to b (body space): a unit-height cylinder stretched and turned in place. */
const UP = new Vector3(0, 1, 0)
const span = new Vector3()
function stretch(limb: Mesh, a: Vector3, b: Vector3): void {
  span.copy(b).sub(a)
  const len = Math.max(0.02, span.length())
  limb.position.copy(a).addScaledVector(span, 0.5)
  limb.quaternion.setFromUnitVectors(UP, span.multiplyScalar(1 / len))
  limb.scale.set(1, len, 1)
}

/**
 * Bobblehead sparring robot: small faceted torso, oversized helmet head with a wide visor, fists
 * (the pods) floating free of the body with no arms, and short legs standing on the floor. The head is its own
 * group (headRoot) so it can be knocked off on a KO. Hit spheres keep the old layout, so hit rates hold.
 */
export function buildDrone(glowMap: Texture): DroneParts {
  const root = new Group()
  root.position.set(0, DRONE.y, DRONE.z)
  const body = new Group()
  root.add(body)
  const accent = new LineBasicMaterial({ color: NEON.accent, transparent: true, opacity: 0.6 })
  const accentSolid = new MeshBasicMaterial({ color: NEON.accent })
  const limbShell = armour()
  // Oversized matte gloves in the one accent colour, so punches read from across the ring.
  const fistShell = new MeshStandardMaterial({
    color: OPPONENT_ACCENT,
    emissive: new Color(OPPONENT_ACCENT).multiplyScalar(0.12),
    roughness: 0.7,
  })
  const edged = (mesh: Mesh): Mesh => mesh // clean shapes, no outline wireframe

  // Chest: tapered six-sided torso with a reactor orb and the chest hit sphere.
  const chestShell = armour(SHELL_LIGHT)
  const torso = edged(new Mesh(new CylinderGeometry(0.27, 0.18, 0.44, 24), chestShell))
  torso.scale.z = 0.72
  torso.position.y = 0.02
  const orbMat = new MeshBasicMaterial({ color: NEON.core })
  const orb = new Mesh(new IcosahedronGeometry(0.075, 1), orbMat)
  orb.position.z = DRONE.orbZ
  const chestHalo = additive(COLORS.drone, HALO_OPACITY)
  chestHalo.visible = false // the robot reads solid: no see-through holo bubbles
  const chestCenter = new Vector3(0, 0, 0.12)
  const chestSphere = new Mesh(new SphereGeometry(DRONE.chestRadius, 12, 8), chestHalo)
  chestSphere.position.copy(chestCenter)
  const belt = new Mesh(new CylinderGeometry(0.185, 0.185, 0.05, 24), accentSolid)
  belt.scale.z = 0.74
  belt.position.y = -0.2
  body.add(torso, orb, chestSphere, belt)

  // Shoulder pads.
  const shoulderGeo = new SphereGeometry(0.1, 20, 12)
  for (const side of [-1, 1]) {
    const pad = edged(new Mesh(shoulderGeo, limbShell))
    pad.position.set(side * 0.31, 0.17, 0)
    pad.scale.set(1.1, 0.85, 1)
    body.add(pad)
  }

  // Short neck with the spinning ring.
  const neck = new Mesh(new CylinderGeometry(0.05, 0.07, 0.12, 8), limbShell)
  neck.position.y = 0.27
  const neckRing = new Mesh(new TorusGeometry(0.085, 0.014, 6, 24), accentSolid)
  neckRing.rotation.x = Math.PI / 2
  neckRing.position.y = 0.27
  body.add(neck, neckRing)

  // Big bobblehead: faceted helmet, wide visor band facing the player, crest and antenna ears.
  const headShell = armour(SHELL_LIGHT)
  const head = new Group()
  head.position.y = DRONE.headY
  const headGeo = new SphereGeometry(0.25, 40, 28)
  const helmet = new Mesh(headGeo, headShell)
  helmet.scale.set(1.12, 1, 1)
  const visorMat = new MeshBasicMaterial({ color: NEON.core })
  const visorGeo = new TorusGeometry(0.255, 0.035, 8, 40, 2.2)
  visorGeo.rotateZ(Math.PI / 2 - 1.1) // centre the arc on +y
  visorGeo.rotateX(Math.PI / 2) // then +y becomes +z (facing the player)
  const visor = new Mesh(visorGeo, visorMat)
  visor.scale.set(1.15, 1, 1)
  visor.position.y = 0.01
  const crest = new Mesh(new BoxGeometry(0.03, 0.06, 0.22), limbShell)
  crest.position.set(0, 0.25, -0.02)
  const headModel = new Group()
  head.add(headModel)
  headModel.add(helmet, visor, crest)
  for (const side of [-1, 1]) {
    const ear = new Mesh(new CylinderGeometry(0.05, 0.05, 0.05, 16), limbShell)
    ear.rotation.z = Math.PI / 2
    ear.position.set(side * 0.29, 0, 0)
    const tip = new Mesh(new BoxGeometry(0.015, 0.1, 0.015), accentSolid)
    tip.position.set(side * 0.3, 0.08, 0)
    headModel.add(ear, tip)
  }
  const headHalo = additive(COLORS.drone, HALO_OPACITY)
  headHalo.visible = false
  const headCenter = new Vector3(0, DRONE.headY, 0.04)
  const headSphere = new Mesh(new SphereGeometry(DRONE.headRadius, 12, 8), headHalo)
  headSphere.position.set(0, 0, headCenter.z)
  head.add(headSphere)
  body.add(head)

  // Fists (the pods): chunky faceted gloves with a neon wrist cuff, knuckles toward the player.
  const fistGeo = new SphereGeometry(0.16, 28, 18)
  const cuffGeo = new CylinderGeometry(0.09, 0.1, 0.07, 20)
  cuffGeo.rotateX(Math.PI / 2)
  const cuffMat = new MeshStandardMaterial({ color: 0xeeeef0, roughness: 0.8 })
  const pods = [-1, 1].map((side) => {
    const pod = new Group()
    pod.position.set(side * DRONE.podX, DRONE.podY, DRONE.podZ)
    const fist = edged(new Mesh(fistGeo, fistShell))
    fist.scale.set(1, 0.9, 1.1)
    fist.position.z = 0.05
    const cuff = new Mesh(cuffGeo, cuffMat)
    cuff.position.z = -0.12
    pod.add(fist, cuff)
    body.add(pod) // no arm: the fists float free of the body
    return pod
  })

  // Hips and legs, standing on the floor (body origin sits DRONE.y above it).
  const hips = edged(new Mesh(new BoxGeometry(0.26, 0.12, 0.16), limbShell))
  hips.position.y = -0.3
  body.add(hips)
  const legGeo = new CylinderGeometry(0.075, 0.06, 1, 16)
  const kneeGeo = new SphereGeometry(0.08, 16, 10)
  const footGeo = new BoxGeometry(0.13, 0.07, 0.22)
  for (const side of [-1, 1]) {
    const hip = new Vector3(side * 0.1, -0.34, 0)
    const knee = new Vector3(side * 0.13, -0.66, 0.05)
    const ankle = new Vector3(side * 0.13, -DRONE.y + 0.08, -0.01)
    const thigh = new Mesh(legGeo, limbShell)
    stretch(thigh, hip, knee)
    const shin = new Mesh(legGeo, limbShell)
    stretch(shin, knee, ankle)
    const kneePad = edged(new Mesh(kneeGeo, limbShell))
    kneePad.position.copy(knee)
    const foot = edged(new Mesh(footGeo, limbShell))
    foot.position.set(ankle.x, ankle.y - 0.05, ankle.z + 0.04)
    body.add(thigh, shin, kneePad, foot)
  }

  // Small back thruster (kept for the hover flicker), tucked behind the torso.
  const nozzle = new Mesh(new CylinderGeometry(0.05, 0.07, 0.08, 8), limbShell)
  nozzle.position.set(0, -0.1, -0.2)
  const thrusterMat = additive(0x7f6bff, 0.45)
  thrusterMat.color.multiplyScalar(2)
  const thruster = new Mesh(new ConeGeometry(0.06, 0.22, 8, 1, true), thrusterMat)
  thruster.rotation.x = Math.PI
  thruster.position.set(0, -0.24, -0.2)
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
    headRoot: head,
    head: { center: headCenter, radius: DRONE.headRadius, shell: headShell, halo: headHalo, core: visorMat },
    chest: { center: chestCenter, radius: DRONE.chestRadius, shell: chestShell, halo: chestHalo, core: orbMat },
    accent,
    accentSolid,
    headModel,
    armour: [chestShell, headShell, limbShell],
    fistShell,
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
