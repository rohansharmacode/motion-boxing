// Round-start 3-2-1-FIGHT overlay. Plain DOM with a transform and opacity pop, so it costs nothing on the GPU.
const STYLE_ID = 'bx-countdown-style'
const CSS = `
.bx-countdown{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:40}
.bx-countdown__n{font-family:'Bebas Neue','Jersey 10',Impact,sans-serif;font-size:min(34vh,30vw);line-height:1;color:#fff;
  letter-spacing:.04em;text-shadow:0 0 .06em #ff2bd6,0 .04em 0 #1a0f2e,0 0 .25em rgba(0,240,255,.55);opacity:0;will-change:transform,opacity}
.bx-countdown__n--go{color:#ffe14d;font-size:min(30vh,24vw);text-shadow:0 0 .06em #ff6a00,0 .04em 0 #2a1200,0 0 .3em rgba(255,200,0,.6)}
.bx-countdown__n--pop{animation:bx-cd-pop .78s cubic-bezier(.2,1.4,.4,1) both}
.bx-countdown__n--go.bx-countdown__n--pop{animation:bx-cd-go .9s cubic-bezier(.2,1.5,.4,1) both}
@keyframes bx-cd-pop{0%{transform:scale(2.4);opacity:0}18%{transform:scale(.92);opacity:1}30%{transform:scale(1)}75%{opacity:1}100%{transform:scale(.8);opacity:0}}
@keyframes bx-cd-go{0%{transform:scale(3) rotate(-6deg);opacity:0}15%{transform:scale(.9) rotate(2deg);opacity:1}28%{transform:scale(1.05) rotate(0)}70%{opacity:1;transform:scale(1)}100%{transform:scale(1.6);opacity:0}}
`

export interface CountdownOverlay {
  /** 3, 2, 1, 0 = FIGHT, null = hide. */
  show(n: number | null): void
  dispose(): void
}

export function createCountdownOverlay(parent: HTMLElement = document.body): CountdownOverlay {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }
  const root = document.createElement('div')
  root.className = 'bx-countdown'
  root.setAttribute('aria-live', 'assertive')
  const label = document.createElement('div')
  label.className = 'bx-countdown__n'
  root.appendChild(label)
  parent.appendChild(root)
  let hideTimer = 0

  return {
    show(n) {
      window.clearTimeout(hideTimer)
      if (n === null) {
        label.className = 'bx-countdown__n'
        label.textContent = ''
        return
      }
      label.textContent = n > 0 ? String(n) : 'FIGHT!'
      label.className = `bx-countdown__n${n > 0 ? '' : ' bx-countdown__n--go'}`
      void label.offsetWidth // restart the animation
      label.classList.add('bx-countdown__n--pop')
      document.body.dataset.countdown = n > 0 ? String(n) : 'fight'
      if (n === 0) {
        hideTimer = window.setTimeout(() => {
          label.className = 'bx-countdown__n'
          delete document.body.dataset.countdown
        }, 950)
      }
    },
    dispose() {
      window.clearTimeout(hideTimer)
      delete document.body.dataset.countdown
      root.remove()
    },
  }
}
