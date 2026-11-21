// Aero Bow: Three.js scene. Original cyber-arcade art from primitives and canvas textures.
// World frame and constants: see ./types.ts. The archer stands at the origin and shoots toward -z.
// Two passes: the range through a narrow archer lens, then the first-person bow through its own wide lens.

import * as THREE from 'three'
import type { ArcheryScene, Hand, Vec2, Vec3 } from './types.ts'
import { EYE, LAUNCH_POS, RING_COUNT, RING_WIDTH, TARGET_CENTER, TARGET_RADIUS, TARGET_Z } from './types.ts'

// ---------- palette (tile-archery.svg) ----------
const NIGHT = 0x0c1124
const GOLD = 0xffb800
const LIME = 0xc8ff00
const CYAN = 0x00f0ff
const MAGENTA = 0xff2a85
const PALE = 0xb6c2e2
const FOG = 0x110f1d

// ---------- cameras ----------
/** Vertical FOV of the archer lens: the 2 m face at 25 m fills about 30% of the height. */
const ARCHER_FOV = 15
/** Half width at the target plane that must stay visible on narrow screens. */
const ARCHER_MIN_HALF_W = 3.0
const BOW_FOV = 55
const FOLLOW_FOV = 34
const IMPACT_FOV = 30

// ---------- layout ----------
const LANE_HALF = 2.1
const BACKSTOP_Z = TARGET_Z - 2.6
const MARKERS = [5, 10, 15, 20]
const FLAGS: ReadonlyArray<{ x: number; z: number; h: number; len: number; color: number }> = [
  { x: -1.85, z: -8.5, h: 2.35, len: 0.8, color: MAGENTA },
  { x: 1.85, z: -8.5, h: 2.35, len: 0.8, color: MAGENTA },
  { x: -2.75, z: -17, h: 3.1, len: 1.05, color: CYAN },
  { x: 2.75, z: -17, h: 3.1, len: 1.05, color: CYAN },
]
const RIBBON_SEG = 12

// ---------- arrow ----------
const ARROW_LEN = 0.76
const SHAFT_R = 0.0068
/** Flying arrow fades in over this distance from LAUNCH_POS. */
const FADE_IN_M = 1.5
const TRAIL_N = 26
const TRAIL_STEP = 0.06
const MAX_STUCK = 40

// ---------- bow (bow-camera space) ----------
const DRAW_LEN = 0.44
const BRACE_Z = -0.2

const TAU = Math.PI * 2
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)
const clamp01 = (v: number): number => clamp(Number.isFinite(v) ? v : 0, 0, 1)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const smooth = (t: number): number => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}
const easeOut = (t: number): number => {
  const x = 1 - clamp(t, 0, 1)
  return 1 - x * x * x
}
/** Frame-rate independent approach factor. */
const approach = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt)

/** Ring fill colours from the outside (score 1) to the centre (score 10). */
const RING_FILL = ['#8d99be', '#b6c2e2', '#141a33', '#1c2342', '#0094ad', '#00d2e8', '#b81c60', '#ff2a85', '#ffb800', '#c8ff00']
/** Flash colour per score. */
const RING_FLASH = [PALE, PALE, 0x7f8cff, 0x7f8cff, CYAN, CYAN, MAGENTA, MAGENTA, GOLD, LIME]

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (g) draw(g)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function makeDotTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    grd.addColorStop(0, 'rgba(255,255,255,1)')
    grd.addColorStop(0.3, 'rgba(255,255,255,0.65)')
    grd.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, 64, 64)
  })
}

/** Dome texture: canvas row maps to elevation (top = zenith, middle = horizon). */
function makeSkyTexture(): THREE.CanvasTexture {
  const H = 2048
  return canvasTexture(4, H, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, H)
    const stop = (elev: number, color: string): void => grd.addColorStop(clamp((90 - elev) / 180, 0, 1), color)
    stop(90, '#03040a')
    stop(30, '#060916')
    stop(12, '#0b1024')
    stop(6, '#14142e')
    stop(3.2, '#241a36')
    stop(1.6, '#3d2430')
    stop(0.6, '#5c3519')
    stop(0, '#6a3f14')
    stop(-0.6, '#2e1d10')
    stop(-4, '#100e18')
    stop(-90, '#04050a')
    g.fillStyle = grd
    g.fillRect(0, 0, 4, H)
  })
}

function makeGlowTexture(inner: string, mid: string): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g) => {
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128)
    grd.addColorStop(0, inner)
    grd.addColorStop(0.45, mid)
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, 256, 256)
  })
}

/** Neon re-style of a 10 ring face. UVs of CircleGeometry map the full square onto the disc. */
function makeFaceTexture(): THREE.CanvasTexture {
  const S = 1024
  const C = S / 2
  return canvasTexture(S, S, (g) => {
    g.clearRect(0, 0, S, S)
    const rOf = (score: number): number => (C * (RING_COUNT - score + 1)) / RING_COUNT
    for (let s = 1; s <= RING_COUNT; s++) {
      g.beginPath()
      g.arc(C, C, rOf(s), 0, TAU)
      g.fillStyle = RING_FILL[s - 1]
      g.fill()
    }
    // subtle radial sheen so the face does not read as flat plastic
    const sheen = g.createRadialGradient(C * 0.8, C * 0.7, 0, C, C, C)
    sheen.addColorStop(0, 'rgba(255,255,255,0.10)')
    sheen.addColorStop(0.6, 'rgba(255,255,255,0)')
    sheen.addColorStop(1, 'rgba(0,0,10,0.18)')
    g.fillStyle = sheen
    g.beginPath()
    g.arc(C, C, C, 0, TAU)
    g.fill()
    // ring lines: glow on colour group borders, thin dividers inside a group
    for (let s = 2; s <= RING_COUNT; s++) {
      const r = rOf(s)
      const groupEdge = s === 3 || s === 5 || s === 7 || s === 9 || s === 10
      g.beginPath()
      g.arc(C, C, r, 0, TAU)
      if (s <= 2) {
        g.strokeStyle = 'rgba(20,26,51,0.8)'
        g.lineWidth = 3
        g.shadowBlur = 0
      } else if (groupEdge) {
        g.strokeStyle = 'rgba(240,248,255,0.85)'
        g.lineWidth = 3.5
        g.shadowColor = s >= 9 ? '#fff2b2' : '#9ff8ff'
        g.shadowBlur = 10
      } else {
        g.strokeStyle = 'rgba(220,235,255,0.5)'
        g.lineWidth = 2
        g.shadowBlur = 0
      }
      g.stroke()
    }
    g.shadowBlur = 0
    // centre pin mark
    g.strokeStyle = 'rgba(20,30,0,0.55)'
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(C - 10, C)
    g.lineTo(C + 10, C)
    g.moveTo(C, C - 10)
    g.lineTo(C, C + 10)
    g.stroke()
    // outer neon rim
    g.beginPath()
    g.arc(C, C, C - 5, 0, TAU)
    g.strokeStyle = '#00f0ff'
    g.lineWidth = 8
    g.shadowColor = '#00f0ff'
    g.shadowBlur = 14
    g.stroke()
  })
}

function makeLabelTexture(text: string): THREE.CanvasTexture {
  return canvasTexture(256, 128, (g) => {
    g.clearRect(0, 0, 256, 128)
    g.fillStyle = 'rgba(0,240,255,0.10)'
    g.strokeStyle = 'rgba(0,240,255,0.9)'
    g.lineWidth = 4
    g.beginPath()
    g.moveTo(18, 8)
    g.lineTo(248, 8)
    g.lineTo(248, 100)
    g.lineTo(230, 120)
    g.lineTo(8, 120)
    g.lineTo(8, 26)
    g.closePath()
    g.fill()
    g.stroke()
    g.font = 'bold 76px "Bebas Neue", "Arial Narrow", Arial, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.shadowColor = '#00f0ff'
    g.shadowBlur = 12
    g.fillStyle = '#e6fdff'
    g.fillText(text, 128, 68)
  })
}

function makeBackstopTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 256, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 256)
    grd.addColorStop(0, '#121733')
    grd.addColorStop(1, '#080a16')
    g.fillStyle = grd
    g.fillRect(0, 0, 512, 256)
    // hex padding pattern
    g.strokeStyle = 'rgba(120,90,255,0.09)'
    g.lineWidth = 2
    const r = 18
    const w = r * Math.sqrt(3)
    for (let row = -1; row < 12; row++) {
      for (let col = -1; col < 18; col++) {
        const cx = col * w + (row % 2 ? w / 2 : 0)
        const cy = row * r * 1.5
        g.beginPath()
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 6 + (k * Math.PI) / 3
          const x = cx + r * Math.cos(a)
          const y = cy + r * Math.sin(a)
          if (k === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.closePath()
        g.stroke()
      }
    }
  })
}

