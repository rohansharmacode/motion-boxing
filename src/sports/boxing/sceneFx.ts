// Cheap punch juice for the boxing scene: tapered glove ribbon trails and billboard impact shockwave rings.
// Both are a handful of additive triangles updated in place, so they cost next to nothing to draw.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Vector3,
} from 'three'
import type { Quaternion } from 'three'

const TRAIL_POINTS = 9
/** Ribbon half-width at the glove, metres; it tapers to 0 at the tail. */
const TRAIL_WIDTH = 0.055

export interface GloveTrail {
  mesh: Mesh
  /**
   * Push the glove's newest position (same space as the mesh's parent). strength 0 to 1 sets brightness;
   * advanced false (hit-stop) holds the trail in place. eye is the camera position in that space.
   */
  update(head: Vector3, strength: number, eye: Vector3, advanced: boolean): void
  reset(head: Vector3): void
  dispose(): void
}

export function createGloveTrail(color: Color): GloveTrail {
  const pts = Array.from({ length: TRAIL_POINTS }, () => new Vector3())
  const positions = new Float32Array(TRAIL_POINTS * 2 * 3)
  const colors = new Float32Array(TRAIL_POINTS * 2 * 3)
  const index: number[] = []
  for (let i = 0; i < TRAIL_POINTS - 1; i++) {
    const a = i * 2
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const geo = new BufferGeometry()
  const posAttr = new BufferAttribute(positions, 3)
  const colAttr = new BufferAttribute(colors, 3)
  geo.setAttribute('position', posAttr)
  geo.setAttribute('color', colAttr)
  geo.setIndex(index)
  const mat = new MeshBasicMaterial({
    vertexColors: true,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
    toneMapped: false,
  })
  const mesh = new Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = 5
  mesh.visible = false
  let level = 0
  const dir = new Vector3()
  const toEye = new Vector3()
  const side = new Vector3()

  return {
    mesh,
    update(head, strength, eye, advanced) {
      if (advanced) {
        for (let i = TRAIL_POINTS - 1; i > 0; i--) pts[i].copy(pts[i - 1])
        pts[0].copy(head)
        // Ease brightness so a trail fades out over a few frames instead of popping off.
        level = strength > level ? strength : level * 0.8
      }
      if (level < 0.02) {
        mesh.visible = false
        return
      }
      mesh.visible = true
      for (let i = 0; i < TRAIL_POINTS; i++) {
        const prev = pts[Math.max(0, i - 1)]
        const next = pts[Math.min(TRAIL_POINTS - 1, i + 1)]
        dir.subVectors(prev, next)
        toEye.subVectors(eye, pts[i])
        side.crossVectors(dir, toEye)
        const len = side.length()
        const u = i / (TRAIL_POINTS - 1)
        const w = TRAIL_WIDTH * (1 - u)
        if (len > 1e-6) side.multiplyScalar(w / len)
        else side.set(0, 0, 0)
        const o = i * 6
        positions[o] = pts[i].x + side.x
        positions[o + 1] = pts[i].y + side.y
        positions[o + 2] = pts[i].z + side.z
        positions[o + 3] = pts[i].x - side.x
        positions[o + 4] = pts[i].y - side.y
        positions[o + 5] = pts[i].z - side.z
        // White-hot at the glove, glove colour along the tail, black (invisible when additive) at the end.
        const fade = level * (1 - u) ** 1.4
        const hot = Math.max(0, 1 - u * 3) * 0.6
        for (const k of [0, 3]) {
          colors[o + k] = (color.r + hot) * fade
          colors[o + k + 1] = (color.g + hot) * fade
          colors[o + k + 2] = (color.b + hot) * fade
        }
      }
      posAttr.needsUpdate = true
      colAttr.needsUpdate = true
    },
    reset(head) {
      for (const p of pts) p.copy(head)
      level = 0
      mesh.visible = false
    },
    dispose() {
      geo.dispose()
      mat.dispose()
    },
  }
}

interface Wave {
  mesh: Mesh
  mat: MeshBasicMaterial
  age: number
  life: number
  size: number
}

export interface Shockwaves {
  group: Group
  /** A crisp ring at a world point: size is the final radius in metres, life in seconds. */
  spawn(at: Vector3, color: Color, size: number, life?: number): void
  /** dt in scene seconds (frozen during hit-stop, so the ring holds on the impact frame). */
  update(dt: number, cameraQuat: Quaternion): void
  clear(): void
  dispose(): void
}

export function createShockwaves(count = 8): Shockwaves {
  const group = new Group()
  const geo = new RingGeometry(0.82, 1, 48, 1)
  const waves: Wave[] = []
  for (let i = 0; i < count; i++) {
    const mat = new MeshBasicMaterial({
      color: 0xffffff,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
      fog: false,
      toneMapped: false,
    })
    const mesh = new Mesh(geo, mat)
    mesh.visible = false
    mesh.renderOrder = 6
    mesh.frustumCulled = false
    group.add(mesh)
    waves.push({ mesh, mat, age: 0, life: 1, size: 1 })
  }
  let next = 0

  return {
    group,
    spawn(at, color, size, life = 0.26) {
      const w = waves[next]
      next = (next + 1) % waves.length
      w.mesh.position.copy(at)
      w.mat.color.copy(color)
      w.age = 0
      w.life = life
      w.size = size
      w.mesh.scale.setScalar(size * 0.12)
      w.mat.opacity = 1
      w.mesh.visible = true
    },
    update(dt, cameraQuat) {
      for (const w of waves) {
        if (!w.mesh.visible) continue
        w.age += dt
        const t = w.age / w.life
        if (t >= 1) {
          w.mesh.visible = false
          continue
        }
        const e = 1 - (1 - t) ** 3
        w.mesh.scale.setScalar(w.size * (0.12 + 0.88 * e))
        w.mat.opacity = (1 - t) ** 1.6
        w.mesh.quaternion.copy(cameraQuat)
      }
    },
    clear() {
      for (const w of waves) w.mesh.visible = false
    },
    dispose() {
      geo.dispose()
      for (const w of waves) w.mat.dispose()
    },
  }
}
