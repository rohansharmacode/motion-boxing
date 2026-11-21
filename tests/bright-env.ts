// Visual harness for the bright island environment and boxing arena.
import { CapsuleGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three'
import { applyBrightEnvironment, buildIslandBackdrop, makeBlobShadow } from '../src/theme/bright/environment.ts'
import { buildBrightArena, CROWD_SEATS } from '../src/theme/bright/arena.ts'

const q = new URLSearchParams(location.search)
const view = q.get('view') ?? 'player'
const portrait = innerHeight > innerWidth

const renderer = new WebGLRenderer({ antialias: true })
renderer.setPixelRatio(1)
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new Scene()
const camera = new PerspectiveCamera(portrait ? 80 : 68, innerWidth / innerHeight, 0.03, 60)
let env
if (view === 'gk') {
  env = applyBrightEnvironment(scene, renderer, { shadowFocus: new Vector3(0, 0, -3), shadowSize: 20 })
  scene.add(buildIslandBackdrop({ exclude: { halfWidth: 6, near: 9, far: -14 } }))
  camera.fov = 50
  camera.far = 200
  camera.position.set(0, 2.2, 7)
  camera.lookAt(0, 1.2, -6)
} else {
  env = applyBrightEnvironment(scene, renderer, { shadowSize: 16 })
  scene.add(buildBrightArena())
  if (view === 'wide') {
    camera.position.set(9, 6, 9)
    camera.lookAt(0, 0, -3)
  } else if (view === 'back') {
    camera.position.set(0, 3, -16)
    camera.lookAt(0, 0.5, -2)
  } else {
    camera.position.set(0, 1.6, 0)
    camera.lookAt(0, 1.2, -2.1)
  }
  const body = new Mesh(new CapsuleGeometry(0.3, 0.9, 6, 16), new MeshStandardMaterial({ color: 0xff7f50, roughness: 0.7 }))
  body.position.set(0, 0.75, -2.1)
  body.castShadow = true
  scene.add(body)
  const blob = makeBlobShadow(0.5)
  blob.position.set(0, 0.005, -2.1)
  scene.add(blob)
  // Mark the seats with small beans.
  const seatGeo = new CapsuleGeometry(0.16, 0.3, 4, 8)
  const seatMat = new MeshStandardMaterial({ color: 0x7a5cff, roughness: 0.7 })
  for (const s of CROWD_SEATS) {
    const m = new Mesh(seatGeo, seatMat)
    m.position.set(s.x, s.y + 0.32, s.z)
    m.rotation.y = s.faceY
    m.castShadow = true
    scene.add(m)
  }
}
camera.updateProjectionMatrix()
let last = performance.now()
const loop = (now: number): void => {
  env.update(Math.min(0.05, (now - last) / 1000))
  last = now
  renderer.render(scene, camera)
  ;(window as unknown as { tris: number }).tris = renderer.info.render.triangles
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
