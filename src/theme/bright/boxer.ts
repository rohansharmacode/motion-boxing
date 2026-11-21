// Bright theme boxing models: an original chunky gummy-bean sparring partner and cartoon first-person gloves.
// Both satisfy the neon builders' contracts (DroneParts / GloveParts) so the boxing scene animates them as is.
import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { Material, Object3D, Texture } from 'three'
import type { DroneParts, GloveParts } from '../../sports/boxing/sceneParts.ts'
import { DRONE } from '../../sports/boxing/sceneParts.ts'
import type { Hand } from '../../pose/types.ts'
import { glossy, beanGeometry, beanRadius, beanU, buildFace, onSurface, splitByHeight, toy } from './avatar.ts'
import { BOXING, SKIN } from './palette.ts'

/** Opponent look. Original local colours on top of the shared palette. */
const LOOK = {
  skin: SKIN[1],
  shorts: 0x8a5cf0,
  gloves: 0xb07cff,
  shoes: 0xffffff,
  sole: BOXING.drone,
} as const

const shadowed = (o: Object3D): void => {
  o.traverse((c) => {
    const m = c as Mesh
    if (m.isMesh && !(m.material as Material).transparent) m.castShadow = true
  })
}

// ---------- glove model (shared by player and opponent) ----------

interface GloveMats {
  shell: MeshStandardMaterial
  cuff: Material
  lace: Material
  stripe: Material
  glow?: MeshBasicMaterial
}

/** Rounded cartoon boxing glove, knuckles toward -z, cuff toward +z. R is the fist radius. */
function gloveModel(R: number, inward: number, mats: GloveMats): Group {
  const g = new Group()
  const mitt = new Mesh(new SphereGeometry(R, 28, 20), mats.shell)
  mitt.scale.set(1, 0.92, 1.18)
  // Fat padded knuckle roll on the front-top.
  const roll = new Mesh(new SphereGeometry(R * 0.82, 24, 16), mats.shell)
  roll.position.set(0, R * 0.16, -R * 0.32)
  roll.scale.set(1.08, 0.9, 1)
  // Thumb lies along the side of the fist on the inward side.
  const thumb = new Mesh(new CapsuleGeometry(R * 0.33, R * 0.62, 4, 12), mats.shell)
  thumb.rotation.x = Math.PI / 2 - 0.25
  thumb.rotation.z = inward * 0.2
  thumb.position.set(inward * R * 0.82, -R * 0.12, -R * 0.12)
  // White cuff with a coloured lacing stripe on top.
  const cuffLen = R * 1.0
  const cuff = new Mesh(new CylinderGeometry(R * 0.7, R * 0.76, cuffLen, 24, 1, true), mats.cuff)
  cuff.rotation.x = Math.PI / 2
  cuff.position.z = R * 1.08
  // Rounded padded end instead of an open tube.
  const cap = new Mesh(new SphereGeometry(R * 0.76, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mats.cuff)
  cap.rotation.x = Math.PI / 2
  cap.scale.set(1, 0.45, 1)
  cap.position.z = R * 1.08 + cuffLen / 2
  const cuffLip = new Mesh(new TorusGeometry(R * 0.74, R * 0.075, 8, 28), mats.stripe)
  cuffLip.position.z = R * 0.62
  const stripe = new Mesh(new BoxGeometry(R * 0.32, R * 0.08, cuffLen * 0.92), mats.stripe)
  stripe.position.set(0, R * 0.72, R * 1.08)
  stripe.rotation.x = -0.03
  g.add(mitt, roll, thumb, cuff, cap, cuffLip, stripe)
  const laceGeo = new BoxGeometry(R * 0.42, R * 0.05, R * 0.06)
  for (let i = 0; i < 3; i++) {
    const lace = new Mesh(laceGeo, mats.lace)
    lace.position.set(0, R * 0.765, R * (0.78 + i * 0.3))
    lace.rotation.y = i % 2 ? 0.5 : -0.5
    g.add(lace)
  }
  if (mats.glow) {
    const rim = new Mesh(new SphereGeometry(R * 1.08, 24, 16), mats.glow)
    rim.scale.set(1.04, 0.98, 1.2)
    rim.position.z = R * 0.1
    rim.renderOrder = -1
    g.add(rim)
  }
  return g
}

/** First-person glove. Same orientation and size contract as the neon buildGlove. */
export function buildBrightGlove(hand: Hand): GloveParts {
  const color = new Color(hand === 'left' ? BOXING.left : BOXING.right)
  const inward = hand === 'left' ? 1 : -1
  const shell = glossy({
    color,
    emissive: color.clone().multiplyScalar(0.12),
    emissiveIntensity: 0.5,
    roughness: 0.2,
    metalness: 0,
  })
  const glow = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.08,
    side: BackSide,
    depthWrite: false,
  })
  const model = gloveModel(0.085, inward, {
    shell,
    cuff: glossy({ color: 0xffffff, roughness: 0.45 }),
    stripe: glossy({ color: color.clone().lerp(new Color(0xffffff), 0.15), roughness: 0.3 }),
    lace: glossy({ color: 0xffffff, roughness: 0.5 }),
    glow,
  })
  model.scale.setScalar(0.68) // same size as the neon glove
  const group = new Group()
  group.add(model)
  return { group, shell, glow }
}

