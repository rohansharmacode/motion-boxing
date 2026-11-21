// Dev-only preview of the dashboard with a stand-in boxing game. Not part of the build.
import '../style.css'
import { mountShell } from './index.ts'
import type { GameLauncher, TileId } from './index.ts'

const demoBoxing: GameLauncher = (ctx) => {
  const panel = document.createElement('div')
  panel.style.cssText =
    'position:absolute;inset:0;display:grid;place-content:center;gap:16px;text-align:center;background:#120d14;font:600 18px Outfit,sans-serif'
  const title = document.createElement('p')
  title.textContent = 'Boxing runs here. Esc or Home to go back.'
  const finish = document.createElement('button')
  finish.type = 'button'
  finish.textContent = 'Fake a finished round'
  finish.style.cssText = 'padding:12px 20px;border-radius:999px;font:inherit'
  finish.addEventListener('click', () => {
    window.dispatchEvent(
      new CustomEvent('motion-event', {
        detail: {
          sport: 'BOXING',
          event_type: 'TICK',
          event_ts: new Date().toISOString(),
          metrics: { summary: true, outcome: 'ko-win', counts: { total: 40 + Math.round(Math.random() * 30) }, accuracyPct: 72, bestSpeed: 8.4 },
        },
      }),
    )
    ctx.exit()
  })
  panel.append(title, finish)
  ctx.host.append(panel)
  return { dispose: () => panel.remove() }
}

// ?launch=boxing,goalkeeper picks which tiles get the stand-in game (default: boxing only).
const ids = (new URLSearchParams(location.search).get('launch') ?? 'boxing').split(',')
const launchers: Partial<Record<TileId, GameLauncher>> = {}
for (const id of ids) if (id === 'boxing' || id === 'goalkeeper' || id === 'archery' || id === 'leaderboard') launchers[id] = demoBoxing
const shell = mountShell({ launchers })

if (new URLSearchParams(location.search).has('dwell')) {
  window.addEventListener('pointermove', (e) => shell.setCursor({ x: e.clientX / innerWidth, y: e.clientY / innerHeight }))
}
