// Robot parts for character customisation: the four head styles (shared by the player robot,
// the 1v1 opponent and the preview) and the full-body bobblehead robot for the customise screen.
import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DodecahedronGeometry,
  EdgesGeometry,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { Material } from 'three'
import { gloveColors, schemeOf } from './look.ts'
import type { HeadId, RobotLook } from './look.ts'

export interface HeadMaterials {
  /** Armour. */
  shell: Material
  /** Neon edge lines. */
  edge: LineBasicMaterial
  /** Visor glass, eyes and antenna tip. */
  visor: Material
}

const withEdges = (mesh: Mesh, edge: LineBasicMaterial): Mesh => {
  mesh.add(new LineSegments(new EdgesGeometry(mesh.geometry, 20), edge))
  return mesh
}

/** A visor arc of `arc` radians wrapped around the front (+z) at radius r. */
function visorArc(r: number, tube: number, arc: number, mat: Material): Mesh {
  const geo = new TorusGeometry(r, tube, 4, 20, arc)
  geo.rotateZ(Math.PI / 2 - arc / 2) // centre the arc on +y
  geo.rotateX(Math.PI / 2) // then +y becomes +z
  return new Mesh(geo, mat)
}

/**
 * Head of the given style with radius r, centred on the origin. The face points +z when facing is
 * 1 and -z when it is -1 (the player's own robot faces away from the camera, toward -z).
 */
export function buildHead(style: HeadId, mats: HeadMaterials, r: number, facing: 1 | -1 = 1): Group {
  const head = new Group()
  const { shell, edge, visor } = mats
  switch (style) {
    case 'visor': {
      const helmet = withEdges(new Mesh(new DodecahedronGeometry(r, 0), shell), edge)
      helmet.scale.set(1.1, 1.02, 1.05)
      const band = new Mesh(new BoxGeometry(1.4 * r, 0.28 * r, 0.22 * r), visor)
      band.position.set(0, 0.1 * r, 0.9 * r)
      const crest = withEdges(new Mesh(new BoxGeometry(0.22 * r, 0.5 * r, 1.3 * r), shell), edge)
      crest.position.set(0, 0.98 * r, -0.05 * r)
      head.add(helmet, band, crest)
      break
    }
    case 'dome': {
      const dome = new Mesh(new SphereGeometry(r, 20, 14), shell)
      dome.scale.set(1.08, 0.98, 1)
      const glass = visorArc(1.02 * r, 0.16 * r, 2.4, visor)
      glass.position.y = 0.05 * r
      // Equator band as edge lines, so it shares the animated neon edge colour.
      const ring = new LineSegments(new EdgesGeometry(new CylinderGeometry(1.07 * r, 1.07 * r, 0.06 * r, 28, 1, true)), edge)
      ring.position.y = -0.3 * r
      head.add(dome, glass, ring)
      break
    }
    case 'antenna': {
      const skull = withEdges(new Mesh(new IcosahedronGeometry(r, 0), shell), edge)
      skull.scale.set(1.1, 1, 1)
      for (const side of [-1, 1]) {
        const eye = new Mesh(new BoxGeometry(0.34 * r, 0.22 * r, 0.12 * r), visor)
        eye.position.set(side * 0.36 * r, 0.12 * r, 0.86 * r)
        head.add(eye)
      }
      const mast = new Mesh(new CylinderGeometry(0.05 * r, 0.07 * r, 0.7 * r, 6), shell)
      mast.position.y = 1.25 * r
      const tip = new Mesh(new IcosahedronGeometry(0.16 * r, 1), visor)
      tip.position.y = 1.65 * r
      head.add(skull, mast, tip)
      break
    }
    case 'block': {
      const box = withEdges(new Mesh(new BoxGeometry(1.75 * r, 1.5 * r, 1.6 * r), shell), edge)
      const slot = new Mesh(new BoxGeometry(1.35 * r, 0.3 * r, 0.06 * r), visor)
      slot.position.set(0, 0.12 * r, 0.81 * r)
      head.add(box, slot)
      for (const side of [-1, 1]) {
        const bolt = withEdges(new Mesh(new CylinderGeometry(0.22 * r, 0.22 * r, 0.16 * r, 6), shell), edge)
        bolt.rotation.z = Math.PI / 2
        bolt.position.set(side * 0.95 * r, 0, 0)
        head.add(bolt)
      }
      break
    }
  }
  if (facing === -1) head.rotation.y = Math.PI
  return head
}

