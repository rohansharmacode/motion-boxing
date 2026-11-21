// Neon-grid arena dressing shared by bowling, table tennis and tennis. Original art, all procedural:
// glossy grid floor, panelled side walls with light strips, light pulses racing along the walls,
// tiered crowd of glowing silhouettes, light arches overhead and a back-wall display.
// About a dozen draw calls, no shadows, no post-processing.
import * as THREE from 'three'

export interface NeonArenaOptions {
  /** Inner width between the side walls, m. */
  width: number
  /** Length of the hall along z, m. */
  length: number
  /** z of the hall centre. */
  centerZ: number
  /** Wall height, m. */
  height?: number
  /** Crowd silhouettes in the side stands (0 for none). */
  crowd?: number
  /** Overhead light arches. */
  arches?: number
  /** Back-wall display text. */
  title?: string
  /** Leave the floor out (the sport draws its own). */
  noFloor?: boolean
  /** Floor height (lower it under sunken gutters). */
  floorY?: number
}

export interface NeonArena {
  group: THREE.Group
  /** Call every frame with seconds since start. */
  update(t: number): void
  /** Flash the arches and crowd (strike, point won). */
  pulse(color?: number): void
  dispose(): void
}

const CYAN = 0x22e5ff
const PINK = 0xff2e88
const AMBER = 0xffd166

