// Neon-grid set dressing shared by the goalkeeper and archery scenes. Original art.
// Dark glossy monolith towers with thin glowing edges and light bands, circuit traces etched
// into the floor, light-runners that draw glowing trails along the floor, slow data rings and
// drifting motes. Everything is merged or instanced: about eight draw calls in total.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

export interface Rect {
  x0: number
  x1: number
  z0: number
  z1: number
}

export interface TronArenaOptions {
  /** Seed for the layout, so each scene always looks the same. */
  seed: number
  /** Floor areas that get circuit traces. */
  circuits: Rect[]
  /** Straight runner tracks on the floor: from (x0,z0) to (x1,z1), ridden back and forth. */
  tracks: Array<[number, number, number, number]>
  /** Areas for the towers (kept away from the play area by the caller). */
  towers: Rect[]
  towerCount: number
  /** Tower height range, metres. */
  towerHeight: [number, number]
  /** Area for drifting motes and its height. */
  motes: Rect & { y: number }
  /** Primary and secondary glow colours. */
  colors?: [number, number]
}

export interface TronArena {
  readonly group: THREE.Group
  update(time: number): void
  dispose(): void
}

const CYAN = 0x22e5ff
const ORANGE = 0xff9a2e

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

const glow = (color: number, opacity: number): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })

