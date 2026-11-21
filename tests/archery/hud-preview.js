// Dev-only driver for hud-preview.html. Fake data only.
import { createArcheryHud } from '/src/sports/archery/hud.ts'

const q = new URLSearchParams(location.search)
const view = q.get('view') ?? 'start'
const embedded = q.has('embedded')

const root = document.createElement('div')
root.className = embedded ? 'ar-root ar-page ar-embedded' : 'ar-root ar-page'
const stage = document.createElement('div')
stage.className = 'ar-stage'
const target = document.createElement('div')
target.className = 'fake-target'
const video = document.createElement('video')
video.className = 'ar-webcam'
video.muted = true
video.playsInline = true
const ui = document.createElement('div')
ui.className = 'ar-ui'
stage.append(target, video)
root.append(stage, ui)
document.body.append(root)

// Fake webcam: a canvas stream with a simple figure, so the mirror placement is visible.
function fakeCamera() {
  const c = document.createElement('canvas')
  c.width = 640
  c.height = 480
  const g = c.getContext('2d')
  const draw = () => {
    const grd = g.createLinearGradient(0, 0, 0, 480)
    grd.addColorStop(0, '#3a3f55')
    grd.addColorStop(1, '#1d2030')
    g.fillStyle = grd
    g.fillRect(0, 0, 640, 480)
    g.fillStyle = '#c9a98c'
    g.beginPath()
    g.ellipse(320, 150, 40, 50, 0, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = '#2f6f9f'
    g.fillRect(230, 210, 180, 270)
    g.fillRect(200, 220, 34, 200)
    g.fillRect(406, 220, 34, 200)
  }
  draw()
  video.srcObject = c.captureStream(10)
  void video.play()
  setInterval(draw, 200)
  video.classList.add('ar-live')
}

const hud = createArcheryHud(ui, { cornerHome: !embedded, onHome: () => console.log('home'), onButton: () => {} })
const noop = () => {}

function shot(arrow, score, stability, extra = {}) {
  return {
    arrow, score, bullseye: score === 10, hit: score > 0 ? { x: 0.05 * arrow, y: -0.03 } : null,
    radius: (10 - score) * 0.1, tension: 0.9, launchSpeed: 47, flightMs: 560, wind: arrow >= 3 ? 2.4 : 0,
    windErrX: 0, rmsSway: 0.01, rmsSwayMm: 4, stability, holdMs: 900, peakVelocity: 4, bowHand: 'left',
    trigger: 'snap', source: 'camera', ...extra,
  }
}

const shots = [shot(0, 10, 91), shot(1, 8, 74), shot(2, 0, 40), shot(3, 9, 82), shot(4, 6, 66)]
const winShots = [shot(0, 10, 91), shot(1, 8, 74), shot(2, 9, 80), shot(3, 9, 82), shot(4, 10, 88)]
const lowShots = [shot(0, 6, 51), shot(1, 3, 38), shot(2, 0, 20), shot(3, 7, 60), shot(4, 0, 30)]

if (q.has('mouse')) hud.setInputMode('mouse')
if (q.has('debug')) {
  hud.toggleDebug()
  hud.setDebug({ fps: 60, tension: 0.8213, phase: 'aiming', sway_mm: 4.2, bowHand: 'left' })
}

switch (view) {
  case 'start':
    hud.showStart(noop, noop)
    break
  case 'loading':
    hud.showLoading('Starting camera…')
    break
  case 'error':
    hud.showError('Camera blocked. Allow camera access in the address bar, then retry.', noop, noop)
    break
  case 'calibration':
    fakeCamera()
    hud.showCalibration(Number(q.get('p') ?? 0.62), q.get('status') ?? 'holding')
    break
  case 'play':
  case 'play-wind':
  case 'shot':
  case 'shot-miss': {
    if (!q.has('mouse')) fakeCamera()
    const wind = view === 'play-wind'
    const done = wind ? shots.slice(0, 3) : shots.slice(0, 2)
    hud.showPlay()
    hud.setScoreboard(done, 5)
    const armed = view === 'play' || view === 'play-wind'
    hud.setView({
      phase: view.startsWith('shot') ? 'impact' : 'aiming',
      arrow: done.length,
      tension: armed ? (wind ? 0.74 : 0.86) : 0.2,
      drawPhase: armed ? 'armed' : 'idle',
      steadiness: armed ? (wind ? 0.42 : 0.78) : null,
      hint: armed ? (wind ? 'Hold steady' : 'Release!') : null,
      wind: wind ? -2.4 : 0,
    })
    if (view === 'shot') hud.showShot(shot(2, 10, 88))
    if (view === 'shot-miss') hud.showShot(shot(2, 0, 35))
    if (wind) hud.callout('WIND! AIM UPWIND', 'info')
    break
  }
  case 'end':
  case 'end-low': {
    const s = view === 'end' ? winShots : lowShots
    const total = s.reduce((a, b) => a + b.score, 0)
    hud.showEnd(
      {
        shots: s, total, bullseyes: s.filter((x) => x.bullseye).length,
        avgStability: s.reduce((a, b) => a + b.stability, 0) / s.length,
        bestStability: Math.max(...s.map((x) => x.stability)),
        grouping: view === 'end' ? 0.184 : null, score: total * 100 + 640,
      },
      noop,
    )
    break
  }
}

window.__hud = hud