export function buildNeonArena(o: NeonArenaOptions): NeonArena {
  const H = o.height ?? Math.max(4, o.width * 0.45)
  const W2 = o.width / 2
  const L = o.length
  const z0 = o.centerZ
  const group = new THREE.Group()
  const disposables: { dispose(): void }[] = []
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x)
    return x
  }

  // ---------- floor: glossy black with a glowing grid ----------
  if (!o.noFloor) {
    const tex = track(new THREE.CanvasTexture(gridCanvas()))
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(o.width / 2, L / 2)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    const floor = new THREE.Mesh(
      track(new THREE.PlaneGeometry(o.width, L)),
      track(new THREE.MeshStandardMaterial({ color: 0x05070f, roughness: 0.18, metalness: 0.7, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.55 })),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.set(0, o.floorY ?? -0.001, z0)
    group.add(floor)
  }

  // ---------- side walls: dark panels with glowing seams ----------
  const wallTex = track(new THREE.CanvasTexture(wallCanvas()))
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping
  wallTex.repeat.set(L / 4, 1)
  wallTex.colorSpace = THREE.SRGBColorSpace
  const wallMat = track(
    new THREE.MeshStandardMaterial({ color: 0x0a0f22, roughness: 0.3, metalness: 0.5, emissive: 0xffffff, emissiveMap: wallTex, emissiveIntensity: 0.9 }),
  )
  const wallGeo = track(new THREE.PlaneGeometry(L, H))
  for (const s of [-1, 1]) {
    const wall = new THREE.Mesh(wallGeo, wallMat)
    wall.rotation.y = s * -Math.PI / 2
    wall.position.set(s * W2, H / 2, z0)
    group.add(wall)
  }
  // Base and top light strips along both walls.
  const stripGeo = track(new THREE.BoxGeometry(0.05, 0.05, L))
  const cyanMat = track(new THREE.MeshBasicMaterial({ color: CYAN }))
  const pinkMat = track(new THREE.MeshBasicMaterial({ color: PINK }))
  for (const s of [-1, 1]) {
    const low = new THREE.Mesh(stripGeo, cyanMat)
    low.position.set(s * (W2 - 0.03), 0.03, z0)
    const high = new THREE.Mesh(stripGeo, pinkMat)
    high.position.set(s * (W2 - 0.03), H - 0.05, z0)
    group.add(low, high)
  }

  // ---------- light pulses racing along the walls ----------
  const PULSES = 12
  const pulseGeo = track(new THREE.BoxGeometry(0.07, 0.07, 1.6))
  const pulseMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }))
  const pulses = new THREE.InstancedMesh(pulseGeo, pulseMat, PULSES)
  const pulseData = Array.from({ length: PULSES }, (_, i) => ({
    side: i % 2 ? 1 : -1,
    y: i % 3 === 0 ? H - 0.05 : 0.03 + (i % 3) * (H * 0.28),
    speed: (6 + (i % 4) * 2.5) * (i % 4 < 2 ? 1 : -1),
    off: (i * 7.3) % L,
  }))
  const pc = new THREE.Color()
  pulseData.forEach((_, i) => pulses.setColorAt(i, pc.setHex(i % 3 === 0 ? PINK : CYAN)))
  group.add(pulses)

  // ---------- light arches overhead ----------
  const ARCHES = o.arches ?? 6
  const archGroup = new THREE.Group()
  const archMat = track(new THREE.MeshBasicMaterial({ color: PINK }))
  const archCyan = track(new THREE.MeshBasicMaterial({ color: CYAN }))
  const archTop = track(new THREE.BoxGeometry(o.width, 0.06, 0.06))
  const archSide = track(new THREE.BoxGeometry(0.06, H, 0.06))
  for (let i = 0; i < ARCHES; i++) {
    // Spread over the far three quarters so no arch frames the camera.
    const z = z0 - L / 2 + ((i + 0.5) * L * 0.75) / ARCHES
    const m = i % 2 ? archCyan : archMat
    const top = new THREE.Mesh(archTop, m)
    top.position.set(0, H, z)
    const l = new THREE.Mesh(archSide, m)
    l.position.set(-W2 + 0.05, H / 2, z)
    const r = new THREE.Mesh(archSide, m)
    r.position.set(W2 - 0.05, H / 2, z)
    archGroup.add(top, l, r)
  }
  group.add(archGroup)

  // ---------- crowd: tiered stands of glowing silhouettes behind low glass rails ----------
  const CROWD = o.crowd ?? 0
  let crowd: THREE.InstancedMesh | null = null
  const crowdBase: { x: number; y: number; z: number; ph: number; amp: number }[] = []
  if (CROWD > 0) {
    // Stands sit outside the walls, which are cut down to a rail in front of them.
    const head = track(new THREE.CapsuleGeometry(0.16, 0.35, 2, 8))
    const crowdMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }))
    crowd = new THREE.InstancedMesh(head, crowdMat, CROWD)
    const rows = 4
    const perSide = Math.floor(CROWD / 2)
    const perRow = Math.ceil(perSide / rows)
    const cc = new THREE.Color()
    let k = 0
    for (const s of [-1, 1])
      for (let r = 0; r < rows; r++)
        for (let j = 0; j < perRow && k < CROWD; j++, k++) {
          const z = z0 - L * 0.45 + ((j + (r % 2) * 0.5) * L * 0.9) / perRow
          const x = s * (W2 + 0.9 + r * 0.9)
          const y = 0.8 + r * 0.7
          crowdBase.push({ x, y, z, ph: Math.random() * Math.PI * 2, amp: 0.03 + Math.random() * 0.08 })
          const roll = Math.random()
          crowd.setColorAt(k, cc.setHex(roll < 0.4 ? 0x1d5f8a : roll < 0.7 ? 0x6a1d52 : roll < 0.9 ? 0x2a3566 : AMBER).multiplyScalar(roll < 0.9 ? 1 : 0.7))
        }
    crowd.count = k
    group.add(crowd)
    // Tier steps with glowing nosing.
    const stepMat = track(new THREE.MeshStandardMaterial({ color: 0x0b1024, roughness: 0.5 }))
    const stepGeo = track(new THREE.BoxGeometry(0.9, 0.7, L * 0.95))
    const noseGeo = track(new THREE.BoxGeometry(0.04, 0.03, L * 0.95))
    for (const s of [-1, 1])
      for (let r = 0; r < rows; r++) {
        const step = new THREE.Mesh(stepGeo, stepMat)
        step.scale.y = 1 + r
        step.position.set(s * (W2 + 0.9 + r * 0.9), ((1 + r) * 0.7) / 2, z0)
        const nose = new THREE.Mesh(noseGeo, r % 2 ? pinkMat : cyanMat)
        nose.position.set(s * (W2 + 0.45 + r * 0.9), (1 + r) * 0.7 + 0.02, z0)
        group.add(step, nose)
      }
  }
  // When there is a crowd, the walls are lowered to a glass rail so the stands show.
  if (CROWD > 0) {
    group.children.forEach((c) => {
      if (c instanceof THREE.Mesh && c.geometry === wallGeo) c.visible = false
    })
    const glass = track(new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.08, side: THREE.DoubleSide }))
    const glassGeo = track(new THREE.PlaneGeometry(L, 1.0))
    for (const s of [-1, 1]) {
      const g = new THREE.Mesh(glassGeo, glass)
      g.rotation.y = s * -Math.PI / 2
      g.position.set(s * W2, 0.5, z0)
      group.add(g)
    }
    // Tall back wall behind the stands so the hall still feels closed.
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(wallGeo, wallMat)
      wall.rotation.y = s * -Math.PI / 2
      wall.position.set(s * (W2 + 4.4), H / 2 + 1, z0)
      wall.scale.y = 1.4
      group.add(wall)
    }
  }

  // ---------- back-wall display ----------
  const dispTex = track(new THREE.CanvasTexture(displayCanvas(o.title ?? 'KINETIC')))
  dispTex.colorSpace = THREE.SRGBColorSpace
  const disp = new THREE.Mesh(track(new THREE.PlaneGeometry(Math.min(o.width * 0.6, 12), Math.min(o.width * 0.6, 12) / 4)), track(new THREE.MeshBasicMaterial({ map: dispTex, transparent: true })))
  disp.position.set(0, H * 0.6, z0 - L / 2 + 0.05)
  group.add(disp)
  const backWall = new THREE.Mesh(track(new THREE.PlaneGeometry(o.width + (CROWD > 0 ? 9 : 0), H * 1.5)), wallMat)
  backWall.position.set(0, (H * 1.5) / 2, z0 - L / 2)
  group.add(backWall)

  // ---------- animation ----------
  const m4 = new THREE.Matrix4()
  let flash = 0
  let flashColor = new THREE.Color(AMBER)
  let lastT = 0
  function update(t: number): void {
    const dt = Math.min(0.05, Math.max(0, t - lastT))
    lastT = t
    pulseData.forEach((p, i) => {
      const z = z0 - L / 2 + ((((p.off + p.speed * t) % L) + L) % L)
      m4.makeTranslation(p.side * (W2 - 0.04), p.y, z)
      pulses.setMatrixAt(i, m4)
    })
    pulses.instanceMatrix.needsUpdate = true
    if (crowd) {
      const cheer = 1 + flash * 4
      for (let i = 0; i < crowdBase.length; i++) {
        const c = crowdBase[i]
        m4.makeTranslation(c.x, c.y + Math.max(0, Math.sin(t * 3 + c.ph)) * c.amp * cheer, c.z)
        crowd.setMatrixAt(i, m4)
      }
      crowd.instanceMatrix.needsUpdate = true
    }
    if (flash > 0) {
      flash = Math.max(0, flash - dt * 1.5)
      archMat.color.setHex(PINK).lerp(flashColor, flash)
      archCyan.color.setHex(CYAN).lerp(flashColor, flash)
    }
    wallMat.emissiveIntensity = 0.8 + Math.sin(t * 1.3) * 0.1 + flash * 0.6
  }
  function pulse(color = AMBER): void {
    flash = 1
    flashColor = new THREE.Color(color)
  }
  function dispose(): void {
    for (const d of disposables) d.dispose()
    pulses.dispose()
    crowd?.dispose()
    group.removeFromParent()
  }
  update(0)
  return { group, update, pulse, dispose }
}

