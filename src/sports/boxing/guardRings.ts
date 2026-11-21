// Guard stamina rings that float by each fighter's head: a thin dim track plus a bright arc that empties
// clockwise. The arc is one RingGeometry drawn with a partial drawRange, so nothing is rebuilt per frame.
// Neon cyan when full, amber when low, a red flashing ring while the guard is broken.
import { CircleGeometry, Color, Group, Mesh, MeshBasicMaterial, RingGeometry } from 'three'
import type { GuardMeterView } from './types.ts'

const SEGMENTS = 48
const FULL = new Color(0x3cf2ff)
const LOW = new Color(0xffb347)
const BROKEN = new Color(0xff3355)

export interface GuardRing {
  readonly group: Group
  /** Advance by dt seconds toward the latest meter. */
  update(view: GuardMeterView, dt: number): void
  dispose(): void
}

/** radius in metres. The ring faces +z (toward the camera); place and parent the group yourself. */
export function createGuardRing(radius: number, width = radius * 0.34): GuardRing {
  const group = new Group()
  group.name = 'guard-ring'
  const trackMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthTest: false, depthWrite: false, fog: false })
  const arcMat = new MeshBasicMaterial({ color: FULL.clone(), transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, fog: false })
  const trackGeo = new RingGeometry(radius - width / 2, radius + width / 2, SEGMENTS, 1)
  // Start at 12 o'clock and run counter-clockwise, so the arc drains clockwise from the top.
  const arcGeo = new RingGeometry(radius - width / 2, radius + width / 2, SEGMENTS, 1, Math.PI / 2, Math.PI * 2)
  // Dark disc behind the ring so it reads on a bright sky as well as the neon arena.
  const backMat = new MeshBasicMaterial({ color: 0x0b0f1e, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false, fog: false })
  const backGeo = new CircleGeometry(radius + width * 0.9, 32)
  const back = new Mesh(backGeo, backMat)
  back.renderOrder = 19
  const track = new Mesh(trackGeo, trackMat)
  const arc = new Mesh(arcGeo, arcMat)
  track.renderOrder = 20
  arc.renderOrder = 21
  group.add(back, track, arc)

  let shown = 1
  let flash = 0
  let wasBroken = false
  let pop = 0

  return {
    group,
    update(view, dt) {
      const target = Math.max(0, Math.min(1, view.fraction))
      // Drop fast on a block, refill smoothly.
      const k = 1 - Math.exp(-dt * (target < shown ? 22 : 8))
      shown += (target - shown) * k
      if (view.broken && !wasBroken) pop = 1
      wasBroken = view.broken
      pop = Math.max(0, pop - dt / 0.35)
      flash += dt
      const segs = view.broken ? SEGMENTS : Math.round(shown * SEGMENTS)
      arcGeo.setDrawRange(0, segs * 6)
      arc.visible = segs > 0
      if (view.broken) {
        arcMat.color.copy(BROKEN)
        arcMat.opacity = 0.35 + 0.6 * (Math.sin(flash * 22) > 0 ? 1 : 0.2)
      } else {
        arcMat.color.copy(LOW).lerp(FULL, Math.min(1, shown / 0.6))
        arcMat.opacity = shown < 0.3 ? 0.6 + 0.35 * Math.abs(Math.sin(flash * 9)) : 0.95
      }
      trackMat.opacity = view.broken ? 0.3 : 0.2
      group.scale.setScalar(1 + 0.45 * pop)
    },
    dispose() {
      backGeo.dispose()
      backMat.dispose()
      trackGeo.dispose()
      arcGeo.dispose()
      trackMat.dispose()
      arcMat.dispose()
    },
  }
}
