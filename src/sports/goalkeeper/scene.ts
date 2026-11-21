// Reflex Keeper: Three.js scene. Original retro-neon art built from primitives only.
// World frame and zones: see ./types.ts. Camera sits behind the keeper (z > 0) looking toward -z.

import * as THREE from 'three'
import type {
  KeeperPart,
  KeeperPose,
  KeeperScene,
  StrikerPhase,
  StrikerTell,
  Vec3,
  Zone,
} from './types.ts'

// ---------- local constants (mirror physics.ts values; not imported on purpose) ----------
const GOAL_HALF_WIDTH = 3.66
const GOAL_HEIGHT = 2.44
const GOAL_Z = 0
const PENALTY_Z = -11
const BALL_RADIUS = 0.11
const GLOVE_RADIUS = 0.38
const GLOVE_VISUAL = 0.2
const TORSO_RADIUS = 0.28

// ---------- palette ----------
const BG = 0x0b0c0f
const CYAN = 0x22e6ff
const MAGENTA = 0xff3fd0
const AMBER = 0xffb23a
const SAVE_GREEN = 0x3dffb0
const RED = 0xff2a55
const FRAME = 0xe9f7ff
const LINE = 0xcfe8ff

// ---------- camera ----------
const CAM_FOV = 50
const CAM_Y = 2.2
/** Half width at the goal plane that must stay on screen (posts at 3.66 plus glove reach margin). */
const FIT_HALF_WIDTH = 4.3
const CAM_MIN_D = 4.4
const CAM_MAX_D = 10.5

// ---------- striker layout ----------
const STRIKER_START_X = 0.55
const STRIKER_START_Z = -12.4
const STRIKER_PLANT_X = 0.13
const STRIKER_PLANT_Z = PENALTY_Z - 0.35
const HIP_Y = 0.92

// ---------- pools ----------
const SPARK_N = 48
const RING_N = 6
const TRAIL_N = 30

const READY_LEFT = new THREE.Vector3(-0.6, 1.2, 0)
const READY_RIGHT = new THREE.Vector3(0.6, 1.2, 0)
const READY_TOP = new THREE.Vector3(0, 1.55, 0)
const READY_BOTTOM = new THREE.Vector3(0, 0.95, 0)

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)
const smooth = (t: number): number => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}
const easeOutCubic = (t: number): number => {
  const x = 1 - clamp(t, 0, 1)
  return 1 - x * x * x
}
/** Frame-rate independent approach factor. */
const approach = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt)

function makeDotTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  if (g) {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    grd.addColorStop(0, 'rgba(255,255,255,1)')
    grd.addColorStop(0.35, 'rgba(255,255,255,0.7)')
    grd.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, 64, 64)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function makeSkyTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 256
  const g = c.getContext('2d')
  if (g) {
    const grd = g.createLinearGradient(0, 0, 0, 256)
    grd.addColorStop(0, 'rgba(11,12,15,0)')
    grd.addColorStop(0.55, 'rgba(60,20,90,0.35)')
    grd.addColorStop(0.85, 'rgba(255,63,208,0.45)')
    grd.addColorStop(1, 'rgba(255,120,80,0.55)')
    g.fillStyle = grd
    g.fillRect(0, 0, 32, 256)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function makeSunTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  if (g) {
    const grd = g.createLinearGradient(0, 0, 0, 256)
    grd.addColorStop(0, '#ffd36a')
    grd.addColorStop(0.6, '#ff5fa8')
    grd.addColorStop(1, '#b02cff')
    g.fillStyle = grd
    g.beginPath()
    g.arc(128, 128, 126, 0, Math.PI * 2)
    g.fill()
    // retro horizontal slits in the lower half
    g.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 7; i++) {
      const y = 140 + i * 17
      g.fillRect(0, y, 256, 3 + i * 1.3)
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Faceted ball: icosphere with 12 dark pentagon patches so spin reads. */
function makeBallGeometry(): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(1, 0)
  const bp = base.getAttribute('position')
  const dirs: THREE.Vector3[] = []
  const tmp = new THREE.Vector3()
  for (let i = 0; i < bp.count; i++) {
    tmp.fromBufferAttribute(bp, i).normalize()
    if (!dirs.some((d) => d.dot(tmp) > 0.999)) dirs.push(tmp.clone())
  }
  base.dispose()
  const g = new THREE.IcosahedronGeometry(BALL_RADIUS, 3)
  const pos = g.getAttribute('position')
  const colors = new Float32Array(pos.count * 3)
  const dark = new THREE.Color(0x151a3c)
  const accent = new THREE.Color(MAGENTA)
  const light = new THREE.Color(0xf4f6ff)
  const v = new THREE.Vector3()
  for (let f = 0; f < pos.count; f += 3) {
    let best = -1
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(pos, f + k).normalize()
      for (const d of dirs) best = Math.max(best, d.dot(v))
    }
    const c = best > 0.9999 ? dark : best > 0.985 && (f / 3) % 4 === 0 ? accent : light
    for (let k = 0; k < 3; k++) {
      colors[(f + k) * 3] = c.r
      colors[(f + k) * 3 + 1] = c.g
      colors[(f + k) * 3 + 2] = c.b
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

interface Ring {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  t: number
  dur: number
  size: number
  active: boolean
}

interface GloveRig {
  group: THREE.Group
  mat: THREE.MeshStandardMaterial
  haloMat: THREE.MeshBasicMaterial
  pos: THREE.Vector3
  vel: THREE.Vector3
  target: THREE.Vector3
  glow: number
  baseColor: THREE.Color
}

interface Limb {
  hip: THREE.Group
  knee: THREE.Group
}

export function createKeeperScene(canvas?: HTMLCanvasElement): KeeperScene {
  const cv = canvas ?? document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = false
  renderer.setClearColor(BG, 1)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  scene.fog = new THREE.Fog(BG, 20, 60)

  const camera = new THREE.PerspectiveCamera(CAM_FOV, 16 / 9, 0.05, 200)
  const lookTarget = new THREE.Vector3(0, 0.85, PENALTY_Z)
  const shakeOffset = new THREE.Vector3()

  const textures: THREE.Texture[] = []
  const dotTex = makeDotTexture()
  textures.push(dotTex)

  // ---------- lights ----------
  scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x1a0f22, 1.1))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(-4, 9, 6)
  scene.add(sun)

  // ---------- backdrop ----------
  {
    const skyTex = makeSkyTexture()
    const sunTex = makeSunTexture()
    textures.push(skyTex, sunTex)
    const sky = new THREE.Mesh(
      new THREE.PlaneGeometry(260, 34),
      new THREE.MeshBasicMaterial({ map: skyTex, transparent: true, depthWrite: false, fog: false }),
    )
    sky.position.set(0, 13, -70)
    scene.add(sky)
    const sunDisc = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshBasicMaterial({ map: sunTex, transparent: true, depthWrite: false, fog: false, opacity: 0.55 }),
    )
    sunDisc.position.set(0, 3.5, -69)
    scene.add(sunDisc)

    // stand silhouettes with neon top edges
    const standMat = new THREE.MeshBasicMaterial({ color: 0x07080b })
    const standGeo = new THREE.BoxGeometry(1, 1, 1)
    const edgePts: number[] = []
    const stands: Array<[number, number, number, number]> = [
      // x, width, height, z
      [-24, 26, 5.5, -34],
      [24, 26, 5.5, -34],
      [0, 20, 3.2, -36],
    ]
    for (const [x, w, h, z] of stands) {
      const m = new THREE.Mesh(standGeo, standMat)
      m.scale.set(w, h, 2)
      m.position.set(x, h / 2, z)
      scene.add(m)
      edgePts.push(x - w / 2, h, z + 1.01, x + w / 2, h, z + 1.01)
      edgePts.push(x - w / 2, h * 0.55, z + 1.01, x + w / 2, h * 0.55, z + 1.01)
    }
    const edgeGeo = new THREE.BufferGeometry()
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePts, 3))
    scene.add(
      new THREE.LineSegments(
        edgeGeo,
        new THREE.LineBasicMaterial({ color: MAGENTA, transparent: true, opacity: 0.55, fog: false }),
      ),
    )
  }

  // ---------- pitch ----------
  {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshStandardMaterial({ color: 0x0d1016, roughness: 0.95, metalness: 0 }),
    )
    ground.rotation.x = -Math.PI / 2
    scene.add(ground)

    const grid = new THREE.GridHelper(120, 60, 0x7a2a8f, 0x173a52)
    grid.position.y = 0.002
    const gm = grid.material as THREE.LineBasicMaterial
    gm.transparent = true
    gm.opacity = 0.35
    gm.depthWrite = false
    scene.add(grid)

    const pts: number[] = []
    const seg = (x1: number, z1: number, x2: number, z2: number): void => {
      pts.push(x1, 0.006, z1, x2, 0.006, z2)
    }
    const box = (hw: number, depth: number): void => {
      seg(-hw, GOAL_Z, -hw, GOAL_Z - depth)
      seg(hw, GOAL_Z, hw, GOAL_Z - depth)
      seg(-hw, GOAL_Z - depth, hw, GOAL_Z - depth)
    }
    seg(-34, GOAL_Z, 34, GOAL_Z)
    box(GOAL_HALF_WIDTH + 5.5, 5.5)
    box(GOAL_HALF_WIDTH + 16.5, 16.5)
    // penalty arc beyond the box
    const arcA = Math.acos(5.5 / 9.15)
    const steps = 24
    for (let i = 0; i < steps; i++) {
      const a0 = -arcA + ((2 * arcA) * i) / steps
      const a1 = -arcA + ((2 * arcA) * (i + 1)) / steps
      seg(9.15 * Math.sin(a0), PENALTY_Z - 9.15 * Math.cos(a0), 9.15 * Math.sin(a1), PENALTY_Z - 9.15 * Math.cos(a1))
    }
    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    scene.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: LINE, transparent: true, opacity: 0.55 })))

    // glowing goal line between the posts
    const glGeo = new THREE.PlaneGeometry(GOAL_HALF_WIDTH * 2, 0.12)
    const gl = new THREE.Mesh(
      glGeo,
      new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    gl.rotation.x = -Math.PI / 2
    gl.position.set(0, 0.008, GOAL_Z)
    scene.add(gl)

    const spot = new THREE.Mesh(
      new THREE.CircleGeometry(0.13, 24),
      new THREE.MeshBasicMaterial({ color: LINE, transparent: true, opacity: 0.8 }),
    )
    spot.rotation.x = -Math.PI / 2
    spot.position.set(0, 0.009, PENALTY_Z)
    scene.add(spot)
  }

  // ---------- goal frame ----------
  const frameMat = new THREE.MeshBasicMaterial({ color: FRAME })
  const frameGlowMat = new THREE.MeshBasicMaterial({
    color: CYAN,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const frameBase = new THREE.Color(FRAME)
  const frameGlowBase = new THREE.Color(CYAN)
  const flashRed = new THREE.Color(RED)
  {
    const postGeo = new THREE.CylinderGeometry(0.06, 0.06, GOAL_HEIGHT + 0.06, 12)
    const postGlowGeo = new THREE.CylinderGeometry(0.12, 0.12, GOAL_HEIGHT + 0.12, 12, 1, true)
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(postGeo, frameMat)
      p.position.set(sx * GOAL_HALF_WIDTH, (GOAL_HEIGHT + 0.06) / 2, GOAL_Z)
      scene.add(p)
      const pg = new THREE.Mesh(postGlowGeo, frameGlowMat)
      pg.position.copy(p.position)
      scene.add(pg)
    }
    const barGeo = new THREE.CylinderGeometry(0.06, 0.06, GOAL_HALF_WIDTH * 2 + 0.12, 12)
    const barGlowGeo = new THREE.CylinderGeometry(0.12, 0.12, GOAL_HALF_WIDTH * 2 + 0.24, 12, 1, true)
    const bar = new THREE.Mesh(barGeo, frameMat)
    bar.rotation.z = Math.PI / 2
    bar.position.set(0, GOAL_HEIGHT, GOAL_Z)
    scene.add(bar)
    const barGlow = new THREE.Mesh(barGlowGeo, frameGlowMat)
    barGlow.rotation.z = Math.PI / 2
    barGlow.position.copy(bar.position)
    scene.add(barGlow)
  }

  // ---------- net ----------
  const NET_COLS = 32
  const NET_BACK_ROWS = 10
  const NET_ROOF_ROWS = 4
  const NET_ROWS = NET_BACK_ROWS + NET_ROOF_ROWS
  const NET_BACK_Z = 1.5
  const NET_TOP_Z = 1.0
  const NET_TOP_Y = 2.3
  const netCount = (NET_COLS + 1) * (NET_ROWS + 1)
  const netBase = new Float32Array(netCount * 3)
  const netPos = new Float32Array(netCount * 3)
  const netGeo = new THREE.BufferGeometry()
  {
    for (let r = 0; r <= NET_ROWS; r++) {
      let y: number
      let z: number
      if (r <= NET_BACK_ROWS) {
        const s = r / NET_BACK_ROWS
        y = NET_TOP_Y * s
        z = NET_BACK_Z + (NET_TOP_Z - NET_BACK_Z) * s
      } else {
        const s = (r - NET_BACK_ROWS) / NET_ROOF_ROWS
        y = NET_TOP_Y + (GOAL_HEIGHT - NET_TOP_Y) * s
        z = NET_TOP_Z + (GOAL_Z + 0.04 - NET_TOP_Z) * s
      }
      for (let c = 0; c <= NET_COLS; c++) {
        const i = (r * (NET_COLS + 1) + c) * 3
        netBase[i] = -GOAL_HALF_WIDTH + (2 * GOAL_HALF_WIDTH * c) / NET_COLS
        netBase[i + 1] = y
        netBase[i + 2] = z
      }
    }
    netPos.set(netBase)
    const idx: number[] = []
    for (let r = 0; r <= NET_ROWS; r++) {
      for (let c = 0; c <= NET_COLS; c++) {
        const i = r * (NET_COLS + 1) + c
        if (c < NET_COLS) idx.push(i, i + 1)
        if (r < NET_ROWS) idx.push(i, i + NET_COLS + 1)
      }
    }
    netGeo.setAttribute('position', new THREE.BufferAttribute(netPos, 3))
    netGeo.setIndex(idx)
  }
  const netMat = new THREE.LineBasicMaterial({ color: 0x6fdcff, transparent: true, opacity: 0.28, depthWrite: false })
  scene.add(new THREE.LineSegments(netGeo, netMat))
  {
    // static side nets
    const sp: number[] = []
    const profileZAtY = (y: number): number =>
      y <= NET_TOP_Y
        ? NET_BACK_Z + (NET_TOP_Z - NET_BACK_Z) * (y / NET_TOP_Y)
        : NET_TOP_Z + (GOAL_Z - NET_TOP_Z) * ((y - NET_TOP_Y) / (GOAL_HEIGHT - NET_TOP_Y))
    const profileYAtZ = (z: number): number =>
      z > NET_TOP_Z
        ? (NET_TOP_Y * (NET_BACK_Z - z)) / (NET_BACK_Z - NET_TOP_Z)
        : NET_TOP_Y + ((GOAL_HEIGHT - NET_TOP_Y) * (NET_TOP_Z - z)) / (NET_TOP_Z - GOAL_Z)
    for (const sx of [-GOAL_HALF_WIDTH, GOAL_HALF_WIDTH]) {
      for (let k = 0; k <= 8; k++) {
        const y = (k / 8) * NET_TOP_Y
        sp.push(sx, y, GOAL_Z, sx, y, profileZAtY(y))
      }
      for (let k = 1; k <= 6; k++) {
        const z = (k / 6) * NET_BACK_Z * 0.97
        sp.push(sx, 0, z, sx, profileYAtZ(z), z)
      }
    }
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3))
    scene.add(new THREE.LineSegments(sg, netMat))
  }
  const ripple = { active: false, x: 0, y: 0, t: 0 }

  // ---------- zone grid ----------
  const ZONE_W = (GOAL_HALF_WIDTH * 2) / 3
  const ZONE_H = GOAL_HEIGHT / 3
  {
    const zp: number[] = []
    for (const x of [-ZONE_W / 2, ZONE_W / 2]) zp.push(x, 0, GOAL_Z, x, GOAL_HEIGHT, GOAL_Z)
    for (const y of [ZONE_H, ZONE_H * 2]) zp.push(-GOAL_HALF_WIDTH, y, GOAL_Z, GOAL_HALF_WIDTH, y, GOAL_Z)
    const zg = new THREE.BufferGeometry()
    zg.setAttribute('position', new THREE.Float32BufferAttribute(zp, 3))
    scene.add(
      new THREE.LineSegments(zg, new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.16, depthWrite: false })),
    )
  }
  const zoneMat = new THREE.MeshBasicMaterial({
    color: SAVE_GREEN,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const zoneCell = new THREE.Mesh(new THREE.PlaneGeometry(ZONE_W - 0.04, ZONE_H - 0.04), zoneMat)
  zoneCell.visible = false
  zoneCell.renderOrder = 2
  scene.add(zoneCell)
  const zoneHl = { t: 0, dur: 0.8, peak: 0.35 }

  // ---------- ball ----------
  const ballGeo = makeBallGeometry()
  const ballMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.45,
    metalness: 0.05,
    emissive: 0x20232e,
  })
  const ball = new THREE.Mesh(ballGeo, ballMat)
  ball.position.set(0, BALL_RADIUS, PENALTY_Z)
  ball.visible = false
  scene.add(ball)
  const ballShadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false })
  const ballShadow = new THREE.Mesh(new THREE.CircleGeometry(BALL_RADIUS * 1.1, 20), ballShadowMat)
  ballShadow.rotation.x = -Math.PI / 2
  ballShadow.visible = false
  scene.add(ballShadow)
  const lastOmega = new THREE.Vector3()
  const spinAxis = new THREE.Vector3()
  const spinQ = new THREE.Quaternion()
  const prevBallPos = new THREE.Vector3()
  let ballSpeed = 0

  // trail
  const trailPos = new Float32Array(TRAIL_N * 3)
  const trailCol = new Float32Array(TRAIL_N * 3)
  const trailGeo = new THREE.BufferGeometry()
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3))
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3))
  const trailMat = new THREE.PointsMaterial({
    size: 0.2,
    map: dotTex,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  })
  const trail = new THREE.Points(trailGeo, trailMat)
  trail.frustumCulled = false
  scene.add(trail)
  let trailAlpha = 0
  const trailTint = new THREE.Color(0xffd0f4)
  const resetTrail = (p: THREE.Vector3): void => {
    for (let i = 0; i < TRAIL_N; i++) {
      trailPos[i * 3] = p.x
      trailPos[i * 3 + 1] = p.y
      trailPos[i * 3 + 2] = p.z
    }
    trailGeo.getAttribute('position').needsUpdate = true
  }
  const pushTrail = (x: number, y: number, z: number): void => {
    trailPos.copyWithin(3, 0, (TRAIL_N - 1) * 3)
    trailPos[0] = x
    trailPos[1] = y
    trailPos[2] = z
  }

  // ---------- sparks ----------
  const sparkPos = new Float32Array(SPARK_N * 3)
  const sparkVel = new Float32Array(SPARK_N * 3)
  const sparkCol = new Float32Array(SPARK_N * 3)
  const sparkBase = new Float32Array(SPARK_N * 3)
  const sparkLife = new Float32Array(SPARK_N)
  const sparkMax = new Float32Array(SPARK_N).fill(1)
  let sparkCursor = 0
  const sparkGeo = new THREE.BufferGeometry()
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3))
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3))
  const sparkMat = new THREE.PointsMaterial({
    size: 0.11,
    map: dotTex,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const sparks = new THREE.Points(sparkGeo, sparkMat)
  sparks.frustumCulled = false
  scene.add(sparks)
  let sparksAlive = 0
  const tmpColor = new THREE.Color()
  const spawnSparks = (p: Vec3, count: number, color: number, speed: number): void => {
    tmpColor.set(color)
    for (let n = 0; n < count; n++) {
      const i = sparkCursor
      sparkCursor = (sparkCursor + 1) % SPARK_N
      const u = Math.random() * 2 - 1
      const a = Math.random() * Math.PI * 2
      const s = Math.sqrt(1 - u * u)
      const sp = speed * (0.4 + Math.random() * 0.8)
      sparkPos[i * 3] = p.x
      sparkPos[i * 3 + 1] = p.y
      sparkPos[i * 3 + 2] = p.z
      sparkVel[i * 3] = s * Math.cos(a) * sp
      sparkVel[i * 3 + 1] = u * sp + 1.2
      sparkVel[i * 3 + 2] = Math.abs(s * Math.sin(a)) * sp * 0.8 + 0.8
      const life = 0.35 + Math.random() * 0.45
      sparkLife[i] = life
      sparkMax[i] = life
      const w = Math.random() < 0.3 ? 1 : 0
      sparkBase[i * 3] = tmpColor.r + (1 - tmpColor.r) * w
      sparkBase[i * 3 + 1] = tmpColor.g + (1 - tmpColor.g) * w
      sparkBase[i * 3 + 2] = tmpColor.b + (1 - tmpColor.b) * w
    }
    sparksAlive = SPARK_N
  }

  // ---------- rings ----------
  const ringGeo = new THREE.RingGeometry(0.9, 1, 48)
  const rings: Ring[] = []
  for (let i = 0; i < RING_N; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: CYAN,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(ringGeo, mat)
    mesh.visible = false
    mesh.renderOrder = 3
    scene.add(mesh)
    rings.push({ mesh, mat, t: 0, dur: 0.45, size: 0.9, active: false })
  }
  let ringCursor = 0
  const spawnRing = (p: Vec3, color: number, size: number, dur: number): void => {
    const r = rings[ringCursor]
    ringCursor = (ringCursor + 1) % RING_N
    r.active = true
    r.t = 0
    r.dur = dur
    r.size = size
    r.mat.color.set(color)
    r.mesh.position.set(p.x, p.y, p.z + 0.02)
    r.mesh.visible = true
  }

  // ---------- gloves ----------
  const palmGeo = new THREE.SphereGeometry(GLOVE_VISUAL, 18, 12)
  const thumbGeo = new THREE.SphereGeometry(GLOVE_VISUAL * 0.38, 12, 8)
  const cuffGeo = new THREE.CylinderGeometry(GLOVE_VISUAL * 0.55, GLOVE_VISUAL * 0.62, GLOVE_VISUAL * 0.6, 14)
  const haloGeo = new THREE.RingGeometry(GLOVE_RADIUS - 0.022, GLOVE_RADIUS, 48)
  const cuffMat = new THREE.MeshStandardMaterial({ color: 0xe8ecff, emissive: 0x4a4f66, roughness: 0.5 })
  const makeGlove = (color: number, side: -1 | 1): GloveRig => {
    const group = new THREE.Group()
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, roughness: 0.35, metalness: 0.1 })
    const palm = new THREE.Mesh(palmGeo, mat)
    palm.scale.set(1, 1.12, 0.7)
    group.add(palm)
    const thumb = new THREE.Mesh(thumbGeo, mat)
    // thumb on the inner side (toward the centre line)
    thumb.position.set(-side * GLOVE_VISUAL * 0.95, -GLOVE_VISUAL * 0.15, GLOVE_VISUAL * 0.1)
    thumb.scale.set(1, 1.4, 0.9)
    thumb.rotation.z = side * 0.5
    group.add(thumb)
    const cuff = new THREE.Mesh(cuffGeo, cuffMat)
    cuff.position.set(0, -GLOVE_VISUAL * 1.25, 0)
    group.add(cuff)
    const haloMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const halo = new THREE.Mesh(haloGeo, haloMat)
    halo.renderOrder = 4
    group.add(halo)
    const start = side < 0 ? READY_LEFT : READY_RIGHT
    group.position.copy(start)
    scene.add(group)
    return {
      group,
      mat,
      haloMat,
      pos: start.clone(),
      vel: new THREE.Vector3(),
      target: start.clone(),
      glow: 0,
      baseColor: new THREE.Color(color),
    }
  }
  const gloveL = makeGlove(CYAN, -1)
  const gloveR = makeGlove(MAGENTA, 1)
  let keeperTracked = true
  let keeperPresent = false
  let keeperDim = 1

  // torso ghost: cylinder + two end spheres
  const ghostMat = new THREE.MeshBasicMaterial({
    color: 0x9fd8ff,
    transparent: true,
    opacity: 0.07,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const ghostCyl = new THREE.Mesh(new THREE.CylinderGeometry(TORSO_RADIUS, TORSO_RADIUS, 1, 16, 1, true), ghostMat)
  const ghostCapGeo = new THREE.SphereGeometry(TORSO_RADIUS, 16, 10)
  const ghostTopCap = new THREE.Mesh(ghostCapGeo, ghostMat)
  const ghostBotCap = new THREE.Mesh(ghostCapGeo, ghostMat)
  for (const m of [ghostCyl, ghostTopCap, ghostBotCap]) {
    m.renderOrder = 1
    scene.add(m)
  }
  const torsoTop = READY_TOP.clone()
  const torsoBottom = READY_BOTTOM.clone()
  const torsoTopTarget = READY_TOP.clone()
  const torsoBottomTarget = READY_BOTTOM.clone()
  let torsoGlow = 0
  const UP = new THREE.Vector3(0, 1, 0)
  const segDir = new THREE.Vector3()

  // ---------- striker bot ----------
  const botBodyMat = new THREE.MeshStandardMaterial({ color: 0x56607a, roughness: 0.5, metalness: 0.3 })
  const botDarkMat = new THREE.MeshStandardMaterial({ color: 0x262b38, roughness: 0.6, metalness: 0.2 })
  const botAccentMat = new THREE.MeshBasicMaterial({ color: AMBER })
  const visorMat = new THREE.MeshBasicMaterial({ color: AMBER })
  const kickFootMat = new THREE.MeshStandardMaterial({ color: 0x3a3f50, emissive: AMBER, emissiveIntensity: 0, roughness: 0.4 })
  const kickGlowMat = new THREE.MeshBasicMaterial({
    color: AMBER,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const botRoot = new THREE.Group()
  const botUpper = new THREE.Group()
  botUpper.position.y = HIP_Y
  botRoot.add(botUpper)
  const thighGeo = new THREE.CapsuleGeometry(0.085, 0.3, 4, 10)
  const shinGeo = new THREE.CapsuleGeometry(0.072, 0.3, 4, 10)
  const footGeo = new THREE.BoxGeometry(0.15, 0.08, 0.27)
  const footGlowGeo = new THREE.SphereGeometry(0.2, 14, 10)
  const makeLeg = (x: number, kick: boolean): Limb => {
    const hip = new THREE.Group()
    hip.position.set(x, HIP_Y, 0)
    const thigh = new THREE.Mesh(thighGeo, botBodyMat)
    thigh.position.y = -0.22
    hip.add(thigh)
    const knee = new THREE.Group()
    knee.position.y = -0.44
    hip.add(knee)
    const shin = new THREE.Mesh(shinGeo, botDarkMat)
    shin.position.y = -0.21
    knee.add(shin)
    const foot = new THREE.Mesh(footGeo, kick ? kickFootMat : botDarkMat)
    foot.position.set(0, -0.44, 0.06)
    knee.add(foot)
    if (kick) {
      const glow = new THREE.Mesh(footGlowGeo, kickGlowMat)
      glow.position.copy(foot.position)
      glow.renderOrder = 2
      knee.add(glow)
    }
    botRoot.add(hip)
    return { hip, knee }
  }
  // The bot faces +z (toward the camera): its own right side is world -x. Kicking leg = right.
  const legKick = makeLeg(-0.13, true)
  const legPlant = makeLeg(0.13, false)
  {
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.22), botDarkMat)
    botUpper.add(pelvis)
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.36, 4, 12), botBodyMat)
    torso.position.y = 0.4
    torso.scale.set(1.15, 1, 0.85)
    botUpper.add(torso)
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.035, 0.02), botAccentMat)
    chest.position.set(0, 0.5, 0.185)
    botUpper.add(chest)
    const chest2 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.025, 0.02), botAccentMat)
    chest2.position.set(0, 0.43, 0.185)
    botUpper.add(chest2)
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 8), botDarkMat)
    neck.position.y = 0.74
    botUpper.add(neck)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), botBodyMat)
    head.position.y = 0.9
    botUpper.add(head)
    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(0.166, 18, 4, Math.PI * 0.08, Math.PI * 0.84, Math.PI * 0.4, Math.PI * 0.17),
      visorMat,
    )
    visor.position.y = 0.9
    botUpper.add(visor)
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.14, 6), botDarkMat)
    antenna.position.set(0.07, 1.1, 0)
    botUpper.add(antenna)
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), botAccentMat)
    tip.position.set(0.07, 1.18, 0)
    botUpper.add(tip)
  }
  const armGeo = new THREE.CapsuleGeometry(0.055, 0.42, 4, 8)
  const handGeo = new THREE.SphereGeometry(0.07, 10, 8)
  const makeArm = (x: number): THREE.Group => {
    const sh = new THREE.Group()
    sh.position.set(x, 0.62, 0)
    const arm = new THREE.Mesh(armGeo, botBodyMat)
    arm.position.y = -0.26
    sh.add(arm)
    const hand = new THREE.Mesh(handGeo, botDarkMat)
    hand.position.y = -0.55
    sh.add(hand)
    botUpper.add(sh)
    return sh
  }
  const armR = makeArm(-0.31) // bot's right (world -x)
  const armL = makeArm(0.31)
  botRoot.position.set(STRIKER_START_X, 0, STRIKER_START_Z)
  botRoot.scale.setScalar(1.12)
  scene.add(botRoot)

  // ---------- wind-up arrow (0.6 s telegraph) ----------
  // Solid, opaque arrow on the grass in front of the ball, pointing where the shot goes. Colour by
  // shot: amber = straight/curl, cyan = low skimmer, magenta = high (top corner / dip). It swings to
  // the real side mid wind-up on a fake.
  const arrowShape = new THREE.Shape()
  arrowShape.moveTo(-0.2, 0)
  arrowShape.lineTo(0.2, 0)
  arrowShape.lineTo(0.2, 1.25)
  arrowShape.lineTo(0.55, 1.25)
  arrowShape.lineTo(0, 2.05)
  arrowShape.lineTo(-0.55, 1.25)
  arrowShape.lineTo(-0.2, 1.25)
  arrowShape.closePath()
  const arrowMat = new THREE.MeshBasicMaterial({ color: AMBER, side: THREE.DoubleSide, fog: false })
  const arrowMesh = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape), arrowMat)
  arrowMesh.rotation.x = Math.PI / 2 // shape +y -> world +z (toward the goal)
  const arrowRoot = new THREE.Group()
  // Mid-pitch, so it shows below the keeper's gloves from the camera behind the goal.
  arrowRoot.position.set(0, 0.03, -5.2)
  arrowRoot.add(arrowMesh)
  arrowRoot.visible = false
  arrowRoot.renderOrder = 2
  scene.add(arrowRoot)
  const ARROW_YAW = 0.42
  // Reused by screenToGoal (called every frame in mouse mode).
  const goalRay = new THREE.Vector3()
  const goalOut = { x: 0, y: 0 }
  const ARROW_HIGH = 0xff3fd0
  const ARROW_LOW = 0x22e6ff
  let arrowColor = AMBER
  function updateArrow(phase: StrikerPhase, p: number, tell: StrikerTell): void {
    if (phase !== 'telegraph') {
      arrowRoot.visible = false
      return
    }
    arrowRoot.visible = true
    const grow = smooth(Math.min(1, p / 0.25))
    const len = (tell.high ? 1.35 : 1.05) * grow
    arrowRoot.scale.set(1.5 * (0.6 + 0.4 * grow), 1, 1.5 * len)
    arrowRoot.rotation.y = tell.side * ARROW_YAW
    const color = tell.kind === 'skimmer' ? ARROW_LOW : tell.high ? ARROW_HIGH : AMBER
    if (color !== arrowColor) {
      arrowColor = color
      arrowMat.color.setHex(color)
    }
  }

  // striker animation state
  let sPhase: StrikerPhase = 'idle'
  let sProgress = 0
  const sTell: { side: -1 | 0 | 1; high: boolean } = { side: 0, high: false }
  const sCur = {
    x: STRIKER_START_X,
    z: STRIKER_START_Z,
    y: 0,
    leanX: 0.03,
    leanZ: 0,
    kick: 0,
    kickKnee: 0.05,
    plant: 0,
    plantKnee: 0.05,
    armR: 0,
    armL: 0,
    spread: 0,
    glow: 0,
  }
  const sTgt = { ...sCur }
  let gait = 0
  let heldLeanX = 0
  let heldLeanZ = 0

  // ---------- effects state ----------
  let time = 0
  let shakeAmt = 0
  let frameFlash = 0

  // ---------- helpers ----------
  const fitCamera = (aspect: number): void => {
    const a = Math.max(aspect, 0.2)
    const tanV = Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2))
    let d = FIT_HALF_WIDTH / (tanV * a)
    let fov = CAM_FOV
    if (d > CAM_MAX_D) {
      // very narrow window: widen fov instead of backing off forever
      d = CAM_MAX_D
      fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(FIT_HALF_WIDTH / (d * a))), CAM_FOV, 100)
    }
    d = Math.max(d, CAM_MIN_D)
    camera.fov = fov
    camera.aspect = a
    camera.position.set(0, CAM_Y, d)
    camera.lookAt(lookTarget)
    camera.updateProjectionMatrix()
  }

  const computeStrikerTargets = (): void => {
    const p = sProgress
    const t = sTgt
    t.y = 0
    t.spread = 0
    t.glow = 0
    switch (sPhase) {
      case 'idle': {
        t.x = STRIKER_START_X
        t.z = STRIKER_START_Z
        t.y = 0.012 * Math.sin(time * 2.4)
        t.leanX = 0.03 + 0.015 * Math.sin(time * 2.4)
        t.leanZ = 0
        t.kick = 0
        t.plant = 0
        t.kickKnee = 0.06
        t.plantKnee = 0.06
        t.armR = 0.08 * Math.sin(time * 1.3)
        t.armL = -0.08 * Math.sin(time * 1.3)
        heldLeanX = 0
        heldLeanZ = 0
        break
      }
      case 'runup': {
        const e = p * p * (3 - 2 * p)
        t.x = STRIKER_START_X + (STRIKER_PLANT_X - STRIKER_START_X) * e
        t.z = -12.6 + (STRIKER_PLANT_Z + 12.6) * e
        t.leanX = 0.16
        t.leanZ = 0
        t.kick = 0
        t.plant = 0
        t.kickKnee = 0.15
        t.plantKnee = 0.15
        t.armR = 0
        t.armL = 0
        break
      }
      case 'telegraph': {
        const e = smooth(p / 0.4)
        t.x = STRIKER_PLANT_X - sTell.side * 0.03 * e
        t.z = STRIKER_PLANT_Z
        t.y = -0.035 * e
        const lz = -sTell.side * THREE.MathUtils.degToRad(10) * e
        const lx = sTell.high ? -THREE.MathUtils.degToRad(8) * e : 0.06 * e
        t.leanZ = lz
        t.leanX = lx
        heldLeanX = lx
        heldLeanZ = lz
        t.kick = 0.95 * smooth(p)
        t.kickKnee = 0.2 + 1.1 * smooth(p)
        t.plant = -0.12
        t.plantKnee = 0.18
        t.armR = -0.2 * e
        t.armL = 0.25 * e
        t.spread = 0.45 * e
        t.glow = e * (0.55 + 0.45 * Math.sin(p * Math.PI * 2 * 2.5))
        break
      }
      case 'kick': {
        const k = easeOutCubic(p)
        t.x = STRIKER_PLANT_X - sTell.side * 0.03
        t.z = STRIKER_PLANT_Z
        t.y = -0.03
        t.leanZ = heldLeanZ
        t.leanX = heldLeanX
        t.kick = 0.95 + (-1.35 - 0.95) * k
        t.kickKnee = 1.3 * (1 - k)
        t.plant = -0.12
        t.plantKnee = 0.2
        t.armR = 0.4
        t.armL = -0.3
        t.spread = 0.7
        t.glow = 1
        break
      }
      case 'recover': {
        const back = smooth((p - 0.35) / 0.65)
        t.x = STRIKER_PLANT_X
        t.z = STRIKER_PLANT_Z + 0.25 * smooth(p * 2)
        t.leanZ = heldLeanZ * (1 - smooth(p))
        t.leanX = heldLeanX * (1 - smooth(p)) + 0.05
        t.kick = -1.35 * (1 - back)
        t.kickKnee = 0.25 * (1 - back) + 0.06
        t.plant = -0.08 * (1 - back)
        t.plantKnee = 0.12
        t.armR = 0.4 * (1 - back)
        t.armL = -0.3 * (1 - back)
        t.spread = 0.7 * (1 - back)
        t.glow = 0
        break
      }
    }
  }

  const applyStriker = (): void => {
    const c = sCur
    botRoot.position.set(c.x, c.y, c.z)
    botUpper.rotation.set(c.leanX, 0, c.leanZ)
    legKick.hip.rotation.x = c.kick
    legKick.knee.rotation.x = c.kickKnee
    legPlant.hip.rotation.x = c.plant
    legPlant.knee.rotation.x = c.plantKnee
    armR.rotation.set(c.armR, 0, -c.spread)
    armL.rotation.set(c.armL, 0, c.spread)
    kickFootMat.emissiveIntensity = c.glow * 1.6
    kickGlowMat.opacity = c.glow * 0.35
  }

  const updateStriker = (dt: number): void => {
    computeStrikerTargets()
    const c = sCur
    const t = sTgt
    const rootRate = sPhase === 'idle' ? 2.5 : 14
    const kRoot = approach(rootRate, dt)
    const ox = c.x
    const oz = c.z
    c.x += (t.x - c.x) * kRoot
    c.z += (t.z - c.z) * kRoot
    const moved = Math.hypot(c.x - ox, c.z - oz)
    const speed = dt > 0 ? moved / dt : 0
    gait += moved * 9
    const walk = clamp(speed / 2.5, 0, 1)
    const kPose = approach(sPhase === 'kick' ? 45 : 22, dt)
    const kLean = approach(10, dt)
    c.y += (t.y + 0.045 * walk * Math.abs(Math.sin(gait)) - c.y) * kPose
    c.leanX += (t.leanX - c.leanX) * kLean
    c.leanZ += (t.leanZ - c.leanZ) * kLean
    const swing = 0.75 * walk * Math.sin(gait)
    const useGait = sPhase === 'idle' || sPhase === 'runup'
    const kickT = t.kick + (useGait ? -swing : 0)
    const plantT = t.plant + (useGait ? swing : 0)
    const kickKneeT = t.kickKnee + (useGait ? 0.8 * walk * Math.max(0, -Math.sin(gait)) : 0)
    const plantKneeT = t.plantKnee + (useGait ? 0.8 * walk * Math.max(0, Math.sin(gait)) : 0)
    c.kick += (kickT - c.kick) * kPose
    c.plant += (plantT - c.plant) * kPose
    c.kickKnee += (kickKneeT - c.kickKnee) * kPose
    c.plantKnee += (plantKneeT - c.plantKnee) * kPose
    c.armR += (t.armR + (useGait ? 0.6 * walk * Math.sin(gait) : 0) - c.armR) * kPose
    c.armL += (t.armL - (useGait ? 0.6 * walk * Math.sin(gait) : 0) - c.armL) * kPose
    c.spread += (t.spread - c.spread) * kPose
    c.glow += (t.glow - c.glow) * approach(18, dt)
    applyStriker()
  }

  const updateGlove = (g: GloveRig, dt: number): void => {
    // stiff critically damped spring, sub-stepped for stability
    const w = 38
    const k = w * w
    const damp = 2 * w
    let remaining = dt
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 120)
      remaining -= h
      g.vel.x += (k * (g.target.x - g.pos.x) - damp * g.vel.x) * h
      g.vel.y += (k * (g.target.y - g.pos.y) - damp * g.vel.y) * h
      g.vel.z += (k * (g.target.z - g.pos.z) - damp * g.vel.z) * h
      g.pos.x += g.vel.x * h
      g.pos.y += g.vel.y * h
      g.pos.z += g.vel.z * h
    }
    // never trail far behind the collision pose
    const lag = g.pos.distanceTo(g.target)
    if (lag > 0.35) g.pos.lerp(g.target, 1 - 0.35 / lag)
    g.group.position.copy(g.pos)
    g.glow = Math.max(0, g.glow - dt * 3.2)
    g.mat.emissiveIntensity = (0.55 + 2.2 * g.glow) * keeperDim
    g.haloMat.opacity = (0.2 + 0.5 * g.glow) * keeperDim
    const s = 1 + 0.18 * g.glow
    g.group.scale.setScalar(s)
  }

  const updateTorso = (dt: number): void => {
    const k = approach(30, dt)
    torsoTop.lerp(torsoTopTarget, k)
    torsoBottom.lerp(torsoBottomTarget, k)
    segDir.subVectors(torsoTop, torsoBottom)
    const len = Math.max(segDir.length(), 0.001)
    segDir.multiplyScalar(1 / len)
    ghostCyl.position.addVectors(torsoTop, torsoBottom).multiplyScalar(0.5)
    ghostCyl.quaternion.setFromUnitVectors(UP, segDir)
    ghostCyl.scale.set(1, len, 1)
    ghostTopCap.position.copy(torsoTop)
    ghostBotCap.position.copy(torsoBottom)
    torsoGlow = Math.max(0, torsoGlow - dt * 3)
    ghostMat.opacity = (keeperPresent ? 0.06 : 0.035) * keeperDim + 0.3 * torsoGlow
  }

  const updateBall = (dt: number): void => {
    if (ball.visible) {
      const w = lastOmega.length()
      if (w > 1e-4) {
        spinAxis.copy(lastOmega).multiplyScalar(1 / w)
        spinQ.setFromAxisAngle(spinAxis, w * dt)
        ball.quaternion.premultiply(spinQ)
      }
      const moved = ball.position.distanceTo(prevBallPos)
      ballSpeed = dt > 0 ? moved / dt : 0
      // two samples per frame (midpoint + current) for a denser streak
      pushTrail(
        (ball.position.x + prevBallPos.x) * 0.5,
        (ball.position.y + prevBallPos.y) * 0.5,
        (ball.position.z + prevBallPos.z) * 0.5,
      )
      pushTrail(ball.position.x, ball.position.y, ball.position.z)
      prevBallPos.copy(ball.position)
      const target = clamp((ballSpeed - 2) / 10, 0, 1)
      trailAlpha += (target - trailAlpha) * approach(12, dt)
      ballShadow.visible = true
      ballShadow.position.set(ball.position.x, 0.011, ball.position.z)
      const h = Math.max(0, ball.position.y - BALL_RADIUS)
      ballShadow.scale.setScalar(1 + h * 0.6)
      ballShadowMat.opacity = 0.5 / (1 + h * 1.5)
    } else {
      ballSpeed = 0
      trailAlpha = Math.max(0, trailAlpha - dt * 4)
      ballShadow.visible = false
    }
    trail.visible = trailAlpha > 0.01
    if (trail.visible) {
      for (let i = 0; i < TRAIL_N; i++) {
        const f = Math.pow(1 - i / TRAIL_N, 1.6) * trailAlpha * 0.7
        trailCol[i * 3] = trailTint.r * f
        trailCol[i * 3 + 1] = trailTint.g * f
        trailCol[i * 3 + 2] = trailTint.b * f
      }
      trailGeo.getAttribute('position').needsUpdate = true
      trailGeo.getAttribute('color').needsUpdate = true
    }
  }

  const updateSparks = (dt: number): void => {
    if (sparksAlive <= 0) {
      sparks.visible = false
      return
    }
    sparks.visible = true
    let alive = 0
    const drag = Math.exp(-2.2 * dt)
    for (let i = 0; i < SPARK_N; i++) {
      const j = i * 3
      if (sparkLife[i] <= 0) {
        sparkCol[j] = sparkCol[j + 1] = sparkCol[j + 2] = 0
        continue
      }
      alive++
      sparkLife[i] -= dt
      const f = Math.max(0, sparkLife[i] / sparkMax[i])
      sparkVel[j] *= drag
      sparkVel[j + 1] = sparkVel[j + 1] * drag - 6 * dt
      sparkVel[j + 2] *= drag
      sparkPos[j] += sparkVel[j] * dt
      sparkPos[j + 1] += sparkVel[j + 1] * dt
      sparkPos[j + 2] += sparkVel[j + 2] * dt
      sparkCol[j] = sparkBase[j] * f
      sparkCol[j + 1] = sparkBase[j + 1] * f
      sparkCol[j + 2] = sparkBase[j + 2] * f
    }
    sparksAlive = alive
    sparkGeo.getAttribute('position').needsUpdate = true
    sparkGeo.getAttribute('color').needsUpdate = true
  }

  const updateRings = (dt: number): void => {
    for (const r of rings) {
      if (!r.active) continue
      r.t += dt
      const u = r.t / r.dur
      if (u >= 1) {
        r.active = false
        r.mesh.visible = false
        continue
      }
      const s = 0.12 + r.size * easeOutCubic(u)
      r.mesh.scale.set(s, s, 1)
      r.mat.opacity = 0.9 * (1 - u) * (1 - u)
    }
  }

  const resetNet = (): void => {
    netPos.set(netBase)
    netGeo.getAttribute('position').needsUpdate = true
  }

  const updateNet = (dt: number): void => {
    if (!ripple.active) return
    ripple.t += dt
    const t = ripple.t
    if (t > 1.8) {
      ripple.active = false
      resetNet()
      return
    }
    const env = t < 0.12 ? Math.sin((t / 0.12) * Math.PI * 0.5) : Math.exp(-(t - 0.12) * 3.2)
    const waveDecay = Math.exp(-2.4 * t)
    for (let i = 0; i < netCount; i++) {
      const j = i * 3
      const dx = netBase[j] - ripple.x
      const dy = netBase[j + 1] - ripple.y
      const r2 = dx * dx + dy * dy
      const r = Math.sqrt(r2)
      const bulge = 0.55 * Math.exp(-r2 / 0.55) * env
      const wave = 0.07 * Math.cos(12 * t - 6 * r) * waveDecay * Math.exp(-0.7 * r)
      netPos[j] = netBase[j] + dx * bulge * 0.08
      netPos[j + 1] = netBase[j + 1] + dy * bulge * 0.08
      netPos[j + 2] = netBase[j + 2] + bulge + wave
    }
    netGeo.getAttribute('position').needsUpdate = true
  }

  const updateFrame = (dt: number): void => {
    frameFlash = Math.max(0, frameFlash - dt * 1.6)
    const f = frameFlash
    frameMat.color.copy(frameBase).lerp(flashRed, f)
    frameGlowMat.color.copy(frameGlowBase).lerp(flashRed, f)
    frameGlowMat.opacity = 0.16 + 0.5 * f
    netMat.color.setHex(0x6fdcff).lerp(flashRed, f * 0.8)
    netMat.opacity = 0.28 + 0.25 * f
  }

  const updateZone = (dt: number): void => {
    if (!zoneCell.visible) return
    zoneHl.t += dt
    const u = zoneHl.t / zoneHl.dur
    if (u >= 1) {
      zoneCell.visible = false
      zoneMat.opacity = 0
      return
    }
    // quick attack, smooth fade
    const a = u < 0.08 ? u / 0.08 : 1 - smooth((u - 0.08) / 0.92)
    zoneMat.opacity = zoneHl.peak * a
  }

  // ---------- API ----------
  const api: KeeperScene = {
    canvas: cv,

    resize(width: number, height: number): void {
      const w = Math.max(1, Math.floor(width))
      const h = Math.max(1, Math.floor(height))
      renderer.setSize(w, h, false)
      fitCamera(w / h)
    },

    setQuality(level: 'high' | 'low'): void {
      // Low quality renders at 1 device pixel per CSS pixel: the biggest GPU saving on high-DPI laptops.
      renderer.setPixelRatio(level === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : 1)
      const size = renderer.getSize(new THREE.Vector2())
      renderer.setSize(size.x, size.y, false)
    },

    setKeeper(pose: KeeperPose | null): void {
      if (pose) {
        keeperPresent = true
        keeperTracked = pose.tracked
        gloveL.target.set(pose.left.x, pose.left.y, pose.left.z)
        gloveR.target.set(pose.right.x, pose.right.y, pose.right.z)
        torsoTopTarget.set(pose.torsoTop.x, pose.torsoTop.y, pose.torsoTop.z)
        torsoBottomTarget.set(pose.torsoBottom.x, pose.torsoBottom.y, pose.torsoBottom.z)
      } else {
        keeperPresent = false
        keeperTracked = false
        gloveL.target.copy(READY_LEFT)
        gloveR.target.copy(READY_RIGHT)
        torsoTopTarget.copy(READY_TOP)
        torsoBottomTarget.copy(READY_BOTTOM)
      }
    },

    setBall(p: Vec3, omega: Vec3, visible: boolean): void {
      const wasVisible = ball.visible
      ball.position.set(p.x, p.y, p.z)
      lastOmega.set(omega.x, omega.y, omega.z)
      if (visible && !wasVisible) {
        prevBallPos.copy(ball.position)
        resetTrail(ball.position)
        trailAlpha = 0
      }
      ball.visible = visible
    },

    setStriker(phase: StrikerPhase, progress: number, tell: StrikerTell): void {
      sPhase = phase
      sProgress = clamp(Number.isFinite(progress) ? progress : 0, 0, 1)
      sTell.side = tell.side
      sTell.high = tell.high
      updateArrow(phase, sProgress, tell)
    },

    flashSave(point: Vec3, part: KeeperPart, strength: number): void {
      const s = clamp(strength, 0, 1)
      const color = part === 'left' ? CYAN : part === 'right' ? MAGENTA : SAVE_GREEN
      // Few particles: a short burst plus one ring.
      spawnSparks(point, Math.round(10 + 22 * s), color, 3 + 5 * s)
      spawnRing(point, color, 0.7 + 0.7 * s, 0.45)
      if (part === 'left') gloveL.glow = 1
      else if (part === 'right') gloveR.glow = 1
      else torsoGlow = 1
      api.shake(0.18 + 0.45 * s)
    },

    flashGoal(point: Vec3): void {
      ripple.active = true
      ripple.t = 0
      ripple.x = clamp(point.x, -GOAL_HALF_WIDTH, GOAL_HALF_WIDTH)
      ripple.y = clamp(point.y, 0, GOAL_HEIGHT)
      frameFlash = 1
      const behind = { x: ripple.x, y: ripple.y, z: GOAL_Z + 0.9 }
      spawnSparks(behind, 18, RED, 3.5)
      spawnRing({ x: ripple.x, y: ripple.y, z: GOAL_Z }, RED, 1.3, 0.6)
      api.shake(0.55)
    },

    highlightZone(zone: Zone | null, tone: 'save' | 'goal' | 'info'): void {
      if (zone === null) {
        zoneCell.visible = false
        zoneMat.opacity = 0
        return
      }
      const row = Math.floor(zone / 3)
      const col = zone % 3
      zoneCell.position.set(-GOAL_HALF_WIDTH + (col + 0.5) * ZONE_W, GOAL_HEIGHT - (row + 0.5) * ZONE_H, GOAL_Z - 0.01)
      zoneMat.color.setHex(tone === 'save' ? SAVE_GREEN : tone === 'goal' ? RED : AMBER)
      zoneHl.peak = tone === 'info' ? 0.28 : 0.38
      zoneHl.t = 0
      zoneCell.visible = true
    },

    shake(intensity: number): void {
      shakeAmt = Math.max(shakeAmt, clamp(intensity, 0, 1))
    },

    screenToGoal(ndcX: number, ndcY: number): { x: number; y: number } {
      const origin = camera.position
      const dir = goalRay.set(clamp(ndcX, -1, 1), clamp(ndcY, -1, 1), 0.5).unproject(camera).sub(origin)
      let x = 0
      let y = 1.2
      if (Math.abs(dir.z) > 1e-6) {
        const t = (GOAL_Z - origin.z) / dir.z
        if (t > 0) {
          x = origin.x + dir.x * t
          y = origin.y + dir.y * t
        }
      }
      goalOut.x = clamp(x, -4.5, 4.5)
      goalOut.y = clamp(y, 0, 3.2)
      return goalOut
    },

    reset(): void {
      sparkLife.fill(0)
      sparkCol.fill(0)
      sparksAlive = 0
      sparks.visible = false
      sparkGeo.getAttribute('color').needsUpdate = true
      for (const r of rings) {
        r.active = false
        r.mesh.visible = false
      }
      ripple.active = false
      resetNet()
      zoneCell.visible = false
      zoneMat.opacity = 0
      frameFlash = 0
      updateFrame(0)
      shakeAmt = 0
      shakeOffset.set(0, 0, 0)
      gloveL.glow = gloveR.glow = 0
      torsoGlow = 0
      ball.visible = false
      ballShadow.visible = false
      trailAlpha = 0
      trail.visible = false
      lastOmega.set(0, 0, 0)
      sPhase = 'idle'
      sProgress = 0
      sTell.side = 0
      sTell.high = false
      heldLeanX = heldLeanZ = 0
      computeStrikerTargets()
      Object.assign(sCur, sTgt)
      sCur.x = STRIKER_START_X
      sCur.z = STRIKER_START_Z
      applyStriker()
    },

    update(dtMs: number): void {
      const dt = clamp(Number.isFinite(dtMs) ? dtMs : 0, 0, 50) / 1000
      time += dt
      keeperDim += ((keeperTracked ? 1 : 0.55) - keeperDim) * approach(8, dt)
      updateStriker(dt)
      updateGlove(gloveL, dt)
      updateGlove(gloveR, dt)
      updateTorso(dt)
      updateBall(dt)
      updateSparks(dt)
      updateRings(dt)
      updateNet(dt)
      updateFrame(dt)
      updateZone(dt)
      shakeAmt *= Math.exp(-dt * 5.5)
      if (shakeAmt < 0.002) shakeAmt = 0
      const a = shakeAmt * shakeAmt * 0.14 + shakeAmt * 0.04
      shakeOffset.set(
        a * (Math.sin(time * 61) + 0.6 * Math.sin(time * 37.3)),
        a * (Math.sin(time * 53.7 + 1.3) + 0.6 * Math.sin(time * 29.1)),
        0,
      )
    },

    render(): void {
      camera.position.add(shakeOffset)
      renderer.render(scene, camera)
      camera.position.sub(shakeOffset)
    },

    dispose(): void {
      const geos = new Set<THREE.BufferGeometry>()
      const mats = new Set<THREE.Material>()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) geos.add(m.geometry)
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => mats.add(x))
        else if (mat) mats.add(mat)
      })
      geos.forEach((g) => g.dispose())
      mats.forEach((m) => m.dispose())
      textures.forEach((t) => t.dispose())
      renderer.dispose()
      // dispose() keeps the GL context alive; without this each shell launch leaks one and the browser
      // starts killing contexts ("Too many active WebGL contexts") after ~16 launches.
      renderer.forceContextLoss()
      if (!canvas) cv.remove()
    },
  }

  const initW = cv.clientWidth || cv.width || 1280
  const initH = cv.clientHeight || cv.height || 720
  api.resize(initW, initH)
  api.reset()
  api.setKeeper(null)
  return api
}
