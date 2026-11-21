// Dev-only preview of the dashboard with a stand-in boxing game. Not part of the build.
import '../style.css'
import { mountShell } from './index.ts'
import type { GameLauncher } from './index.ts'

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

const shell = mountShell({ launchers: { boxing: demoBoxing } })

if (new URLSearchParams(location.search).has('dwell')) {
  window.addEventListener('pointermove', (e) => shell.setCursor({ x: e.clientX / innerWidth, y: e.clientY / innerHeight }))
}