export function buildTronArena(o: TronArenaOptions): TronArena {
  const rand = rng(o.seed)
  const [c1, c2] = o.colors ?? [CYAN, ORANGE]
  const group = new THREE.Group()
  group.name = 'tron-arena'
  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []
  const keep = <T extends THREE.BufferGeometry>(g: T): T => (geos.push(g), g)
  const keepM = <T extends THREE.Material>(m: T): T => (mats.push(m), m)
  const between = (a: number, b: number): number => a + (b - a) * rand()

  // ---------- circuit traces: Manhattan paths with a node pad at each end ----------
  const trace: number[] = []
  const traceAlt: number[] = []
  const pads: number[] = []
  for (const r of o.circuits) {
    const area = Math.abs((r.x1 - r.x0) * (r.z1 - r.z0))
    const n = Math.max(4, Math.round(area / 6))
    for (let i = 0; i < n; i++) {
      const out = rand() < 0.3 ? traceAlt : trace
      let x = between(r.x0, r.x1)
      let z = between(r.z0, r.z1)
      pads.push(x, 0.012, z)
      const steps = 2 + Math.floor(rand() * 3)
      for (let s = 0; s < steps; s++) {
        const len = between(0.6, 3.2)
        const dir = Math.floor(rand() * 4)
        const nx = Math.min(Math.max(x + (dir === 0 ? len : dir === 1 ? -len : 0), Math.min(r.x0, r.x1)), Math.max(r.x0, r.x1))
        const nz = Math.min(Math.max(z + (dir === 2 ? len : dir === 3 ? -len : 0), Math.min(r.z0, r.z1)), Math.max(r.z0, r.z1))
        out.push(x, 0.01, z, nx, 0.01, nz)
        x = nx
        z = nz
      }
      pads.push(x, 0.012, z)
    }
  }
  const lineSet = (pts: number[], color: number, opacity: number): void => {
    if (!pts.length) return
    const g = keep(new THREE.BufferGeometry())
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    group.add(new THREE.LineSegments(g, keepM(new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }))))
  }
  lineSet(trace, c1, 0.55)
  lineSet(traceAlt, c2, 0.5)
  if (pads.length) {
    const g = keep(new THREE.BufferGeometry())
    g.setAttribute('position', new THREE.Float32BufferAttribute(pads, 3))
    group.add(new THREE.Points(g, keepM(new THREE.PointsMaterial({ color: 0xf2f7ff, size: 0.09, transparent: true, opacity: 0.85, depthWrite: false }))))
  }

  // ---------- monolith towers: glossy dark blocks, glowing edges, light bands ----------
  const towerMat = keepM(new THREE.MeshStandardMaterial({ color: 0x080c18, roughness: 0.18, metalness: 0.85 }))
  const towerGeo = keep(new THREE.BoxGeometry(1, 1, 1))
  const towers = new THREE.InstancedMesh(towerGeo, towerMat, Math.max(1, o.towerCount))
  const edgeParts: THREE.BufferGeometry[] = []
  const bandParts: THREE.BufferGeometry[] = []
  const bandAltParts: THREE.BufferGeometry[] = []
  const tops: Array<[number, number, number]> = []
  const m4 = new THREE.Matrix4()
  const unitEdges = new THREE.EdgesGeometry(towerGeo)
  for (let i = 0; i < o.towerCount; i++) {
    const r = o.towers[i % o.towers.length]!
    const w = between(1.6, 4.2)
    const d = between(1.6, 4.2)
    const h = between(o.towerHeight[0], o.towerHeight[1])
    const x = between(r.x0, r.x1)
    const z = between(r.z0, r.z1)
    m4.compose(new THREE.Vector3(x, h / 2, z), new THREE.Quaternion(), new THREE.Vector3(w, h, d))
    towers.setMatrixAt(i, m4)
    const e = unitEdges.clone()
    e.applyMatrix4(m4)
    edgeParts.push(e)
    // Horizontal light bands on the front face.
    const bands = 2 + Math.floor(rand() * 4)
    for (let b = 0; b < bands; b++) {
      const y = h * (0.15 + 0.8 * rand())
      const band = new THREE.PlaneGeometry(w * 0.98, 0.07)
      band.translate(x, y, z + d / 2 + 0.01)
      ;(rand() < 0.3 ? bandAltParts : bandParts).push(band)
    }
    tops.push([x, h, z])
  }
  towers.instanceMatrix.needsUpdate = true
  unitEdges.dispose()
  group.add(towers)
  const mergedSet = (parts: THREE.BufferGeometry[], mat: THREE.Material, lines: boolean): void => {
    if (!parts.length) return
    const g = keep(mergeGeometries(parts) ?? new THREE.BufferGeometry())
    parts.forEach((p) => p.dispose())
    group.add(lines ? new THREE.LineSegments(g, mat) : new THREE.Mesh(g, mat))
  }
  mergedSet(edgeParts, keepM(new THREE.LineBasicMaterial({ color: c1, transparent: true, opacity: 0.75 })), true)
  mergedSet(bandParts, keepM(glow(c1, 0.8)), false)
  mergedSet(bandAltParts, keepM(glow(c2, 0.85)), false)

  // ---------- data rings hovering over the tallest towers ----------
  tops.sort((a, b) => b[1] - a[1])
  const ringGeo = keep(new THREE.TorusGeometry(1.4, 0.035, 6, 48))
  const ringMat = keepM(glow(c1, 0.7))
  const ringCount = Math.min(5, tops.length)
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, Math.max(1, ringCount))
  rings.count = ringCount
  group.add(rings)
  const ringBase = tops.slice(0, ringCount)

  // ---------- light runners: bright heads with fading trails along straight tracks ----------
  const SEG = 22
  const SEG_LEN = 0.45
  const runners = o.tracks.map((t, i) => ({
    t,
    len: Math.hypot(t[2] - t[0], t[3] - t[1]),
    speed: between(7, 12),
    phase: rand() * 100,
    color: i % 2 ? c2 : c1,
  }))
  const trailGeo = keep(new THREE.BoxGeometry(1, 1, 1))
  const trailMat = keepM(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }))
  const trails = new THREE.InstancedMesh(trailGeo, trailMat, Math.max(1, runners.length * SEG))
  trails.count = runners.length * SEG
  trails.frustumCulled = false
  const col = new THREE.Color()
  runners.forEach((r, i) => {
    for (let k = 0; k < SEG; k++) {
      const fade = 1 - k / SEG
      col.setHex(r.color).multiplyScalar(k === 0 ? 2.2 : 0.25 + 0.95 * fade)
      trails.setColorAt(i * SEG + k, col)
    }
  })
  if (trails.instanceColor) trails.instanceColor.needsUpdate = true
  group.add(trails)

  // ---------- motes ----------
  const MOTES = 220
  const motePos = new Float32Array(MOTES * 3)
  const moteSeed = new Float32Array(MOTES)
  const mr = o.motes
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = between(mr.x0, mr.x1)
    motePos[i * 3 + 1] = rand() * mr.y
    motePos[i * 3 + 2] = between(mr.z0, mr.z1)
    moteSeed[i] = rand()
  }
  const moteGeo = keep(new THREE.BufferGeometry())
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3))
  const moteMat = keepM(new THREE.PointsMaterial({ color: c1, size: 0.07, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }))
  const motes = new THREE.Points(moteGeo, moteMat)
  motes.frustumCulled = false
  group.add(motes)

  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  let lastMotes = 0

  return {
    group,
    update(time: number): void {
      // Runners ping-pong along their tracks; the trail samples the path behind the head.
      runners.forEach((r, i) => {
        const [x0, z0, x1, z1] = r.t
        const dx = (x1 - x0) / r.len
        const dz = (z1 - z0) / r.len
        const period = r.len * 2
        const head = (time * r.speed + r.phase) % period
        for (let k = 0; k < SEG; k++) {
          let d = head - k * SEG_LEN
          d = ((d % period) + period) % period
          const along = d <= r.len ? d : period - d
          p.set(x0 + dx * along, 0.06, z0 + dz * along)
          e.set(0, Math.atan2(dx, dz), 0)
          q.setFromEuler(e)
          s.set(k === 0 ? 0.16 : 0.07, k === 0 ? 0.12 : 0.1 * (1 - k / SEG) + 0.02, SEG_LEN * 1.05)
          m4.compose(p, q, s)
          trails.setMatrixAt(i * SEG + k, m4)
        }
      })
      trails.instanceMatrix.needsUpdate = true

      ringBase.forEach(([x, h, z], i) => {
        e.set(Math.PI / 2 + Math.sin(time * 0.4 + i) * 0.15, time * 0.3 + i, 0)
        q.setFromEuler(e)
        p.set(x, h + 1.2 + Math.sin(time * 0.8 + i * 1.7) * 0.25, z)
        s.setScalar(1 + 0.08 * Math.sin(time * 1.3 + i))
        m4.compose(p, q, s)
        rings.setMatrixAt(i, m4)
      })
      rings.instanceMatrix.needsUpdate = true
      ringMat.opacity = 0.55 + 0.2 * Math.sin(time * 2.1)

      // Motes rise slowly and wrap; updated at ~30 Hz to save upload bandwidth.
      if (time - lastMotes > 1 / 30) {
        const dt = Math.min(0.1, time - lastMotes)
        lastMotes = time
        for (let i = 0; i < MOTES; i++) {
          let y = motePos[i * 3 + 1]! + dt * (0.15 + 0.35 * moteSeed[i]!)
          if (y > mr.y) y = 0
          motePos[i * 3 + 1] = y
        }
        moteGeo.attributes.position!.needsUpdate = true
      }
    },
    dispose(): void {
      group.removeFromParent()
      geos.forEach((g) => g.dispose())
      mats.forEach((m) => m.dispose())
      towers.dispose()
      rings.dispose()
      trails.dispose()
    },
  }
}