/** Tapered, flattened tube for a bow limb. */
function makeLimbGeometry(curve: THREE.CatmullRomCurve3, radius: number, rootK: number, tipK: number): THREE.TubeGeometry {
  const TS = 20
  const RS = 6
  const geo = new THREE.TubeGeometry(curve, TS, radius, RS, false)
  const pos = geo.getAttribute('position')
  const p = new THREE.Vector3()
  const v = new THREE.Vector3()
  for (let i = 0; i <= TS; i++) {
    curve.getPointAt(i / TS, p)
    const k = lerp(rootK, tipK, i / TS)
    for (let j = 0; j <= RS; j++) {
      const idx = i * (RS + 1) + j
      v.fromBufferAttribute(pos, idx).sub(p)
      v.x *= 1.8 * k
      v.y *= k
      v.z *= 0.7 * k
      pos.setXYZ(idx, p.x + v.x, p.y + v.y, p.z + v.z)
    }
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

interface Particles {
  points: THREE.Points
  pos: Float32Array
  col: Float32Array
  vel: Float32Array
  base: Float32Array
  life: Float32Array
  max: Float32Array
  n: number
  cursor: number
  alive: boolean
  gravity: number
  drag: number
}

interface Flash {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  t: number
  dur: number
  active: boolean
  wave: boolean
  from: number
  to: number
  peak: number
}

interface Flag {
  pos: Float32Array
  geo: THREE.BufferGeometry
  x: number
  top: number
  z: number
  len: number
  phase: number
}

interface Streak {
  x: number
  y: number
  z: number
  speed: number
  len: number
}

export function createArcheryScene(): ArcheryScene {
  const cv = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.autoClear = false
  renderer.setClearColor(NIGHT, 1)
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy())

  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // every GPU resource goes through these so dispose() frees all of them
  const geos = new Set<THREE.BufferGeometry>()
  const mats = new Set<THREE.Material>()
  const texs = new Set<THREE.Texture>()
  const G = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.add(g)
    return g
  }
  const M = <T extends THREE.Material>(m: T): T => {
    mats.add(m)
    return m
  }
  const TX = <T extends THREE.Texture>(t: T): T => {
    texs.add(t)
    return t
  }
  const additive = (color: number, opacity: number, extra: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial =>
    M(
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        ...extra,
      }),
    )

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(FOG, 36, 150)

  const archerLook = new THREE.Vector3(TARGET_CENTER.x, TARGET_CENTER.y, TARGET_Z)
  const archerCam = new THREE.PerspectiveCamera(ARCHER_FOV, 16 / 9, 0.1, 900)
  archerCam.position.set(EYE.x, EYE.y, EYE.z)
  archerCam.lookAt(archerLook)
  // never rendered, so its world matrix must be kept current by hand for screenToTarget
  archerCam.updateMatrixWorld(true)
  const viewCam = new THREE.PerspectiveCamera(ARCHER_FOV, 16 / 9, 0.1, 900)
  viewCam.position.copy(archerCam.position)
  viewCam.lookAt(archerLook)
  let archerFov = ARCHER_FOV

  const dotTex = TX(makeDotTexture())

  // ---------- sky ----------
  {
    const skyTex = TX(makeSkyTexture())
    const sky = new THREE.Mesh(
      G(new THREE.SphereGeometry(500, 32, 90)),
      M(new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false })),
    )
    sky.renderOrder = -10
    scene.add(sky)

    // warm aura behind the target (tile radial gradient)
    const auraTex = TX(makeGlowTexture('rgba(255,184,0,0.55)', 'rgba(255,120,40,0.16)'))
    const aura = new THREE.Mesh(
      G(new THREE.PlaneGeometry(1, 1)),
      M(
        new THREE.MeshBasicMaterial({
          map: auraTex,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
          opacity: 0.55,
        }),
      ),
    )
    aura.scale.set(380, 70, 1)
    aura.position.set(0, 2, -440)
    aura.renderOrder = -9
    scene.add(aura)

    // stars
    const starN = 160
    const sp = new Float32Array(starN * 3)
    for (let i = 0; i < starN; i++) {
      const az = (Math.random() - 0.5) * 2.4
      const el = (1.5 + Math.random() * Math.random() * 40) * (Math.PI / 180)
      const R = 480
      sp[i * 3] = Math.sin(az) * Math.cos(el) * R
      sp[i * 3 + 1] = Math.sin(el) * R
      sp[i * 3 + 2] = -Math.cos(az) * Math.cos(el) * R
    }
    const sg = G(new THREE.BufferGeometry())
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3))
    const stars = new THREE.Points(
      sg,
      M(
        new THREE.PointsMaterial({
          color: PALE,
          size: 1.6,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.6,
          fog: false,
          depthWrite: false,
        }),
      ),
    )
    stars.renderOrder = -8
    scene.add(stars)

    // distant ridge silhouettes with a faint gold rim
    const K = 220
    const R = 320
    const verts: number[] = []
    const rim: number[] = []
    const idx: number[] = []
    for (let k = 0; k <= K; k++) {
      const a = -1.9 + (3.8 * k) / K
      const h =
        3 +
        2.6 * Math.sin(a * 7.3 + 1.1) +
        1.8 * Math.sin(a * 17.1 + 0.4) +
        0.9 * Math.sin(a * 41.7) +
        (Math.abs(a) < 0.12 ? -2.5 : 0)
      const hh = Math.max(0.6, h)
      const x = Math.sin(a) * R
      const z = -Math.cos(a) * R
      verts.push(x, -6, z, x, hh, z)
      rim.push(x, hh + 0.05, z)
      if (k < K) {
        const b = k * 2
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3)
      }
    }
    const rg = G(new THREE.BufferGeometry())
    rg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    rg.setIndex(idx)
    const ridge = new THREE.Mesh(rg, M(new THREE.MeshBasicMaterial({ color: 0x0b0b18, fog: false, side: THREE.DoubleSide })))
    ridge.renderOrder = -7
    scene.add(ridge)
    const rlg = G(new THREE.BufferGeometry())
    rlg.setAttribute('position', new THREE.Float32BufferAttribute(rim, 3))
    const rimLine = new THREE.Line(
      rlg,
      M(new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0.35, fog: false, depthWrite: false })),
    )
    rimLine.renderOrder = -6
    scene.add(rimLine)
  }

  // ---------- floor ----------
  {
    const ground = new THREE.Mesh(G(new THREE.PlaneGeometry(1000, 1000)), M(new THREE.MeshBasicMaterial({ color: 0x070914 })))
    ground.rotation.x = -Math.PI / 2
    scene.add(ground)

    const gp: number[] = []
    const gc: number[] = []
    const cLong = new THREE.Color(0x0a5f78)
    const cCross = new THREE.Color(0x3b2a72)
    const line = (x1: number, z1: number, x2: number, z2: number, c: THREE.Color): void => {
      gp.push(x1, 0.002, z1, x2, 0.002, z2)
      gc.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
    for (let x = -60; x <= 60; x += 2.5) line(x, 6, x, -240, cLong)
    for (let z = 5; z >= -240; z -= 2.5) line(-60, z, 60, z, cCross)
    const gg = G(new THREE.BufferGeometry())
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3))
    gg.setAttribute('color', new THREE.Float32BufferAttribute(gc, 3))
    scene.add(new THREE.LineSegments(gg, M(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 }))))

    // lane: dark strip with glowing edges
    const laneLen = -TARGET_Z + 6
    const lane = new THREE.Mesh(G(new THREE.PlaneGeometry(LANE_HALF * 2, laneLen)), M(new THREE.MeshBasicMaterial({ color: 0x0a0e20 })))
    lane.rotation.x = -Math.PI / 2
    lane.position.set(0, 0.004, -laneLen / 2 + 1)
    scene.add(lane)
    const edgeGeo = G(new THREE.PlaneGeometry(0.05, laneLen))
    const haloGeo = G(new THREE.PlaneGeometry(0.4, laneLen))
    const edgeMat = additive(CYAN, 0.9)
    const edgeHaloMat = additive(CYAN, 0.12)
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(edgeGeo, edgeMat)
      e.rotation.x = -Math.PI / 2
      e.position.set(sx * LANE_HALF, 0.006, lane.position.z)
      scene.add(e)
      const h = new THREE.Mesh(haloGeo, edgeHaloMat)
      h.rotation.x = -Math.PI / 2
      h.position.set(sx * LANE_HALF, 0.005, lane.position.z)
      scene.add(h)
    }
    // shooting line
    const shoot = new THREE.Mesh(G(new THREE.PlaneGeometry(LANE_HALF * 2, 0.06)), additive(LIME, 0.8))
    shoot.rotation.x = -Math.PI / 2
    shoot.position.set(0, 0.007, -0.6)
    scene.add(shoot)

    // distance markers: floor line plus a holo plate on both sides
    const crossGeo = G(new THREE.PlaneGeometry(LANE_HALF * 2, 0.035))
    const crossMat = additive(PALE, 0.35)
    const plateGeo = G(new THREE.PlaneGeometry(0.44, 0.22))
    const postGeo = G(new THREE.BoxGeometry(0.02, 0.2, 0.02))
    const postMat = M(new THREE.MeshBasicMaterial({ color: 0x1d2547 }))
    const padGeo = G(new THREE.CircleGeometry(0.16, 20))
    const padMat = additive(CYAN, 0.25)
    for (const d of MARKERS) {
      const c = new THREE.Mesh(crossGeo, crossMat)
      c.rotation.x = -Math.PI / 2
      c.position.set(0, 0.006, -d)
      scene.add(c)
      const tex = TX(makeLabelTexture(`${d} M`))
      const plateMat = M(
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.95 }),
      )
      for (const sx of [-1, 1]) {
        // near plates sit wider so the archer lens never clips them at the screen edge
        const x = sx * (LANE_HALF + (d <= 10 ? 0.62 : 0.36))
        const plate = new THREE.Mesh(plateGeo, plateMat)
        plate.position.set(x, 0.31, -d)
        plate.rotation.y = -sx * 0.18
        scene.add(plate)
        const post = new THREE.Mesh(postGeo, postMat)
        post.position.set(x, 0.1, -d)
        scene.add(post)
        const pad = new THREE.Mesh(padGeo, padMat)
        pad.rotation.x = -Math.PI / 2
        pad.position.set(x, 0.008, -d)
        scene.add(pad)
      }
    }
  }

  // ---------- backstop ----------
  {
    const W = 6.8
    const H = 2.9
    const tex = TX(makeBackstopTexture())
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(2.3, 1)
    const wall = new THREE.Mesh(G(new THREE.PlaneGeometry(W, H)), M(new THREE.MeshBasicMaterial({ map: tex })))
    wall.position.set(0, H / 2, BACKSTOP_Z)
    scene.add(wall)
    const frameMat = M(new THREE.MeshBasicMaterial({ color: 0x151b38 }))
    const pillarGeo = G(new THREE.BoxGeometry(0.22, H + 0.3, 0.3))
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(pillarGeo, frameMat)
      p.position.set(sx * (W / 2 + 0.11), (H + 0.3) / 2, BACKSTOP_Z + 0.05)
      scene.add(p)
    }
    const topGeo = G(new THREE.PlaneGeometry(W + 0.44, 0.05))
    const top = new THREE.Mesh(topGeo, additive(GOLD, 0.85))
    top.position.set(0, H + 0.02, BACKSTOP_Z + 0.21)
    scene.add(top)
    const topHalo = new THREE.Mesh(G(new THREE.PlaneGeometry(W + 0.44, 0.22)), additive(GOLD, 0.06))
    topHalo.position.set(0, H + 0.02, BACKSTOP_Z + 0.2)
    scene.add(topHalo)
    const low = new THREE.Mesh(G(new THREE.PlaneGeometry(W, 0.03)), additive(MAGENTA, 0.6))
    low.position.set(0, 0.35, BACKSTOP_Z + 0.02)
    scene.add(low)
    const footGlow = new THREE.Mesh(G(new THREE.PlaneGeometry(W, 1.4)), additive(MAGENTA, 0.08))
    footGlow.rotation.x = -Math.PI / 2
    footGlow.position.set(0, 0.009, BACKSTOP_Z + 0.75)
    scene.add(footGlow)
  }

  // ---------- target ----------
  const targetGroup = new THREE.Group()
  targetGroup.position.set(TARGET_CENTER.x, TARGET_CENTER.y, TARGET_Z)
  scene.add(targetGroup)
  const standGroup = new THREE.Group()
  standGroup.position.set(TARGET_CENTER.x, 0, TARGET_Z)
  scene.add(standGroup)
  const haloMat = M(
    new THREE.MeshBasicMaterial({
      map: TX(makeGlowTexture('rgba(255,200,60,0.6)', 'rgba(255,184,0,0.18)')),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.5,
    }),
  )
  let haloFlare = 0
  {
    const faceTex = TX(makeFaceTexture())
    faceTex.anisotropy = maxAniso
    const face = new THREE.Mesh(G(new THREE.CircleGeometry(TARGET_RADIUS, 96)), M(new THREE.MeshBasicMaterial({ map: faceTex })))
    face.position.z = 0.001
    targetGroup.add(face)
    const boss = new THREE.Mesh(
      G(new THREE.CylinderGeometry(TARGET_RADIUS * 1.07, TARGET_RADIUS * 1.07, 0.32, 64)),
      M(new THREE.MeshBasicMaterial({ color: 0x0d1226 })),
    )
    boss.rotation.x = Math.PI / 2
    boss.position.z = -0.16
    targetGroup.add(boss)
    const rimGlow = new THREE.Mesh(G(new THREE.RingGeometry(TARGET_RADIUS * 1.0, TARGET_RADIUS * 1.075, 96)), additive(CYAN, 0.55))
    rimGlow.position.z = 0.002
    targetGroup.add(rimGlow)
    const halo = new THREE.Mesh(G(new THREE.PlaneGeometry(4.2, 4.2)), haloMat)
    halo.position.z = -0.4
    halo.renderOrder = -1
    targetGroup.add(halo)

    // stand: A-frame legs, cross bar, glowing base pads
    const legMat = M(new THREE.MeshBasicMaterial({ color: 0x1a2142 }))
    const legGeo = G(new THREE.BoxGeometry(0.07, 1.9, 0.07))
    const trimMat = additive(CYAN, 0.7)
    const trimGeo = G(new THREE.BoxGeometry(0.012, 1.8, 0.012))
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, legMat)
      leg.position.set(sx * 0.55, 0.9, -0.42)
      leg.rotation.z = sx * 0.22
      standGroup.add(leg)
      const trim = new THREE.Mesh(trimGeo, trimMat)
      trim.position.set(sx * 0.55, 0.9, -0.38)
      trim.rotation.z = sx * 0.22
      standGroup.add(trim)
      const pad = new THREE.Mesh(G(new THREE.CircleGeometry(0.2, 20)), additive(CYAN, 0.3))
      pad.rotation.x = -Math.PI / 2
      pad.position.set(sx * 0.76, 0.01, -0.42)
      standGroup.add(pad)
    }
    const bar = new THREE.Mesh(G(new THREE.BoxGeometry(1.2, 0.06, 0.06)), legMat)
    bar.position.set(0, 0.45, -0.42)
    standGroup.add(bar)
    const floorGlow = new THREE.Mesh(G(new THREE.CircleGeometry(1, 40)), additive(CYAN, 0.07))
    floorGlow.rotation.x = -Math.PI / 2
    floorGlow.scale.set(1.6, 0.9, 1)
    floorGlow.position.set(0, 0.008, 0.2)
    standGroup.add(floorGlow)
  }
  const stuckGroup = new THREE.Group()
  targetGroup.add(stuckGroup)
  const missGroup = new THREE.Group()
  scene.add(missGroup)

  // ---------- arrow parts (shared) ----------
  const shaftGeo = G(new THREE.CylinderGeometry(SHAFT_R, SHAFT_R, ARROW_LEN - 0.04, 6))
  shaftGeo.rotateX(Math.PI / 2)
  shaftGeo.translate(0, 0, -ARROW_LEN / 2 - 0.0)
  const shaftGlowGeo = G(new THREE.CylinderGeometry(SHAFT_R * 3.4, SHAFT_R * 3.4, ARROW_LEN - 0.04, 6, 1, true))
  shaftGlowGeo.rotateX(Math.PI / 2)
  shaftGlowGeo.translate(0, 0, -ARROW_LEN / 2)
  const headGeo = G(new THREE.ConeGeometry(SHAFT_R * 2.1, 0.055, 6))
  headGeo.rotateX(Math.PI / 2)
  headGeo.translate(0, 0, -0.0)
  const nockGeo = G(new THREE.SphereGeometry(SHAFT_R * 1.7, 8, 6))
  nockGeo.translate(0, 0, -ARROW_LEN)
  const vaneGeo = G(new THREE.BufferGeometry())
  {
    const r = SHAFT_R
    const t0 = -ARROW_LEN + 0.02
    const v = [0, r, t0, 0, r + 0.042, t0 + 0.005, 0, r + 0.022, t0 + 0.09, 0, r, t0 + 0.15]
    vaneGeo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
    vaneGeo.setIndex([0, 1, 2, 0, 2, 3])
    vaneGeo.computeVertexNormals()
  }
  const arrowMats = {
    shaft: M(new THREE.MeshBasicMaterial({ color: 0xa8d400 })),
    head: M(new THREE.MeshBasicMaterial({ color: 0xf4fbff })),
    vane: M(new THREE.MeshBasicMaterial({ color: CYAN, side: THREE.DoubleSide })),
    nock: M(new THREE.MeshBasicMaterial({ color: LIME })),
    glow: additive(LIME, 0.28),
  }
  const nockSpriteMat = M(
    new THREE.SpriteMaterial({ map: dotTex, color: 0xe8ffa0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95 }),
  )
  type ArrowMats = typeof arrowMats
  const buildArrow = (m: ArrowMats, glow: boolean, nockGlow: number): THREE.Group => {
    const g = new THREE.Group()
    g.add(new THREE.Mesh(shaftGeo, m.shaft))
    g.add(new THREE.Mesh(headGeo, m.head))
    g.add(new THREE.Mesh(nockGeo, m.nock))
    for (let k = 0; k < 3; k++) {
      const vane = new THREE.Mesh(vaneGeo, m.vane)
      vane.rotation.z = (k * TAU) / 3
      g.add(vane)
    }
    if (glow) g.add(new THREE.Mesh(shaftGlowGeo, m.glow))
    if (nockGlow > 0) {
      const s = new THREE.Sprite(nockSpriteMat)
      s.position.z = -ARROW_LEN + 0.04
      s.scale.setScalar(nockGlow)
      g.add(s)
    }
    return g
  }
  const Z_AXIS = new THREE.Vector3(0, 0, 1)
  const UP = new THREE.Vector3(0, 1, 0)
  const tmpV = new THREE.Vector3()
  const tmpV2 = new THREE.Vector3()
  const tmpC = new THREE.Color()
  const dirOf = (d: Vec3, out: THREE.Vector3): THREE.Vector3 => {
    out.set(d.x, d.y, d.z)
    if (out.lengthSq() < 1e-9) out.set(0, 0, -1)
    return out.normalize()
  }

  // ---------- flying arrow + trail ----------
  const flyMats: ArrowMats = {
    shaft: M(arrowMats.shaft.clone()),
    head: M(arrowMats.head.clone()),
    vane: M(arrowMats.vane.clone()),
    nock: M(arrowMats.nock.clone()),
    glow: M(arrowMats.glow.clone()),
  }
  for (const m of [flyMats.shaft, flyMats.head, flyMats.vane, flyMats.nock]) m.transparent = true
  const flyArrow = buildArrow(flyMats, true, 0)
  const flyTipGlowMat = M(
    new THREE.SpriteMaterial({ map: dotTex, color: LIME, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  )
  const flyTipGlow = new THREE.Sprite(flyTipGlowMat)
  flyTipGlow.scale.setScalar(0.16)
  flyTipGlow.position.z = -0.3
  flyArrow.add(flyTipGlow)
  flyArrow.visible = false
  scene.add(flyArrow)
  const flyDir = new THREE.Vector3(0, 0, -1)
  let flyFade = 0

  const trailPos = new Float32Array(TRAIL_N * 3)
  const trailCol = new Float32Array(TRAIL_N * 3)
  const trailPosAttr = new THREE.BufferAttribute(trailPos, 3)
  const trailColAttr = new THREE.BufferAttribute(trailCol, 3)
  const trailPtsGeo = G(new THREE.BufferGeometry())
  trailPtsGeo.setAttribute('position', trailPosAttr)
  trailPtsGeo.setAttribute('color', trailColAttr)
  const trailLineGeo = G(new THREE.BufferGeometry())
  trailLineGeo.setAttribute('position', trailPosAttr)
  trailLineGeo.setAttribute('color', trailColAttr)
  const trailPts = new THREE.Points(
    trailPtsGeo,
    M(
      new THREE.PointsMaterial({
        size: 0.07,
        map: dotTex,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  )
  const trailLine = new THREE.Line(
    trailLineGeo,
    M(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })),
  )
  for (const o of [trailPts, trailLine]) {
    o.frustumCulled = false
    o.visible = false
    scene.add(o)
  }
  let trailCount = 0
  let trailAlpha = 0
  const trailHead = new THREE.Vector3()
  const trailTint = new THREE.Color(LIME)
  const trailTail = new THREE.Color(CYAN)
  const resetTrail = (p: THREE.Vector3): void => {
    for (let i = 0; i < TRAIL_N; i++) {
      trailPos[i * 3] = p.x
      trailPos[i * 3 + 1] = p.y
      trailPos[i * 3 + 2] = p.z
    }
    trailHead.copy(p)
    trailCount = 1
    trailPosAttr.needsUpdate = true
  }
  const pushTrail = (p: THREE.Vector3): void => {
    // insert points every TRAIL_STEP so the trail length is fixed whatever the frame step
    const d = trailHead.distanceTo(p)
    if (d < TRAIL_STEP) return
    const steps = Math.min(TRAIL_N, Math.floor(d / TRAIL_STEP))
    tmpV2.copy(p).sub(trailHead).divideScalar(d)
    const start = d - steps * TRAIL_STEP
    for (let s = 0; s < steps; s++) {
      trailPos.copyWithin(3, 0, (TRAIL_N - 1) * 3)
      const k = start + (s + 1) * TRAIL_STEP
      trailPos[0] = trailHead.x + tmpV2.x * k
      trailPos[1] = trailHead.y + tmpV2.y * k
      trailPos[2] = trailHead.z + tmpV2.z * k
    }
    trailHead.set(trailPos[0], trailPos[1], trailPos[2])
    trailCount = Math.min(TRAIL_N, trailCount + steps)
    trailPosAttr.needsUpdate = true
  }

  // ---------- particles ----------
  const makeParticles = (n: number, size: number, gravity: number, drag: number): Particles => {
    const pos = new Float32Array(n * 3)
    const col = new Float32Array(n * 3)
    const geo = G(new THREE.BufferGeometry())
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const points = new THREE.Points(
      geo,
      M(
        new THREE.PointsMaterial({
          size,
          map: dotTex,
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    )
    points.frustumCulled = false
    points.visible = false
    scene.add(points)
    return {
      points,
      pos,
      col,
      vel: new Float32Array(n * 3),
      base: new Float32Array(n * 3),
      life: new Float32Array(n),
      max: new Float32Array(n).fill(1),
      n,
      cursor: 0,
      alive: false,
      gravity,
      drag,
    }
  }
  const sparks = makeParticles(reduced ? 80 : 220, 0.07, 5.5, 1.6)
  const dust = makeParticles(reduced ? 24 : 64, 0.42, -0.25, 2.2)
  const spawn = (
    ps: Particles,
    p: THREE.Vector3,
    count: number,
    color: number,
    speed: number,
    bias: THREE.Vector3,
    life: number,
    whiteChance: number,
  ): void => {
    const n = reduced ? Math.ceil(count * 0.4) : count
    tmpC.set(color)
    for (let c = 0; c < n; c++) {
      const i = ps.cursor
      ps.cursor = (ps.cursor + 1) % ps.n
      const u = Math.random() * 2 - 1
      const a = Math.random() * TAU
      const s = Math.sqrt(1 - u * u)
      const sp = speed * (0.35 + Math.random() * 0.75)
      ps.pos[i * 3] = p.x
      ps.pos[i * 3 + 1] = p.y
      ps.pos[i * 3 + 2] = p.z
      ps.vel[i * 3] = s * Math.cos(a) * sp + bias.x * speed
      ps.vel[i * 3 + 1] = u * sp + bias.y * speed
      ps.vel[i * 3 + 2] = s * Math.sin(a) * sp + bias.z * speed
      const l = life * (0.6 + Math.random() * 0.7)
      ps.life[i] = l
      ps.max[i] = l
      const w = Math.random() < whiteChance ? 0.8 : 0
      ps.base[i * 3] = tmpC.r + (1 - tmpC.r) * w
      ps.base[i * 3 + 1] = tmpC.g + (1 - tmpC.g) * w
      ps.base[i * 3 + 2] = tmpC.b + (1 - tmpC.b) * w
    }
    ps.alive = true
    ps.points.visible = true
  }
  const updateParticles = (ps: Particles, dt: number): void => {
    if (!ps.alive) return
    let any = false
    const dk = Math.exp(-ps.drag * dt)
    for (let i = 0; i < ps.n; i++) {
      if (ps.life[i] <= 0) continue
      ps.life[i] -= dt
      const j = i * 3
      if (ps.life[i] <= 0) {
        ps.col[j] = ps.col[j + 1] = ps.col[j + 2] = 0
        continue
      }
      any = true
      ps.vel[j] *= dk
      ps.vel[j + 1] = ps.vel[j + 1] * dk - ps.gravity * dt
      ps.vel[j + 2] *= dk
      ps.pos[j] += ps.vel[j] * dt
      ps.pos[j + 1] = Math.max(0.01, ps.pos[j + 1] + ps.vel[j + 1] * dt)
      ps.pos[j + 2] += ps.vel[j + 2] * dt
      const k = ps.life[i] / ps.max[i]
      const b = k * k
      ps.col[j] = ps.base[j] * b
      ps.col[j + 1] = ps.base[j + 1] * b
      ps.col[j + 2] = ps.base[j + 2] * b
    }
    ps.points.geometry.getAttribute('position').needsUpdate = true
    ps.points.geometry.getAttribute('color').needsUpdate = true
    if (!any) {
      ps.alive = false
      ps.points.visible = false
    }
  }
  const clearParticles = (ps: Particles): void => {
    ps.life.fill(0)
    ps.col.fill(0)
    ps.alive = false
    ps.points.visible = false
  }

  // ---------- ring flashes and shock waves (children of the target group) ----------
  const ringGeos: THREE.BufferGeometry[] = []
  for (let s = 1; s <= RING_COUNT; s++) {
    const inner = (RING_COUNT - s) * RING_WIDTH
    const outer = (RING_COUNT - s + 1) * RING_WIDTH
    ringGeos.push(
      G(s === RING_COUNT ? new THREE.CircleGeometry(outer, 40) : new THREE.RingGeometry(inner, outer, 96)),
    )
  }
  const waveGeo = G(new THREE.RingGeometry(0.9, 1, 80))
  const flashes: Flash[] = []
  for (let i = 0; i < 8; i++) {
    const mat = additive(GOLD, 0, { side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(waveGeo, mat)
    mesh.visible = false
    mesh.renderOrder = 4
    targetGroup.add(mesh)
    flashes.push({ mesh, mat, t: 0, dur: 1, active: false, wave: false, from: 1, to: 1, peak: 1 })
  }
  let flashCursor = 0
  const spawnFlash = (
    geo: THREE.BufferGeometry,
    local: THREE.Vector3,
    color: number,
    dur: number,
    peak: number,
    wave: boolean,
    from: number,
    to: number,
  ): void => {
    const f = flashes[flashCursor]
    flashCursor = (flashCursor + 1) % flashes.length
    f.mesh.geometry = geo
    f.mesh.position.copy(local)
    f.mat.color.set(color)
    f.t = 0
    f.dur = dur
    f.peak = peak
    f.wave = wave
    f.from = from
    f.to = to
    f.active = true
    f.mesh.visible = true
    f.mesh.scale.setScalar(wave ? from : 1)
  }
  const updateFlashes = (dt: number): void => {
    for (const f of flashes) {
      if (!f.active) continue
      f.t += dt
      const u = f.t / f.dur
      if (u >= 1) {
        f.active = false
        f.mesh.visible = false
        continue
      }
      if (f.wave) {
        f.mesh.scale.setScalar(lerp(f.from, f.to, easeOut(u)))
        f.mat.opacity = f.peak * (1 - u) * (1 - u)
      } else {
        // fast blink then fade
        const blink = u < 0.35 ? 0.75 + 0.25 * Math.cos(u * 60) : 1
        f.mat.opacity = f.peak * (1 - smooth(u)) * blink
      }
    }
  }

  // ---------- reticle ----------
  const reticle = new THREE.Group()
  reticle.visible = false
  reticle.renderOrder = 20
  scene.add(reticle)
  const retMat = M(new THREE.MeshBasicMaterial({ color: LIME, transparent: true, depthTest: false, depthWrite: false, fog: false }))
  const retShadowMat = M(
    new THREE.MeshBasicMaterial({ color: 0x050816, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false, fog: false }),
  )
  const retSpin = new THREE.Group()
  {
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, order: number, parent: THREE.Object3D, z = 0): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat)
      m.renderOrder = order
      m.position.z = z
      parent.add(m)
      return m
    }
    add(G(new THREE.RingGeometry(0.82, 1.1, 64)), retShadowMat, 20, reticle)
    add(G(new THREE.RingGeometry(0.9, 1.0, 64)), retMat, 21, reticle, 0.001)
    add(G(new THREE.CircleGeometry(0.07, 16)), retMat, 21, reticle, 0.001)
    const tickGeo = G(new THREE.PlaneGeometry(0.42, 0.075))
    const tickShadowGeo = G(new THREE.PlaneGeometry(0.5, 0.17))
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2
      const r = 1.38
      const sh = add(tickShadowGeo, retShadowMat, 20, reticle)
      sh.position.set(Math.cos(a) * r, Math.sin(a) * r, 0)
      sh.rotation.z = a
      const t = add(tickGeo, retMat, 21, reticle, 0.001)
      t.position.set(Math.cos(a) * r, Math.sin(a) * r, 0.001)
      t.rotation.z = a
    }
    // rotating corner brackets (tile reticle)
    for (let k = 0; k < 4; k++) {
      add(G(new THREE.RingGeometry(1.7, 1.8, 12, 1, k * (Math.PI / 2) + Math.PI / 8, Math.PI / 4)), retMat, 21, retSpin, 0.001)
    }
    reticle.add(retSpin)
  }
  const retPos = new THREE.Vector3(0, TARGET_CENTER.y, TARGET_Z + 0.06)
  let retSteady = 0
  let retRadius = 0.3
  const retUnsteady = new THREE.Color(MAGENTA)
  const retMid = new THREE.Color(GOLD)
  const retSteadyC = new THREE.Color(LIME)

  // ---------- wind: flags and streaks ----------
  let windAccel = 0
  let windStrength = 0
  const flags: Flag[] = []
  {
    const poleMat = M(new THREE.MeshBasicMaterial({ color: 0x8a96bb }))
    const capMat = M(
      new THREE.SpriteMaterial({ map: dotTex, color: GOLD, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    for (const f of FLAGS) {
      const pole = new THREE.Mesh(G(new THREE.CylinderGeometry(0.018, 0.026, f.h, 6)), poleMat)
      pole.position.set(f.x, f.h / 2, f.z)
      scene.add(pole)
      const cap = new THREE.Sprite(capMat)
      cap.position.set(f.x, f.h + 0.03, f.z)
      cap.scale.setScalar(0.22)
      scene.add(cap)
      const base = new THREE.Mesh(G(new THREE.CircleGeometry(0.18, 16)), additive(f.color, 0.3))
      base.rotation.x = -Math.PI / 2
      base.position.set(f.x, 0.009, f.z)
      scene.add(base)
      // ribbon: 2 rows x (RIBBON_SEG + 1) columns, positions rewritten each frame
      const cols = RIBBON_SEG + 1
      const pos = new Float32Array(cols * 2 * 3)
      const col = new Float32Array(cols * 2 * 3)
      const c0 = new THREE.Color(GOLD)
      const c1 = new THREE.Color(f.color)
      for (let i = 0; i < cols; i++) {
        const u = i / RIBBON_SEG
        tmpC.copy(c0).lerp(c1, Math.min(1, u * 1.6)).multiplyScalar(1 - 0.55 * u)
        for (let r = 0; r < 2; r++) {
          const j = (r * cols + i) * 3
          col[j] = tmpC.r
          col[j + 1] = tmpC.g
          col[j + 2] = tmpC.b
        }
      }
      const idx: number[] = []
      for (let i = 0; i < RIBBON_SEG; i++) idx.push(i, i + 1, cols + i, i + 1, cols + i + 1, cols + i)
      const geo = G(new THREE.BufferGeometry())
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
      geo.setIndex(idx)
      const ribbon = new THREE.Mesh(
        geo,
        M(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.92 })),
      )
      ribbon.frustumCulled = false
      scene.add(ribbon)
      flags.push({ pos, geo, x: f.x, top: f.h - 0.02, z: f.z, len: f.len, phase: Math.random() * TAU })
    }
  }
  const updateFlags = (dt: number): void => {
    void dt
    const s = windStrength
    const sign = windAccel >= 0 ? 1 : -1
    const cols = RIBBON_SEG + 1
    // ribbon angle: hanging (-90 deg) at no wind, near horizontal when strong
    const phi = -Math.PI / 2 + s * (Math.PI / 2 - 0.12)
    const dx = sign * Math.cos(phi)
    const dy = Math.sin(phi)
    const px = sign >= 0 ? dy : -dy
    const py = sign >= 0 ? -dx : dx
    const W = 0.2
    for (const f of flags) {
      const freq = 3 + 8 * s
      for (let i = 0; i < cols; i++) {
        const u = i / RIBBON_SEG
        const L = f.len * (0.75 + 0.25 * s)
        const wave = Math.sin(time * freq - u * 7 + f.phase) * u
        const wz = wave * (0.05 + 0.12 * s)
        const wy = wave * 0.05 * s - (1 - s) * 0 - u * u * 0.12 * s
        const cx = f.x + dx * u * L
        const cy = f.top + dy * u * L + wy
        const cz = f.z + wz
        const w = W * (1 - 0.35 * u)
        const top = i * 3
        const bot = (cols + i) * 3
        f.pos[top] = cx
        f.pos[top + 1] = cy
        f.pos[top + 2] = cz
        f.pos[bot] = cx + px * w
        f.pos[bot + 1] = cy + py * w
        f.pos[bot + 2] = cz + wave * 0.03
      }
      f.geo.getAttribute('position').needsUpdate = true
    }
  }

  const STREAK_N = reduced ? 14 : 44
  const streaks: Streak[] = []
  const streakPos = new Float32Array(STREAK_N * 6)
  const streakCol = new Float32Array(STREAK_N * 6)
  const streakGeo = G(new THREE.BufferGeometry())
  streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPos, 3))
  streakGeo.setAttribute('color', new THREE.BufferAttribute(streakCol, 3))
  const streakLines = new THREE.LineSegments(
    streakGeo,
    M(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })),
  )
  streakLines.frustumCulled = false
  streakLines.visible = false
  scene.add(streakLines)
  const streakHalfW = (z: number): number => -z * 0.24 + 0.8
  for (let i = 0; i < STREAK_N; i++) {
    const z = -5 - Math.random() * 21
    streaks.push({
      x: (Math.random() * 2 - 1) * streakHalfW(z),
      y: 0.4 + Math.random() * 2.8,
      z,
      speed: 0.7 + Math.random() * 0.6,
      len: 0.4 + Math.random() * 0.6,
    })
  }
  const streakColor = new THREE.Color(0x9ff8ff)
  const updateStreaks = (dt: number): void => {
    const s = windStrength
    streakLines.visible = s > 0.02
    if (!streakLines.visible) return
    const sign = windAccel >= 0 ? 1 : -1
    for (let i = 0; i < STREAK_N; i++) {
      const k = streaks[i]
      const hw = streakHalfW(k.z)
      k.x += sign * k.speed * (2.5 + 7 * s) * dt
      if (k.x > hw + 1) k.x = -hw - 1
      if (k.x < -hw - 1) k.x = hw + 1
      const len = k.len * (0.4 + s)
      const j = i * 6
      const wob = Math.sin(time * 2 + i) * 0.04
      streakPos[j] = k.x
      streakPos[j + 1] = k.y + wob
      streakPos[j + 2] = k.z
      streakPos[j + 3] = k.x - sign * len
      streakPos[j + 4] = k.y + wob
      streakPos[j + 5] = k.z
      // fade near the wrap edges
      const edge = 1 - smooth((Math.abs(k.x) - hw + 0.6) / 1.2)
      const b = 0.4 * s * edge
      streakCol[j] = streakColor.r * b
      streakCol[j + 1] = streakColor.g * b
      streakCol[j + 2] = streakColor.b * b
      streakCol[j + 3] = 0
      streakCol[j + 4] = 0
      streakCol[j + 5] = 0
    }
    streakGeo.getAttribute('position').needsUpdate = true
    streakGeo.getAttribute('color').needsUpdate = true
  }

  // ---------- first-person bow (second pass) ----------
  const bowScene = new THREE.Scene()
  const bowCam = new THREE.PerspectiveCamera(BOW_FOV, 16 / 9, 0.01, 10)
  bowScene.add(new THREE.HemisphereLight(0xb6c2e2, 0x1a1628, 1.3))
  const keyLight = new THREE.DirectionalLight(0xfff4e0, 2.2)
  keyLight.position.set(1.5, 2.2, 1.2)
  bowScene.add(keyLight)
  const rimLight = new THREE.DirectionalLight(CYAN, 1.4)
  rimLight.position.set(-2, 0.4, -1.5)
  bowScene.add(rimLight)

  const bowRoot = new THREE.Group()
  bowScene.add(bowRoot)
  const bowBody = new THREE.Group()
  bowBody.scale.setScalar(0.62)
  bowRoot.add(bowBody)
  const limbMat = M(
    new THREE.MeshStandardMaterial({
      color: GOLD,
      emissive: 0xffb800,
      emissiveIntensity: 0.3,
      metalness: 0.4,
      roughness: 0.32,
      flatShading: true,
    }),
  )
  const limbGlowMat = additive(GOLD, 0.14, { side: THREE.BackSide })
  const limbEdgeMat = additive(0xfff2b2, 0.9)
  const PIVOT_Y = 0.13
  const upperPts = [
    [0, 0],
    [0.13, -0.025],
    [0.27, -0.075],
    [0.39, -0.145],
    [0.47, -0.19],
    [0.515, -0.192],
    [0.545, -0.16],
  ].map(([y, z]) => new THREE.Vector3(0, y, z))
  const upperCurve = new THREE.CatmullRomCurve3(upperPts)
  const lowerCurve = new THREE.CatmullRomCurve3(upperPts.map((p) => new THREE.Vector3(0, -p.y, p.z)))
  const tipAttachU = upperCurve.getPointAt(0.86)
  const tipAttachL = lowerCurve.getPointAt(0.86)
  const limbs: THREE.Group[] = []
  for (const [curve, sy] of [
    [upperCurve, 1],
    [lowerCurve, -1],
  ] as const) {
    const limb = new THREE.Group()
    limb.position.y = sy * PIVOT_Y
    limb.add(new THREE.Mesh(G(makeLimbGeometry(curve, 0.017, 1, 0.5)), limbMat))
    limb.add(new THREE.Mesh(G(makeLimbGeometry(curve, 0.03, 1, 0.6)), limbGlowMat))
    // pale edge highlight along the belly
    const edgeCurve = new THREE.CatmullRomCurve3(curve.points.map((p) => new THREE.Vector3(p.x, p.y, p.z + 0.012)))
    limb.add(new THREE.Mesh(G(new THREE.TubeGeometry(edgeCurve, 16, 0.0035, 4, false)), limbEdgeMat))
    bowBody.add(limb)
    limbs.push(limb)
  }
  {
    const riserMat = M(new THREE.MeshStandardMaterial({ color: 0x18213a, metalness: 0.6, roughness: 0.4, flatShading: true }))
    const riser = new THREE.Mesh(G(new THREE.BoxGeometry(0.036, PIVOT_Y * 2 + 0.04, 0.06)), riserMat)
    bowBody.add(riser)
    const grip = new THREE.Mesh(G(new THREE.BoxGeometry(0.044, 0.11, 0.07)), riserMat)
    grip.position.set(0, -0.05, -0.03)
    bowBody.add(grip)
    const pocketGeo = G(new THREE.BoxGeometry(0.05, 0.045, 0.075))
    const pocketMat = M(new THREE.MeshStandardMaterial({ color: 0x3a2a10, metalness: 0.7, roughness: 0.3, emissive: 0x2a1800 }))
    for (const sy of [-1, 1]) {
      const p = new THREE.Mesh(pocketGeo, pocketMat)
      p.position.set(0, sy * PIVOT_Y, -0.005)
      bowBody.add(p)
    }
    const trimMat = M(new THREE.MeshBasicMaterial({ color: LIME }))
    const trimGeo = G(new THREE.BoxGeometry(0.006, PIVOT_Y * 2 - 0.02, 0.006))
    for (const sx of [-1, 1]) {
      const t = new THREE.Mesh(trimGeo, trimMat)
      t.position.set(sx * 0.019, 0, 0.031)
      bowBody.add(t)
    }
    const core = new THREE.Mesh(G(new THREE.OctahedronGeometry(0.016, 0)), M(new THREE.MeshBasicMaterial({ color: CYAN })))
    core.position.set(0, 0.07, 0.034)
    bowBody.add(core)
    const coreGlow = new THREE.Sprite(
      M(new THREE.SpriteMaterial({ map: dotTex, color: CYAN, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })),
    )
    coreGlow.position.copy(core.position)
    coreGlow.scale.setScalar(0.09)
    bowBody.add(coreGlow)
    const rest = new THREE.Mesh(G(new THREE.BoxGeometry(0.03, 0.006, 0.02)), trimMat)
    rest.position.set(0.02, 0.012, 0)
    bowBody.add(rest)
  }
  const stringMat = M(new THREE.MeshBasicMaterial({ color: 0x9ff8ff }))
  const stringGlowMat = additive(CYAN, 0.4)
  const stringGeo = G(new THREE.CylinderGeometry(0.0022, 0.0022, 1, 4, 1, true))
  const stringGlowGeo = G(new THREE.CylinderGeometry(0.008, 0.008, 1, 6, 1, true))
  const strings: Array<{ core: THREE.Mesh; glow: THREE.Mesh }> = []
  for (let i = 0; i < 2; i++) {
    const core = new THREE.Mesh(stringGeo, stringMat)
    const glow = new THREE.Mesh(stringGlowGeo, stringGlowMat)
    bowBody.add(core, glow)
    strings.push({ core, glow })
  }
  const nockGlow = new THREE.Sprite(
    M(new THREE.SpriteMaterial({ map: dotTex, color: LIME, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })),
  )
  nockGlow.scale.setScalar(0.06)
  bowBody.add(nockGlow)
  const bowArrow = buildArrow(arrowMats, true, 0)
  bowBody.add(bowArrow)
  const bowArrowHeadGlow = new THREE.Sprite(nockSpriteMat)
  bowArrowHeadGlow.scale.setScalar(0.05)
  bowArrow.add(bowArrowHeadGlow)

  const tipTop = new THREE.Vector3()
  const tipBot = new THREE.Vector3()
  const nockPt = new THREE.Vector3()
  const setSeg = (seg: { core: THREE.Mesh; glow: THREE.Mesh }, a: THREE.Vector3, b: THREE.Vector3): void => {
    tmpV.copy(b).sub(a)
    const len = Math.max(1e-4, tmpV.length())
    tmpV.divideScalar(len)
    for (const m of [seg.core, seg.glow]) {
      m.position.copy(a).add(b).multiplyScalar(0.5)
      m.quaternion.setFromUnitVectors(UP, tmpV)
      m.scale.set(1, len, 1)
    }
  }
  let bowTension = 0
  let bowTensionShown = 0
  let bowSide: Hand = 'left'
  let bowNocked = true
  const bowAim = new THREE.Vector3()
  let bowAspect = 16 / 9

  const updateBow = (dt: number): void => {
    bowTensionShown += (bowTension - bowTensionShown) * approach(18, dt)
    const t = bowTensionShown
    const sx = bowSide === 'left' ? -1 : 1
    // limbs flex toward the archer under tension
    limbs[0].rotation.x = -0.13 * t
    limbs[1].rotation.x = 0.13 * t
    for (const l of limbs) l.updateMatrix()
    tipTop.copy(tipAttachU).applyMatrix4(limbs[0].matrix)
    tipBot.copy(tipAttachL).applyMatrix4(limbs[1].matrix)
    nockPt.set(0, 0.012, BRACE_Z - DRAW_LEN * t)
    setSeg(strings[0], tipTop, nockPt)
    setSeg(strings[1], nockPt, tipBot)
    nockGlow.position.copy(nockPt)
    nockGlow.material.opacity = 0.35 + 0.65 * t
    bowArrow.visible = bowNocked
    nockGlow.visible = bowNocked || t > 0.05
    // arrow rests on the inner side of the riser (toward the screen centre)
    bowArrow.position.set(-sx * 0.026, nockPt.y + 0.006, nockPt.z + ARROW_LEN)
    bowArrowHeadGlow.position.set(0, 0, 0.01)
    limbMat.emissiveIntensity = 0.3 + 0.6 * t
    limbGlowMat.opacity = 0.12 + 0.22 * t
    stringGlowMat.opacity = 0.35 + 0.45 * t
    arrowMats.glow.opacity = 0.28

    // placement in bow-camera space, adapted to aspect
    const halfH = Math.tan(((BOW_FOV / 2) * Math.PI) / 180)
    const halfW = halfH * bowAspect
    const depth = 1.0
    const bx = sx * Math.min(0.31, halfW * depth * 0.58)
    const low = clamp((1.5 - bowAspect) * 0.16, 0, 0.12)
    const swayT = reduced ? 0 : 1
    const sway = Math.sin(time * 1.3) * 0.006 * swayT
    const bob = Math.sin(time * 0.9 + 0.7) * 0.008 * swayT
    const hide = smooth(followBlend * 1.6)
    // at full draw the bow rises and comes in a little so the string V stays on screen
    bowRoot.position.set(bx - sx * t * 0.04 + sway, -0.23 - low + bob - hide * 0.9 + t * 0.05, -depth + t * 0.03)
    // arrow line passes near the screen centre; slight yaw keeps the recurve profile readable
    bowAim.set(-sx * 0.3, 0.3 - hide * 0.6, -5)
    bowRoot.lookAt(bowAim)
    bowRoot.rotateZ(-sx * 0.22 + Math.sin(time * 0.7) * 0.012 * swayT)
    bowRoot.visible = hide < 0.98
  }

  // ---------- camera state ----------
  let followOn = false
  let followBlend = 0
  let followInit = false
  const anchor = new THREE.Vector3(LAUNCH_POS.x, LAUNCH_POS.y, LAUNCH_POS.z)
  const followOff = new THREE.Vector3()
  const followLook = new THREE.Vector3()
  const wantOff = new THREE.Vector3()
  const wantLook = new THREE.Vector3()
  let followFov = FOLLOW_FOV
  const impactPos = new THREE.Vector3()
  let impactValid = false
  let shakeAmt = 0
  let time = 0
  const camPos = new THREE.Vector3()
  const camLook = new THREE.Vector3()
  const shakeVec = new THREE.Vector3()

  const updateCamera = (dt: number): void => {
    followBlend += ((followOn ? 1 : 0) - followBlend) * approach(followOn ? 6 : 2.6, dt)
    if (Math.abs(followBlend - (followOn ? 1 : 0)) < 0.002) followBlend = followOn ? 1 : 0
    let targetFov = FOLLOW_FOV
    if (flyArrow.visible) {
      anchor.copy(flyArrow.position)
      wantOff.copy(flyDir).multiplyScalar(-1.6)
      wantOff.y += 0.3
      wantOff.x += 0.14
      wantLook.copy(flyDir).multiplyScalar(7)
    } else if (impactValid) {
      anchor.copy(impactPos)
      wantOff.set(1.3, 0.55, 6)
      wantLook.set(0, 0, 0)
      targetFov = IMPACT_FOV
    } else {
      anchor.set(LAUNCH_POS.x, LAUNCH_POS.y, LAUNCH_POS.z)
      wantOff.set(0, 0.25, 1.2)
      wantLook.set(0, 0, -6)
    }
    if (!followInit) {
      followOff.copy(wantOff)
      followLook.copy(wantLook)
      followFov = targetFov
      followInit = true
    } else {
      const k = approach(flyArrow.visible ? 5 : 2.2, dt)
      followOff.lerp(wantOff, k)
      followLook.lerp(wantLook, k)
      followFov += (targetFov - followFov) * k
    }
    const b = smooth(followBlend)
    camPos.copy(anchor).add(followOff)
    camPos.lerpVectors(archerCam.position, camPos, b)
    camLook.copy(anchor).add(followLook)
    camLook.lerpVectors(archerLook, camLook, b)

    shakeAmt *= Math.exp(-dt * 6)
    if (shakeAmt < 0.002) shakeAmt = 0
    const ang = (shakeAmt * shakeAmt * 0.018 + shakeAmt * 0.005) * (reduced ? 0.3 : 1)
    const dist = camPos.distanceTo(camLook)
    shakeVec.set(
      (Math.sin(time * 61) + 0.6 * Math.sin(time * 37.3)) * ang * dist,
      (Math.sin(time * 53.7 + 1.3) + 0.6 * Math.sin(time * 29.1)) * ang * dist,
      0,
    )
    viewCam.position.copy(camPos)
    camLook.add(shakeVec)
    viewCam.lookAt(camLook)
    const fov = lerp(archerFov, followFov, b)
    if (Math.abs(viewCam.fov - fov) > 1e-4) {
      viewCam.fov = fov
      viewCam.updateProjectionMatrix()
    }
    bowCam.position.set(shakeVec.x * 0.004, shakeVec.y * 0.004, 0)
  }

  const updateReticle = (dt: number): void => {
    const hidden = followBlend > 0.15
    reticle.visible = retVisible && !hidden
    if (!reticle.visible) return
    const s = retSteady
    retRadius += (lerp(0.34, 0.15, s) - retRadius) * approach(10, dt)
    const pulse = reduced ? 1 : 1 + Math.sin(time * (5 + 3 * (1 - s))) * 0.05 * (1 - 0.6 * s)
    reticle.position.copy(retPos)
    reticle.scale.setScalar(retRadius * pulse)
    retSpin.rotation.z = reduced ? 0 : time * (0.4 + 1.6 * (1 - s))
    if (s < 0.5) tmpC.copy(retUnsteady).lerp(retMid, s * 2)
    else tmpC.copy(retMid).lerp(retSteadyC, (s - 0.5) * 2)
    retMat.color.copy(tmpC)
    retMat.opacity = 0.85 + 0.15 * s
  }
  let retVisible = false

  const updateFlyArrow = (dt: number): void => {
    if (flyArrow.visible) {
      const d = flyArrow.position.distanceTo(tmpV.set(LAUNCH_POS.x, LAUNCH_POS.y, LAUNCH_POS.z))
      flyFade = smooth(d / FADE_IN_M)
      for (const m of [flyMats.shaft, flyMats.head, flyMats.vane, flyMats.nock]) m.opacity = flyFade
      flyMats.glow.opacity = 0.3 * flyFade
      flyTipGlowMat.opacity = 0.8 * flyFade
      trailAlpha = Math.min(1, trailAlpha + dt * 6) * smooth((d - 0.4) / 1.2)
    } else {
      trailAlpha = Math.max(0, trailAlpha - dt * 2.5)
    }
    const vis = trailAlpha > 0.003 && trailCount > 1
    trailPts.visible = trailLine.visible = vis
    if (!vis) return
    for (let i = 0; i < TRAIL_N; i++) {
      const k = i < trailCount ? 1 - i / (TRAIL_N - 1) : 0
      const b = k * k * trailAlpha
      tmpC.copy(trailTail).lerp(trailTint, k)
      trailCol[i * 3] = tmpC.r * b
      trailCol[i * 3 + 1] = tmpC.g * b
      trailCol[i * 3 + 2] = tmpC.b * b
    }
    trailColAttr.needsUpdate = true
  }

  const addStuck = (group: THREE.Group, local: THREE.Vector3, dir: THREE.Vector3, depth: number): void => {
    const a = buildArrow(arrowMats, false, 0.13)
    a.position.copy(local).addScaledVector(dir, depth)
    a.quaternion.setFromUnitVectors(Z_AXIS, dir)
    group.add(a)
    if (group === stuckGroup) {
      const ring = new THREE.Mesh(holeRingGeo, holeRingMat)
      ring.position.set(local.x, local.y, 0.006)
      const hole = new THREE.Mesh(holeGeo, holeMat)
      hole.position.set(local.x, local.y, 0.005)
      a.userData.marks = [ring, hole]
      group.add(hole, ring)
    }
    const total = stuckGroup.children.length + missGroup.children.length
    if (total > MAX_STUCK) {
      const from = missGroup.children.length > 0 ? missGroup : stuckGroup
      const first = from.children.find((c) => c.userData.marks !== undefined || from === missGroup)
      if (first) {
        from.remove(first)
        const marks = first.userData.marks as THREE.Object3D[] | undefined
        if (marks) for (const m of marks) from.remove(m)
      }
    }
  }

  const holeGeo = G(new THREE.CircleGeometry(0.03, 14))
  const holeMat = M(new THREE.MeshBasicMaterial({ color: 0x05060c }))
  const holeRingGeo = G(new THREE.RingGeometry(0.03, 0.046, 18))
  const holeRingMat = M(new THREE.MeshBasicMaterial({ color: 0xf4fbff, transparent: true, opacity: 0.9 }))
  const sparkBias = new THREE.Vector3(0, 0.25, 0.6)
  const dustBias = new THREE.Vector3(0, 0.35, 0.15)
  const local = new THREE.Vector3()
  const hitDir = new THREE.Vector3()

  // ---------- API ----------
  const api: ArcheryScene = {
    canvas: cv,

    resize(width: number, height: number): void {
      const w = Math.max(1, Math.floor(width))
      const h = Math.max(1, Math.floor(height))
      renderer.setSize(w, h, false)
      const aspect = w / h
      // keep the lane readable on narrow screens: widen until ARCHER_MIN_HALF_W fits at the target
      const dist = archerCam.position.distanceTo(archerLook)
      const needFov = (2 * Math.atan(ARCHER_MIN_HALF_W / dist / aspect) * 180) / Math.PI
      archerFov = Math.max(ARCHER_FOV, needFov)
      archerCam.fov = archerFov
      archerCam.aspect = aspect
      archerCam.updateProjectionMatrix()
      archerCam.updateMatrixWorld(true)
      viewCam.aspect = aspect
      viewCam.updateProjectionMatrix()
      bowCam.aspect = aspect
      bowCam.updateProjectionMatrix()
      bowAspect = aspect
    },

    setBow(tension: number, bowHand: Hand, nocked: boolean): void {
      bowTension = clamp01(tension)
      bowSide = bowHand
      bowNocked = nocked
    },

    setReticle(p: Vec2 | null, steadiness: number): void {
      if (!p) {
        retVisible = false
        return
      }
      if (!retVisible) retRadius = lerp(0.34, 0.15, clamp01(steadiness))
      retVisible = true
      retPos.set(p.x, p.y, TARGET_Z + 0.06)
      retSteady = clamp01(steadiness)
    },

    setTarget(center: Vec2): void {
      targetGroup.position.set(center.x, center.y, TARGET_Z)
      standGroup.position.set(center.x, 0, TARGET_Z)
    },

    setWind(accel: number): void {
      windAccel = Number.isFinite(accel) ? accel : 0
      windStrength = clamp(Math.abs(windAccel) / 3, 0, 1)
    },

    setArrow(p: Vec3, dir: Vec3, visible: boolean): void {
      const was = flyArrow.visible
      flyArrow.position.set(p.x, p.y, p.z)
      dirOf(dir, flyDir)
      flyArrow.quaternion.setFromUnitVectors(Z_AXIS, flyDir)
      flyArrow.visible = visible
      if (visible && !was) {
        resetTrail(flyArrow.position)
        trailAlpha = 0
        impactValid = false
      } else if (visible) {
        pushTrail(flyArrow.position)
      }
    },

    stickArrow(p: Vec3, dir: Vec3, score: number): void {
      dirOf(dir, hitDir)
      local.set(p.x, p.y, p.z).sub(targetGroup.position)
      local.z = Math.max(local.z, 0)
      addStuck(stuckGroup, local, hitDir, 0.1)
      impactPos.set(p.x, p.y, p.z)
      impactValid = true
      const s = Math.round(clamp(Number.isFinite(score) ? score : 0, 0, RING_COUNT))
      const world = tmpV.set(p.x, p.y, Math.max(p.z, TARGET_Z) + 0.02)
      const flat = local.clone().setZ(0.004)
      if (s > 0) {
        const color = RING_FLASH[s - 1]
        spawnFlash(ringGeos[s - 1], tmpV2.set(0, 0, 0.003), color, 0.9, 0.9, false, 1, 1)
        if (s === RING_COUNT) {
          spawnFlash(waveGeo, flat, GOLD, 0.9, 1, true, 0.05, 2.6)
          spawnFlash(waveGeo, flat, LIME, 1.2, 0.9, true, 0.05, 1.6)
          spawnFlash(ringGeos[s - 1], tmpV2.set(0, 0, 0.004), 0xffffff, 0.35, 0.8, false, 1, 1)
          spawn(sparks, world, 90, GOLD, 4.2, sparkBias, 0.9, 0.35)
          spawn(sparks, world, 50, LIME, 3.2, sparkBias, 0.8, 0.2)
          haloFlare = 1
          api.shake(0.35)
        } else {
          spawnFlash(waveGeo, flat, color, 0.5, 0.55, true, 0.06, 0.35 + s * 0.03)
          spawn(sparks, world, 14 + s * 3, color, 1.8 + s * 0.18, sparkBias, 0.55, 0.3)
        }
      } else {
        spawn(sparks, world, 14, PALE, 1.5, sparkBias, 0.5, 0.2)
      }
    },

    missArrow(p: Vec3, dir: Vec3): void {
      dirOf(dir, hitDir)
      local.set(p.x, p.y, p.z)
      const ground = p.y < 0.2
      if (ground) local.y = Math.max(0, local.y)
      addStuck(missGroup, local, hitDir, ground ? 0.2 : 0.12)
      impactPos.set(p.x, Math.max(p.y, 0.05), p.z)
      impactValid = true
      const at = tmpV.set(p.x, Math.max(p.y, 0.06), p.z + (ground ? 0 : 0.05))
      spawn(dust, at, 16, ground ? 0x8a6a3a : 0x6a5a8a, 1.0, dustBias, 0.9, 0.1)
      spawn(sparks, at, 10, ground ? GOLD : MAGENTA, 1.3, dustBias, 0.4, 0.2)
    },

    setFollowCam(on: boolean): void {
      if (on && !followOn && followBlend < 0.01) followInit = false
      followOn = on
    },

    shake(intensity: number): void {
      shakeAmt = Math.max(shakeAmt, clamp01(intensity))
    },

    screenToTarget(ndcX: number, ndcY: number): Vec2 {
      const origin = archerCam.position
      const dir = tmpV.set(clamp(ndcX, -1, 1), clamp(ndcY, -1, 1), 0.5).unproject(archerCam).sub(origin)
      let x = TARGET_CENTER.x
      let y = TARGET_CENTER.y
      if (Math.abs(dir.z) > 1e-6) {
        const t = (TARGET_Z - origin.z) / dir.z
        if (t > 0) {
          x = origin.x + dir.x * t
          y = origin.y + dir.y * t
        }
      }
      return { x, y }
    },

    reset(): void {
      stuckGroup.clear()
      missGroup.clear()
      clearParticles(sparks)
      clearParticles(dust)
      for (const f of flashes) {
        f.active = false
        f.mesh.visible = false
      }
      haloFlare = 0
      retVisible = false
      reticle.visible = false
      api.setWind(0)
      api.setTarget(TARGET_CENTER)
      flyArrow.visible = false
      trailAlpha = 0
      trailCount = 0
      trailPts.visible = trailLine.visible = false
      impactValid = false
      followOn = false
      followBlend = 0
      followInit = false
      shakeAmt = 0
      updateCamera(0)
    },

    update(dtMs: number): void {
      const dt = clamp(Number.isFinite(dtMs) ? dtMs : 0, 0, 100) / 1000
      time += dt
      updateCamera(dt)
      updateBow(dt)
      updateReticle(dt)
      updateFlags(dt)
      updateStreaks(dt)
      updateFlyArrow(dt)
      updateParticles(sparks, dt)
      updateParticles(dust, dt)
      updateFlashes(dt)
      haloFlare = Math.max(0, haloFlare - dt * 1.2)
      haloMat.opacity = 0.42 + 0.55 * haloFlare + (reduced ? 0 : Math.sin(time * 1.7) * 0.04)
    },

    render(): void {
      renderer.clear()
      renderer.render(scene, viewCam)
      if (bowRoot.visible) {
        renderer.clearDepth()
        renderer.render(bowScene, bowCam)
      }
    },

    dispose(): void {
      for (const s of [scene, bowScene]) {
        s.traverse((o) => {
          const m = o as THREE.Mesh
          if (m.geometry) geos.add(m.geometry)
          const mat = m.material as THREE.Material | THREE.Material[] | undefined
          if (Array.isArray(mat)) mat.forEach((x) => mats.add(x))
          else if (mat) mats.add(mat)
        })
      }
      geos.forEach((g) => g.dispose())
      mats.forEach((m) => m.dispose())
      texs.forEach((t) => t.dispose())
      stuckGroup.clear()
      missGroup.clear()
      renderer.dispose()
      // dispose() keeps the GL context alive; without this each launch leaks one
      renderer.forceContextLoss()
      cv.remove()
    },
  }

  Object.defineProperty(api, '_dbg', { value: { scene, viewCam, renderer } }) // DEBUG-REMOVE
  api.resize(cv.clientWidth || 1280, cv.clientHeight || 720)
  api.reset()
  api.setBow(0, 'left', true)
  api.update(0)
  return api
}
