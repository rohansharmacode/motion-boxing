import { isVisible } from './control'
import type { BodyFrame, PipelineStatus } from './types'
const edges = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10],[15,17],[15,19],[15,21],[17,19],[16,18],[16,20],[16,22],[18,20],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32]]
export class DebugOverlay {
  private canvas = document.createElement('canvas')
  private key = (event: KeyboardEvent) => {
    const target = event.target
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey ||
      (target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName)))) return
    if (event.key.toLowerCase() === 'f') this.canvas.hidden = !this.canvas.hidden
  }
  constructor() {
    this.canvas.width = 640
    this.canvas.height = 480
    this.canvas.hidden = true
    this.canvas.style.cssText = 'position:fixed;right:12px;bottom:12px;width:min(640px,90vw);z-index:9999;pointer-events:none;background:#09111ddd'
    document.body.append(this.canvas)
    window.addEventListener('keydown',this.key)
  }
  draw(frame: BodyFrame, status: PipelineStatus) {
    if (this.canvas.hidden) return
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0,0,640,480)
    ctx.strokeStyle = '#55ffcc'
    ctx.lineWidth = 2
    for (const [a,b] of edges) {
      const p = frame.image[a], q = frame.image[b]
      if (!p || !q || !isVisible(p) || !isVisible(q)) continue
      ctx.beginPath()
      ctx.moveTo((1-p.x)*640,p.y*480)
      ctx.lineTo((1-q.x)*640,q.y*480)
      ctx.stroke()
    }
    ctx.fillStyle = 'white'
    ctx.font = '16px monospace'
    ctx.fillText(status.fps.toFixed(1)+' FPS  '+status.inferenceMs.toFixed(1)+' ms  Tier '+status.tier+' '+status.delegate,12,24)
    ctx.fillText(frame.person,12,48)
  }
  dispose() {
    window.removeEventListener('keydown',this.key)
    this.canvas.remove()
  }
}
