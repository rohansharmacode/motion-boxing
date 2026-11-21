// Bright theme boxing models: an original toy-figure sparring partner and cartoon first-person gloves.
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
import { armGeometry, BODY, buildFigure, glossy, SHOULDER, stretchArm, toy } from './avatar.ts'
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

/** Horizontal ring of accent line at height y (body space), radius r. */
function hemLoop(y: number, r: number, mat: LineBasicMaterial, zScale = 1, segments = 48): LineLoop {
  const pts: Vector3[] = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    pts.push(new Vector3(Math.sin(a) * r, y, Math.cos(a) * r * zScale))
  }
  return new LineLoop(new BufferGeometry().setFromPoints(pts), mat)
}

/** Friendly toy-figure boxer: round head with headband (head core), belt (chest core), gloves on the pods. */
export function buildBrightOpponent(glowMap: Texture): DroneParts {
  const root = new Group()
  root.position.set(0, DRONE.y, DRONE.z)
  const body = new Group()
  root.add(body)

  const skinRest = (): MeshStandardMaterial => glossy({ color: LOOK.skin, emissive: 0x000000, emissiveIntensity: 1 })
  const headShell = skinRest()
  const chestShell = skinRest()
  const limbSkin = toy(LOOK.skin)
  const headCore = new MeshBasicMaterial({ color: BOXING.droneCore })
  const chestCore = new MeshBasicMaterial({ color: BOXING.droneCore })
  const accent = new LineBasicMaterial({ color: BOXING.drone })
  const accentSolid = new MeshBasicMaterial({ color: BOXING.drone })
  const shortsMat = toy(LOOK.shorts)

  // Humanoid in foot space (feet at y=0) so the feet touch the floor when root is at DRONE.y.
  // Head centre lands at body (0, 0.52, 0.02) with radius 0.2: the head hit zone.
  const figure = buildFigure(
    { skin: limbSkin, head: headShell, shirt: chestShell, shorts: shortsMat, shoes: toy(LOOK.shoes) },
    { hair: 'spiky', hairColor: 0x3b2a20, brows: 'determined', hands: false },
  )
  const fig = figure.fig
  fig.position.y = -DRONE.y
  body.add(fig)

  // Headband over the hair, tipped back like the hair cap, with a knot and two tails.
  const band = new Mesh(new SphereGeometry(BODY.headR * 1.11, 40, 3, 0, Math.PI * 2, 0.82, 0.3), headCore)
  band.rotation.x = -0.3
  const knot = new Mesh(new SphereGeometry(0.04, 12, 8), headCore)
  knot.position.set(0, 0.09, -0.21)
  knot.scale.set(1, 1, 0.6)
  figure.head.add(band, knot)
  const tailGeo = new CapsuleGeometry(0.026, 0.12, 3, 8)
  for (const side of [-1, 1]) {
    const tail = new Mesh(tailGeo, headCore)
    tail.position.set(side * 0.045, 0.02, -0.23)
    tail.rotation.set(0.5, 0, side * 0.55)
    tail.scale.set(1, 1, 0.45)
    figure.head.add(tail)
  }

  // Belt with accent trim lines; leg cuffs with accent hems; orange soles.
  const beltY = 0.775
  const belt = new Mesh(new CylinderGeometry(0.232, 0.232, 0.075, 40, 1, true), chestCore)
  belt.position.y = beltY
  belt.scale.z = 0.95
  fig.add(belt, hemLoop(beltY + 0.038, 0.235, accent, 0.95), hemLoop(beltY - 0.038, 0.235, accent, 0.95))
  const cuffGeo = new CylinderGeometry(0.112, 0.12, 0.12, 20)
  const hemGeo = new TorusGeometry(0.118, 0.014, 6, 24)
  const soleGeo = new CylinderGeometry(0.097, 0.097, 0.03, 20)
  for (const side of [-1, 1]) {
    const x = side * BODY.legX
    const cuff = new Mesh(cuffGeo, shortsMat)
    cuff.position.set(x * 1.08, 0.53, 0)
    const hem = new Mesh(hemGeo, accentSolid)
    hem.rotation.x = Math.PI / 2
    hem.position.set(x * 1.08, 0.472, 0)
    const sole = new Mesh(soleGeo, toy(LOOK.sole))
    sole.scale.set(1, 1, 1.45)
    sole.position.set(x, 0.015, 0.035)
    fig.add(cuff, hem, sole)
  }

  // Gloves ride the pods ([left, right]); the scene sets each pod's full position every frame (guard bob,
  // wind-ups, hooks, overhead slams). Stubby arms stretch from fixed shoulders to the moving gloves.
  const gloveShell = glossy({ color: LOOK.gloves, roughness: 0.2, metalness: 0 })
  const gloveMats: GloveMats = {
    shell: gloveShell,
    cuff: toy(0xffffff, 0.45),
    stripe: toy(LOOK.shorts, 0.35),
    lace: toy(0xffffff, 0.5),
  }
  const armGeo = armGeometry()
  const shoulderGeo = new SphereGeometry(0.08, 16, 10)
  const pods = [-1, 1].map((side) => {
    const pod = new Group()
    pod.position.set(side * DRONE.podX, DRONE.podY, DRONE.podZ)
    const glove = gloveModel(0.12, side, gloveMats)
    glove.rotation.y = Math.PI // knuckles toward the player
    glove.rotation.x = 0.25
    glove.position.set(-side * 0.22, 0.22, 0.33)
    pod.add(glove)
    body.add(pod)

    const shoulderAt = new Vector3(side * SHOULDER.x, SHOULDER.y - DRONE.y, 0)
    const shoulder = new Mesh(shoulderGeo, limbSkin)
    shoulder.position.copy(shoulderAt)
    const wristOff = new Vector3(-side * 0.22, 0.2, 0.2)
    const arm = new Mesh(armGeo, limbSkin)
    arm.scale.x = arm.scale.z = 1.25
    arm.frustumCulled = false
    const wrist = new Vector3()
    const aim = (): void => {
      stretchArm(arm, shoulderAt, wrist.copy(pod.position).add(wristOff))
      arm.scale.x = arm.scale.z = 1.25
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
  buckleHolder.position.set(0, beltY - DRONE.y, 0.232 * 0.95 + 0.012 - DRONE.orbZ)
  const orb = new Mesh(new SphereGeometry(0.06, 20, 12), chestCore)
  orb.scale.set(1.3, 0.9, 0.4)
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
  const headPop = new Mesh(new SphereGeometry(0.255, 24, 16), headHalo)
  headPop.position.set(0, DRONE.headY + 0.01, 0.02)
  headPop.scale.set(1.05, 1.08, 1)
  const chestPop = new Mesh(new SphereGeometry(0.29, 24, 16), chestHalo)
  chestPop.position.set(0, -0.05, 0)
  chestPop.scale.set(1, 1.3, 0.95)
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
