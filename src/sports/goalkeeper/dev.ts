// TEMPORARY standalone dev boot for Reflex Keeper (goalkeeper.html). Runs the same startGoalkeeper the
// shell launches, with a stand-in GameContext. Remove with goalkeeper.html once the shell is in main.ts.
//
// Query flags: ?auto=mouse skips the start screen into a mouse shootout, ?auto=camera starts the camera,
// ?debug opens the debug panel. Keys: D mouse mode, R restart, M mute, ` debug. Home reloads the page.
import { startGoalkeeper } from './index.ts'
import type { GameSession } from '../../shell/types.ts'
import type { KeeperMotionEvent } from './types.ts'

const host = document.querySelector<HTMLElement>('#app')
if (!host) throw new Error('goalkeeper dev: missing #app')

const params = new URLSearchParams(location.search)
const auto = params.get('auto')
const controller = new AbortController()
let session: GameSession | null = null

window.addEventListener('motion-event', (e) => {
  const d = (e as CustomEvent<KeeperMotionEvent>).detail
  console.debug(`[motion-event] ${d?.event_type ?? '?'}${d?.metrics?.summary ? ' (summary)' : ''}`, d)
})

void startGoalkeeper(
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
