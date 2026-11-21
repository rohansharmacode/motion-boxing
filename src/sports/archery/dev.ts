// TEMPORARY standalone dev boot for Aero Bow (archery.html). Runs the same startArchery the
// shell launches, with a stand-in GameContext. Remove with archery.html once the shell is in main.ts.
//
// Query flags: ?auto=mouse skips the start screen into a mouse round, ?auto=camera starts the camera,
// ?debug opens the debug panel. Keys: D mouse mode, Space or hold to draw, M mute, ` debug. Home reloads the page.
import { startArchery } from './index.ts'
import type { GameSession } from '../../shell/types.ts'
import type { ArcheryMotionEvent } from './types.ts'

const host = document.querySelector<HTMLElement>('#app')
if (!host) throw new Error('archery dev: missing #app')

const params = new URLSearchParams(location.search)
const auto = params.get('auto')
const controller = new AbortController()
let session: GameSession | null = null

window.addEventListener('motion-event', (e) => {
  const d = (e as CustomEvent<ArcheryMotionEvent>).detail
  console.debug(`[motion-event] ${d?.event_type ?? '?'}${d?.metrics?.summary ? ' (summary)' : ''}`, d)
})

void startArchery(
  {
    host,
    signal: controller.signal,
    exit: () => {
      session?.dispose()
      location.reload()
    },
  },
  { auto: auto === 'mouse' || auto === 'camera' ? auto : undefined, debug: params.has('debug'), embedded: false },
).then((s) => {
  session = s
})
