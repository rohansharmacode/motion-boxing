// Bright look for the boxing scene: island arena, bean opponent, cartoon gloves, crowd and daylight.
// The boxing scene calls brightBoxingLook() once; it returns null under the neon theme.
import type { Group, Scene, Texture, WebGLRenderer } from 'three'
import { Vector3 } from 'three'
import type { Hand } from '../../pose/types.ts'
import type { DroneParts, GloveParts } from '../../sports/boxing/sceneParts.ts'
import { isBright } from '../index.ts'
import { CROWD_SEATS, buildBrightArena } from './arena.ts'
import { buildCrowd } from './avatar.ts'
import { buildBrightGlove, buildBrightOpponent } from './boxer.ts'
import { applyBrightEnvironment } from './environment.ts'

export interface BoxingLook {
  /** Sky, fog, lights, shadows and tone mapping. Call once instead of the neon lights. */
  setup(scene: Scene, renderer: WebGLRenderer): void
  buildArena(): Group
  buildDrone(glowMap: Texture): DroneParts
  buildGlove(hand: Hand): GloveParts
  /** Per frame, real seconds. */
  update(dtSeconds: number): void
  /** The crowd jumps and cheers. */
  cheer(): void
  /** Scene moments the crowd reacts to. */
  onDroneHit(counter: boolean): void
  onKO(): void
  dispose(): void
}

export function brightBoxingLook(): BoxingLook | null {
  if (!isBright()) return null
  let env: ReturnType<typeof applyBrightEnvironment> | null = null
  let crowd: ReturnType<typeof buildCrowd> | null = null
  return {
    setup(scene, renderer) {
      env = applyBrightEnvironment(scene, renderer, { shadowFocus: new Vector3(0, 0, -2.0), shadowSize: 16 })
    },
    buildArena() {
      const arena = buildBrightArena()
      crowd = buildCrowd(CROWD_SEATS, 7)
      arena.add(crowd.root)
      return arena
    },
    buildDrone: (glowMap) => buildBrightOpponent(glowMap),
    buildGlove: (hand) => buildBrightGlove(hand),
    update(dt) {
      env?.update(dt)
      crowd?.update(dt)
    },
    cheer() {
      crowd?.cheer()
    },
    onDroneHit(counter) {
      if (counter) crowd?.cheer()
    },
    onKO() {
      crowd?.cheer()
    },
    dispose() {
      env?.dispose()
      env = null
      crowd = null
    },
  }
}
