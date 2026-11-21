// Visual harness for the bright character kit: opponent from the player's eye, first-person gloves, a crowd.
import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'
import { buildBrightGlove, buildBrightOpponent } from '../src/theme/bright/boxer.ts'
import { buildBean, buildCrowd, buildFigurine } from '../src/theme/bright/avatar.ts'
import { createGlowTexture, DRONE } from '../src/sports/boxing/sceneParts.ts'
import { BOXING, LAND, RING, SKY } from '../src/theme/bright/palette.ts'

const q = new URLSearchParams(location.search)
const view = q.get('view') ?? 'player'
const charge = Number(q.get('charge') ?? 0)
const lunge = Number(q.get('lunge') ?? 0)
const flash = q.get('flash')
const ko = q.has('ko')
const hook = q.has('hook') ? 1 : 0
const slam = q.has('slam') ? 1 : 0

const renderer = new WebGLRenderer({ antialias: true })
renderer.setPixelRatio(1)
renderer.setSize(innerWidth, innerHeight)
renderer.outputColorSpace = SRGBColorSpace
renderer.shadowMap.enabled = true
renderer.shadowMap.type = PCFSoftShadowMap
document.body.appendChild(renderer.domElement)

const scene = new Scene()
scene.background = new Color(SKY.mid)
scene.add(new HemisphereLight(0xffffff, LAND.sand, 1.6))
const sun = new DirectionalLight(0xffffff, 2.2)
sun.position.set(2.5, 6, 3)
sun.target.position.set(0, 0, -3)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 20 })
sun.shadow.bias = -0.0005
sun.shadow.normalBias = 0.02
scene.add(sun, sun.target)

const ground = new Mesh(new PlaneGeometry(40, 40), new MeshStandardMaterial({ color: RING.mat, roughness: 0.9 }))
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)

const camera = new PerspectiveCamera(68, innerWidth / innerHeight, 0.05, 100)
scene.add(camera)

// Opponent, animated like the boxing scene does.
const opp = buildBrightOpponent(createGlowTexture())
scene.add(opp.root, opp.floorGlow)

// First-person gloves in front of the camera.
const gloves = (['left', 'right'] as const).map((hand) => {
  const g = buildBrightGlove(hand)
  const side = hand === 'left' ? -1 : 1
  g.group.position.set(side * 0.2, -0.2, -0.6)
  g.group.rotation.set(0.5, -side * -0.14, 0)
  g.shell.emissiveIntensity = 0.5
  g.glow.opacity = 0.2
  camera.add(g.group)
  return g
})

// Bleachers with a crowd behind the ring, plus two standing beans by the ring.
const seats: { x: number; y: number; z: number; faceY: number }[] = []
const benchMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 })
for (let row = 0; row < 3; row++) {
  const y = 0.45 + row * 0.45
  const z = -6.2 - row * 0.7
  const bench = new Mesh(new BoxGeometry(9, 0.45 + row * 0.45, 0.7), benchMat)
  bench.position.set(0, (0.45 + row * 0.45) / 2, z)
  bench.receiveShadow = true
  scene.add(bench)
  for (let i = 0; i < 12; i++) seats.push({ x: -3.9 + i * 0.7 + (row % 2) * 0.35, y, z: z + 0.05, faceY: 0 })
}
const crowd = buildCrowd(seats, 3)
scene.add(crowd.root)
if (q.has('cheer')) crowd.cheer()
const standers = [buildBean({ seed: 4, height: 1.5 }), buildBean({ seed: 11, height: 1.7 }), buildBean({ seed: 6, seated: true, height: 1.6 })]
standers[0].root.position.set(-3, 0, -3.5)
standers[0].root.rotation.y = 0.6
standers[1].root.position.set(3, 0, -3.8)
standers[1].root.rotation.y = -0.5
standers[2].root.position.set(2.2, 0.45, -2.2)
standers[2].root.rotation.y = -0.4
const stool = new Mesh(new BoxGeometry(0.5, 0.45, 0.5), benchMat)
stool.position.set(2.2, 0.225, -2.2)
stool.castShadow = true
scene.add(stool)
for (const b of standers) scene.add(b.root)
const figurine = buildFigurine({ seed: 9, height: 1.2, base: 0x8fd3fb })
figurine.position.set(-1.7, 0, -1.9)
figurine.rotation.y = 0.5
scene.add(figurine)

if (view === 'side') {
  camera.position.set(1.4, 1.35, -0.6)
  camera.lookAt(0, 1.05, DRONE.z)
} else if (view === 'crowd') {
  camera.position.set(0, 2.2, -2.5)
  camera.lookAt(0, 1, -6.8)
} else {
  camera.position.set(0, 1.6, 0)
  camera.lookAt(0, 1.2, DRONE.z)
}

const RED = new Color(BOXING.telegraph)
const WHITE = new Color(0xffffff)
const CORE = new Color(BOXING.droneCore)
const ACCENT = new Color(BOXING.drone)
let time = 0
let frames = 0
function frame(): void {
  const dt = 1 / 60
  time += dt
  if (ko) {
    opp.root.position.set(0.3, DRONE.restY, DRONE.z - 0.4)
    opp.body.rotation.set(-Math.PI / 2, 0, 0.3)
  } else {
    opp.root.position.set(Math.sin(time * 0.6) * 0.08, DRONE.y + Math.sin(time * 1.7) * 0.05 + slam * 0.32, DRONE.z + lunge * 1.15)
    opp.body.rotation.set(lunge * 0.32 + Math.sin(time * 1.1) * 0.03 - slam * 0.38, Math.sin(time * 0.5) * 0.12 + hook * 0.6, Math.sin(time * 0.9) * 0.06 + hook * 0.12)
    opp.pods.forEach((pod, i) => {
      const lead = i === 1 ? hook : 0
      pod.position.set(
        (i === 0 ? -1 : 1) * (DRONE.podX + lead * 0.34 - lunge * 0.1 - slam * 0.12),
        DRONE.podY + Math.sin(time * 2.2 + i * 1.7) * 0.025 + lead * 0.3 + slam * 0.24,
        DRONE.podZ + lunge * 0.28 - lead * 0.2 - slam * 0.06,
      )
    })
    opp.orb.position.z = DRONE.orbZ - 0.07 * charge
  }
  opp.neckRing.rotation.z += dt * 2.2
  for (const [part, f] of [
    [opp.head, flash === 'head' ? 1 : 0],
    [opp.chest, flash === 'chest' ? 1 : 0],
  ] as const) {
    part.shell.emissive.setScalar(0.8 * f)
    part.halo.opacity = 0.07 + 0.45 * f + 0.1 * charge
    part.core.color.copy(CORE).lerp(RED, charge).lerp(WHITE, f)
  }
  opp.accent.color.copy(ACCENT).lerp(RED, charge)
  opp.accentSolid.color.copy(opp.accent.color)
  opp.telegraph.visible = opp.telegraphGuide.visible = charge > 0
  opp.telegraph.scale.setScalar(0.55 + 0.45 * charge)
  opp.telegraph.material.opacity = 0.2 + 0.8 * charge
  opp.telegraphGuide.material.opacity = 0.25 * charge
  crowd.update(dt)
  renderer.render(scene, camera)
  frames++
  if (frames === 30) (window as unknown as { __ready: boolean }).__ready = true
  requestAnimationFrame(frame)
}
frame()
void Vector3
void gloves