// ---------- canvas textures (procedural, original) ----------

function gridCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  if (!g) return c
  g.fillStyle = '#000'
  g.fillRect(0, 0, 128, 128)
  g.strokeStyle = 'rgba(34,229,255,0.55)'
  g.lineWidth = 2
  g.strokeRect(1, 1, 126, 126)
  g.strokeStyle = 'rgba(34,229,255,0.16)'
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(64, 0)
  g.lineTo(64, 128)
  g.moveTo(0, 64)
  g.lineTo(128, 64)
  g.stroke()
  g.fillStyle = 'rgba(255,46,136,0.7)'
  g.fillRect(0, 0, 4, 4)
  return c
}

function wallCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const g = c.getContext('2d')
  if (!g) return c
  g.fillStyle = '#000'
  g.fillRect(0, 0, 256, 256)
  // panel seams
  g.strokeStyle = 'rgba(34,229,255,0.35)'
  g.lineWidth = 2
  g.strokeRect(6, 6, 244, 244)
  g.beginPath()
  g.moveTo(6, 170)
  g.lineTo(250, 170)
  g.moveTo(128, 6)
  g.lineTo(128, 170)
  g.stroke()
  // a bright horizontal light band
  const band = g.createLinearGradient(0, 196, 0, 214)
  band.addColorStop(0, 'rgba(34,229,255,0)')
  band.addColorStop(0.5, 'rgba(34,229,255,0.9)')
  band.addColorStop(1, 'rgba(34,229,255,0)')
  g.fillStyle = band
  g.fillRect(0, 196, 256, 18)
  // pink corner chevrons and small status lights
  g.strokeStyle = 'rgba(255,46,136,0.8)'
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(18, 40)
  g.lineTo(18, 18)
  g.lineTo(40, 18)
  g.moveTo(238, 150)
  g.lineTo(238, 160)
  g.lineTo(220, 160)
  g.stroke()
  for (let i = 0; i < 6; i++) {
    g.fillStyle = i % 3 === 0 ? 'rgba(255,209,102,0.9)' : 'rgba(34,229,255,0.7)'
    g.fillRect(150 + i * 14, 30, 8, 4)
  }
  return c
}

function displayCanvas(title: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 256
  const g = c.getContext('2d')
  if (!g) return c
  g.fillStyle = 'rgba(7,10,23,0.9)'
  g.fillRect(0, 0, 1024, 256)
  g.strokeStyle = '#22e5ff'
  g.lineWidth = 6
  g.strokeRect(8, 8, 1008, 240)
  g.strokeStyle = 'rgba(255,46,136,0.8)'
  g.lineWidth = 2
  g.strokeRect(22, 22, 980, 212)
  // scanlines
  g.fillStyle = 'rgba(34,229,255,0.05)'
  for (let y = 24; y < 232; y += 6) g.fillRect(24, y, 976, 2)
  g.font = '140px "Bebas Neue", Impact, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.shadowColor = '#ff2e88'
  g.shadowBlur = 24
  g.fillStyle = '#f2f7ff'
  g.fillText(title, 512, 136)
  return c
}