// ---------- opponent ----------

/** Rim ring along a bean band edge (foot space y), drawn with the accent line material. */
function hemLoop(y: number, offset: number, mat: LineBasicMaterial, segments = 48): LineLoop {
  const r = beanRadius(y) + offset
  const pts: Vector3[] = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    pts.push(new Vector3(Math.sin(a) * r, y, Math.cos(a) * r))
  }
  return new LineLoop(new BufferGeometry().setFromPoints(pts), mat)
}

/** Chunky gummy-bean boxer: headband (head core), waistband (chest core), big glossy gloves on the pods. */
export function buildBrightOpponent(glowMap: Texture): DroneParts {
  const root = new Group()
  root.position.set(0, DRONE.y, DRONE.z)
  const body = new Group()
  root.add(body)
  // Figure in foot space (feet at y=0): feet land on the floor when root is at DRONE.y.
  const fig = new Group()
  fig.position.y = -DRONE.y
  body.add(fig)

  const skinRest = (): MeshStandardMaterial =>
    glossy({ color: LOOK.skin, emissive: 0x000000, emissiveIntensity: 1 })
  const headShell = skinRest()
  const chestShell = skinRest()
  const limbSkin = toy(LOOK.skin)
  const headCore = new MeshBasicMaterial({ color: BOXING.droneCore })
  const chestCore = new MeshBasicMaterial({ color: BOXING.droneCore })
  const accent = new LineBasicMaterial({ color: BOXING.drone })
  const accentSolid = new MeshBasicMaterial({ color: BOXING.drone })

  // One bean for head and torso: the upper part flashes on head hits, the lower part on body hits.
  const beanGeo = splitByHeight(beanGeometry(40, 36), 1.3)
  const bean = new Mesh(beanGeo, [chestShell, headShell])
  fig.add(bean)

  // Face, a little determined.
  fig.add(buildFace('determined'))

  // Headband with two tails at the back.
  const bandGeo = beanGeometry(40, 4, 0.014, beanU(1.6), beanU(1.665))
  const band = new Mesh(bandGeo, headCore)
  fig.add(band)
  const tailGeo = new CapsuleGeometry(0.03, 0.13, 3, 8)
  for (const side of [-1, 1]) {
    const tail = onSurface(new Mesh(tailGeo, headCore), 1.62, Math.PI + side * 0.18, 0.02)
    tail.rotateX(-0.9)
    tail.rotateZ(side * 0.5)
    tail.translateY(-0.06)
    tail.scale.set(1, 1, 0.45)
    fig.add(tail)
  }
  const knot = onSurface(new Mesh(new SphereGeometry(0.045, 12, 8), headCore), 1.63, Math.PI, 0.01)
  knot.scale.set(1, 1, 0.6)
  fig.add(knot)

  // Boxing shorts: puffy band over the bottom of the bean, white waistband, accent hem lines, leg cuffs.
  const shortsMat = toy(LOOK.shorts)
  const shorts = new Mesh(beanGeometry(40, 10, 0.02, -1, beanU(0.86)), shortsMat)
  const waist = new Mesh(beanGeometry(40, 3, 0.03, beanU(0.84), beanU(0.92)), chestCore)
  fig.add(shorts, waist)
  fig.add(hemLoop(0.84, 0.032, accent), hemLoop(0.92, 0.032, accent))

  // Stubby legs, shorts leg cuffs and little shoes; feet rest on y=0.
  const legGeo = new CapsuleGeometry(0.11, 0.26, 4, 14)
  const cuffGeo = new CylinderGeometry(0.14, 0.155, 0.16, 20)
  const hemGeo = new TorusGeometry(0.153, 0.018, 6, 24)
  const shoeGeo = new SphereGeometry(0.12, 20, 12)
  const soleGeo = new CylinderGeometry(0.118, 0.118, 0.035, 20)
  for (const side of [-1, 1]) {
    const leg = new Mesh(legGeo, limbSkin)
    leg.position.set(side * 0.155, 0.33, 0)
    const cuff = new Mesh(cuffGeo, shortsMat)
    cuff.position.set(side * 0.16, 0.54, 0)
    const hem = new Mesh(hemGeo, accentSolid)
    hem.rotation.x = Math.PI / 2
    hem.position.set(side * 0.16, 0.465, 0)
    const shoe = new Mesh(shoeGeo, toy(LOOK.shoes))
    shoe.scale.set(1, 0.6, 1.4)
    shoe.position.set(side * 0.16, 0.085, 0.05)
    const sole = new Mesh(soleGeo, toy(LOOK.sole))
    sole.scale.set(1, 1, 1.4)
    sole.position.set(side * 0.16, 0.02, 0.05)
    fig.add(leg, cuff, hem, shoe, sole)
  }

  // Gloves ride the pods ([left, right]); the scene sets each pod's full position every frame (guard bob,
  // wind-ups, hooks, overhead slams). Noodle arms stretch from fixed shoulders to the moving gloves.
  const gloveShell = glossy({ color: LOOK.gloves, roughness: 0.2, metalness: 0 })
  const gloveMats: GloveMats = {
    shell: gloveShell,
    cuff: toy(0xffffff, 0.45),
    stripe: toy(LOOK.shorts, 0.35),
    lace: toy(0xffffff, 0.5),
  }
  const armGeo = new CylinderGeometry(0.075, 0.075, 1, 14, 1, true)
  const shoulderGeo = new SphereGeometry(0.09, 16, 10)
  const up = new Vector3(0, 1, 0)
  const pods = [-1, 1].map((side) => {
    const pod = new Group()
    pod.position.set(side * DRONE.podX, DRONE.podY, DRONE.podZ)
    const glove = gloveModel(0.125, side, gloveMats)
    glove.rotation.y = Math.PI // knuckles toward the player
    glove.rotation.x = 0.25
    glove.position.set(-side * 0.22, 0.28, 0.33)
    pod.add(glove)
    body.add(pod)

    const shoulderAt = new Vector3(side * 0.3, 0.13, 0)
    const shoulder = new Mesh(shoulderGeo, limbSkin)
    shoulder.position.copy(shoulderAt)
    const wristOff = new Vector3(-side * 0.22, 0.24, 0.2)
    const arm = new Mesh(armGeo, limbSkin)
    arm.frustumCulled = false
    const wrist = new Vector3()
    const aim = (): void => {
      wrist.copy(pod.position).add(wristOff).sub(shoulderAt)
      const len = Math.max(0.05, wrist.length())
      arm.position.copy(shoulderAt).addScaledVector(wrist, 0.5)
      arm.quaternion.setFromUnitVectors(up, wrist.multiplyScalar(1 / len))
      arm.scale.set(1, len, 1)
      arm.updateMatrixWorld()
    }
    aim()
    arm.onBeforeRender = aim
    arm.onBeforeShadow = aim
    body.add(shoulder, arm)
    return pod
  })

  // Belt buckle = the chest "orb": the scene sets orb.position.z (pulls in while a straight charges).
  const buckleHolder = new Group()
  buckleHolder.position.set(0, 0.88 - DRONE.y, beanRadius(0.88) + 0.035 - DRONE.orbZ)
  const orb = new Mesh(new SphereGeometry(0.075, 20, 12), chestCore)
  orb.scale.set(1.25, 0.85, 0.4)
  orb.position.z = DRONE.orbZ
  buckleHolder.add(orb)
  body.add(buckleHolder)

  // Unused neon bits: kept to satisfy the contract, never drawn.
  const neckRing = new Mesh(new TorusGeometry(0.1, 0.01, 4, 8), new MeshBasicMaterial())
  neckRing.visible = false
  body.add(neckRing)
  const thruster = new Mesh(new ConeGeometry(0.09, 0.32, 6, 1, true), new MeshBasicMaterial({ transparent: true, opacity: 0 }))
  thruster.visible = false
  body.add(thruster)
  const floorGlow = new Mesh(
    new PlaneGeometry(2, 2),
    new MeshBasicMaterial({ map: glowMap, color: BOXING.drone, transparent: true, opacity: 0.35, depthWrite: false }),
  )
  floorGlow.rotation.x = -Math.PI / 2
  floorGlow.position.set(0, 0.01, DRONE.z)
  floorGlow.visible = false // real shadows ground the boxer

  // Hit zones (exact contract) and soft white "pop" rims that light up on a hit.
  const chestCenter = new Vector3(0, 0, 0.12)
  const headCenter = new Vector3(0, DRONE.headY, 0.04)
  const rim = (): MeshBasicMaterial =>
    new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, side: BackSide, depthWrite: false })
  const headHalo = rim()
  const chestHalo = rim()
  const headPop = new Mesh(new SphereGeometry(0.315, 24, 16), headHalo)
  headPop.position.set(0, DRONE.headY + 0.04, 0)
  headPop.scale.set(1.02, 1.06, 1)
  const chestPop = new Mesh(new SphereGeometry(0.37, 24, 16), chestHalo)
  chestPop.position.set(0, -0.08, 0)
  chestPop.scale.set(1.02, 1.12, 1)
  body.add(headPop, chestPop)

  // Telegraph: solid red rings that read on a bright background.
  const ringMat = (): MeshBasicMaterial =>
    new MeshBasicMaterial({ color: BOXING.telegraph, transparent: true, opacity: 0, depthWrite: false })
  const telegraph = new Mesh(new TorusGeometry(0.8, 0.045, 10, 72), ringMat())
  const telegraphGuide = new Mesh(new TorusGeometry(0.8, 0.016, 6, 72), ringMat())
  for (const ring of [telegraph, telegraphGuide]) {
    ring.position.set(0, DRONE.ringY, DRONE.ringZ)
    ring.visible = false
    ring.renderOrder = 2
    root.add(ring)
  }

  shadowed(body)

  return {
    root,
    body,
    head: { center: headCenter, radius: DRONE.headRadius, shell: headShell, halo: headHalo, core: headCore },
    chest: { center: chestCenter, radius: DRONE.chestRadius, shell: chestShell, halo: chestHalo, core: chestCore },
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