/** Neon materials for a look. glow scales colours above 1 for scenes with bloom. */
export function lookMaterials(look: RobotLook, glow = 1): HeadMaterials & { shell: MeshStandardMaterial } {
  const s = schemeOf(look)
  return {
    shell: new MeshStandardMaterial({
      color: s.armour,
      roughness: 0.42,
      metalness: 0.35,
      flatShading: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
    edge: new LineBasicMaterial({ color: new Color(s.accent).multiplyScalar(glow), transparent: true, opacity: 0.8 }),
    visor: new MeshBasicMaterial({ color: new Color(s.visor).multiplyScalar(glow) }),
  }
}

export interface PreviewRobot {
  group: Group
  dispose(): void
}

/** Full-body bobblehead robot for the customise preview: big head, short body, gloves up in guard. Faces +z. */
export function buildPreviewRobot(look: RobotLook): PreviewRobot {
  const group = new Group()
  const mats = lookMaterials(look)
  const s = schemeOf(look)
  const trim = new MeshBasicMaterial({ color: s.accent })

  const head = buildHead(look.head, mats, 0.3)
  head.position.y = 1.38
  const neck = new Mesh(new CylinderGeometry(0.06, 0.08, 0.14, 8), mats.shell)
  neck.position.y = 1.04
  const torso = withEdges(new Mesh(new CylinderGeometry(0.27, 0.17, 0.46, 6), mats.shell), mats.edge)
  torso.scale.z = 0.65
  torso.position.y = 0.76
  const chest = new Mesh(new BoxGeometry(0.16, 0.035, 0.02), mats.visor)
  chest.position.set(0, 0.84, 0.19)
  const belt = new Mesh(new TorusGeometry(0.17, 0.018, 4, 24), trim)
  belt.rotation.x = Math.PI / 2
  belt.scale.y = 0.65
  belt.position.y = 0.53
  group.add(head, neck, torso, chest, belt)

  const [leftColor, rightColor] = gloveColors(look)
  const armGeo = new CapsuleGeometry(0.045, 0.2, 3, 8)
  for (const side of [-1, 1] as const) {
    const shoulder = withEdges(new Mesh(new IcosahedronGeometry(0.1, 0), mats.shell), mats.edge)
    const from = new Vector3(side * 0.32, 0.92, 0)
    shoulder.position.copy(from)
    // Guard pose: fists up by the chin, a little forward.
    const fistAt = new Vector3(side * 0.2, 1.0, 0.34)
    const arm = new Mesh(armGeo, mats.shell)
    arm.position.copy(from).lerp(fistAt, 0.5)
    arm.lookAt(fistAt)
    arm.rotateX(Math.PI / 2)
    const color = side === -1 ? leftColor : rightColor
    const gloveMat = new MeshStandardMaterial({
      color: new Color(color).multiplyScalar(0.55),
      emissive: color,
      emissiveIntensity: 0.45,
      roughness: 0.35,
      flatShading: true,
    })
    const fist = new Mesh(new IcosahedronGeometry(0.1, 1), gloveMat)
    fist.scale.set(1, 0.9, 1.1)
    fist.position.copy(fistAt)
    const cuff = new Mesh(new TorusGeometry(0.07, 0.014, 6, 18), new MeshBasicMaterial({ color }))
    cuff.position.copy(fistAt).lerp(from, 0.22)
    cuff.lookAt(from)
    const leg = new Mesh(new CapsuleGeometry(0.06, 0.2, 3, 8), mats.shell)
    leg.position.set(side * 0.12, 0.33, 0)
    const foot = withEdges(new Mesh(new BoxGeometry(0.14, 0.07, 0.22), mats.shell), mats.edge)
    foot.position.set(side * 0.13, 0.12, 0.03)
    group.add(shoulder, arm, fist, cuff, leg, foot)
  }

  return {
    group,
    dispose() {
      group.traverse((o) => {
        const m = o as Mesh
        m.geometry?.dispose()
        const mat = m.material as Material | Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
    },
  }
}
