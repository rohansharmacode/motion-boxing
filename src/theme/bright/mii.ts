// Original Mii-style dressing for the boxing opponent (opt in with ?style=mii, sent by the Wii menu):
// an oversized round head, flat white-and-black oval eyes, thick rounded brows, a tiny nose and a broad
// side-swept hair helmet. Built on the shared toy figure so the scene animates it unchanged.
import { CapsuleGeometry, CircleGeometry, Group, Mesh, MeshBasicMaterial, SphereGeometry, TorusGeometry } from 'three'
import type { Material } from 'three'
import { BODY, INK, onHead, toy } from './avatar.ts'
import type { FigureParts } from './avatar.ts'

/** Head grows this much: Miis are about one third head. */
export const MII_HEAD_SCALE = 1.32

export const isMiiStyle = (): boolean => {
  try { return new URLSearchParams(location.search).get('style') === 'mii' } catch { return false }
}

function miiFace(skin: Material): Group {
  const face = new Group()
  face.name = 'mii-face'
  const ink = toy(INK, 0.25)
  const white = new MeshBasicMaterial({ color: 0xffffff })
  const sclera = new CircleGeometry(0.036, 24)
  const pupil = new CircleGeometry(0.022, 20)
  const glint = new CircleGeometry(0.007, 10)
  const brow = new CapsuleGeometry(0.013, 0.055, 4, 8).rotateZ(Math.PI / 2)
  for (const side of [-1, 1]) {
    const eye = onHead(new Mesh(sclera, white), 0.05, side * 0.3, 0.001)
    eye.scale.set(0.82, 1.18, 1)
    const p = new Mesh(pupil, ink)
    p.position.set(-side * 0.004, -0.002, 0.001)
    p.scale.set(0.95, 1.3, 1)
    const g = new Mesh(glint, white)
    g.position.set(0.006, 0.012, 0.002)
    p.add(g)
    eye.add(p)
    const b = onHead(new Mesh(brow, ink), 0.3, side * 0.3, 0.003)
    b.rotateZ(side * 0.32) // determined, slanting down to the middle
    face.add(eye, b)
    const cheek = onHead(new Mesh(new CircleGeometry(0.03, 16), new MeshBasicMaterial({ color: 0xff8f8f, transparent: true, opacity: 0.35 })), -0.14, side * 0.55, 0.003)
    cheek.scale.set(1, 0.6, 1)
    face.add(cheek)
  }
  const nose = onHead(new Mesh(new SphereGeometry(0.022, 14, 10), skin), -0.1, 0, -0.008)
  nose.scale.set(1.1, 0.8, 0.7)
  const mouth = onHead(new Mesh(new TorusGeometry(0.038, 0.008, 6, 18, Math.PI).rotateZ(Math.PI), ink), -0.32, 0, 0.002)
  mouth.scale.set(1, 0.7, 1)
  face.add(nose, mouth)
  return face
}

function miiHair(color: number): Group {
  const hair = new Group()
  hair.name = 'hair'
  const mat = toy(color, 0.45)
  const helmet = new Mesh(new SphereGeometry(BODY.headR * 1.08, 36, 18, 0, Math.PI * 2, 0, 1.35), mat)
  helmet.rotation.x = -0.5
  const fringe = new Mesh(new SphereGeometry(0.12, 20, 12), mat)
  fringe.scale.set(1.5, 0.5, 0.7)
  fringe.position.set(0.04, 0.15, 0.11)
  fringe.rotation.z = -0.3
  hair.add(helmet, fringe)
  for (const side of [-1, 1]) {
    const burn = new Mesh(new SphereGeometry(0.05, 12, 10), mat)
    burn.scale.set(0.5, 1.2, 0.8)
    burn.position.set(side * 0.19, 0.0, -0.01)
    hair.add(burn)
  }
  return hair
}

/** Turns a toy figure into a Mii: bigger head, Mii face, helmet hair. */
export function dressAsMii(figure: FigureParts, headSkin: Material, hairColor = 0x4a3020): void {
  figure.face.visible = false
  for (const c of [...figure.head.children]) if (c.name === 'hair') figure.head.remove(c)
  figure.head.add(miiFace(headSkin), miiHair(hairColor))
  figure.head.scale.multiplyScalar(MII_HEAD_SCALE)
  figure.head.position.y += 0.05 // sit the bigger head on the shoulders
}
