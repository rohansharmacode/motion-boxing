// Smooth fighter body from a CC0 glTF robot ("RobotExpressive" by Tomás Laulhé / Quaternius, CC0 1.0,
// public/models/robot.glb). Arms and hands are hidden: the gloves float free. The Idle clip loops for life.
// Loaded once and cloned per fighter; materials are cloned so each fighter can tint and flash on its own.
import { AnimationMixer, Color, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import type { AnimationClip, Material, Object3D, SkinnedMesh } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

const URL = `${import.meta.env.BASE_URL}models/robot.glb`
/** Target standing height, metres (matches the hit layout: head centre about 1.5 m). */
const HEIGHT = 1.72
/** Source model height in its own units (feet at 0). */
const MODEL_HEIGHT = 5.2
const HIDE = /^(Shoulder|Arm|Hand)/

let source: Promise<{ scene: Group; clips: AnimationClip[] }> | null = null
function load(): Promise<{ scene: Group; clips: AnimationClip[] }> {
  source ??= new GLTFLoader().loadAsync(URL).then((g) => ({ scene: g.scene as Group, clips: g.animations }))
  return source
}

export interface RobotBody {
  root: Group
  /** Main paint, cloned per fighter: tinted, and flashed white on hits. */
  paint: MeshStandardMaterial
  /** Advance the idle animation, seconds. */
  tick(dt: number): void
  /** Hide the head on the body and return a static copy of it in world space (KO). */
  detachHead(): Object3D | null
  reattachHead(): void
}

/**
 * Builds the robot into parent (body space: origin at the chest centre, floorY below it).
 * Returns null until the model has loaded; onReady fires once it is in place.
 */
export function loadRobotBody(parent: Object3D, floorY: number, tint: number, onReady: (body: RobotBody) => void): void {
  load()
    .then(({ scene, clips }) => {
      const model = cloneSkinned(scene) as Group
      let paint: MeshStandardMaterial | null = null
      let head: SkinnedMesh | null = null
      const cloned = new Map<Material, Material>()
      model.traverse((o) => {
        const m = o as Mesh
        if (!m.isMesh) return
        if (HIDE.test(m.name)) {
          m.visible = false
          return
        }
        if (m.name.startsWith('Head') && !head) head = m as unknown as SkinnedMesh
        m.frustumCulled = false
        // The source is low-poly with flat normals: weld the vertices and smooth the normals.
        const g = m.geometry.clone()
        g.deleteAttribute('normal')
        const welded = mergeVertices(g, 1e-4)
        welded.computeVertexNormals()
        m.geometry = welded
        const mat = m.material as Material
        let c = cloned.get(mat)
        if (!c) {
          c = mat.clone()
          cloned.set(mat, c)
          if (c instanceof MeshStandardMaterial) {
            c.flatShading = false
            c.roughness = 0.45
            c.metalness = 0.2
            if (mat.name === 'Main') {
              c.color.setHex(tint)
              c.emissive = new Color(tint).multiplyScalar(0.08)
              paint = c
            }
          }
        }
        m.material = c
      })
      // The source robot stands on y = 0 and is about MODEL_HEIGHT units tall (skinned bounds are unreliable).
      model.scale.setScalar(HEIGHT / MODEL_HEIGHT)
      model.position.y = floorY
      parent.add(model)
      const mixer = new AnimationMixer(model)
      const idle = clips.find((c) => c.name === 'Idle')
      if (idle) mixer.clipAction(idle).play()

      // The source head is cartoon-big; shrink it so the body reads as a sleek fighter, not a mascot.
      const bones: Object3D[] = []
      model.traverse((o) => {
        if ((o as { isBone?: boolean }).isBone && o.name === 'Head') bones.push(o)
      })
      const headBone = bones[0]
      const HEAD_SCALE = 0.72
      if (headBone) headBone.scale.setScalar(HEAD_SCALE)

      let detached: Mesh | null = null
      onReady({
        root: model,
        paint: paint ?? new MeshStandardMaterial(),
        tick: (dt) => {
          mixer.update(dt)
          if (headBone) headBone.scale.setScalar(HEAD_SCALE)
        },
        detachHead() {
          const h = head as SkinnedMesh | null
          if (!h) return null
          // Bake the skinned head in its current pose into a plain mesh, in world space.
          model.updateMatrixWorld(true)
          const geo = h.geometry.clone()
          const pos = geo.attributes.position!
          const v = new Vector3()
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i)
            h.applyBoneTransform(i, v)
            v.applyMatrix4(h.matrixWorld)
            pos.setXYZ(i, v.x, v.y, v.z)
          }
          geo.deleteAttribute('skinIndex')
          geo.deleteAttribute('skinWeight')
          geo.computeBoundingBox()
          const centre = geo.boundingBox!.getCenter(new Vector3())
          geo.translate(-centre.x, -centre.y, -centre.z)
          geo.computeVertexNormals()
          const mesh = new Mesh(geo, h.material)
          mesh.position.copy(centre)
          h.visible = false
          detached = mesh
          return mesh
        },
        reattachHead() {
          if (head) (head as SkinnedMesh).visible = true
          if (detached) {
            detached.removeFromParent()
            detached.geometry.dispose()
            detached = null
          }
        },
      })
    })
    .catch((err) => console.warn('[boxing] robot model failed to load, keeping the built-in body', err))
}
