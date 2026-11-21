// Mouse / touch fallback for Reflex Keeper (research doc section 4: D hotkey, mouse X-Y = keeper gloves).

export interface KeeperInput {
  readonly mouseOn: boolean
  setMouse(on: boolean): void
  /** Flips mouse mode and returns the new state. */
  toggle(): boolean
  /** Latest goal-plane target, null when mouse mode is off or the pointer never moved. */
  target(): { x: number; y: number } | null
  dispose(): void
}

export interface KeeperInputOptions {
  canvas: HTMLCanvasElement
  screenToGoal: (ndcX: number, ndcY: number) => { x: number; y: number }
  onToggle?: (mouseOn: boolean) => void
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function createKeeperInput(opts: KeeperInputOptions): KeeperInput {
  const { canvas, screenToGoal, onToggle } = opts
  let mouseOn = false
  // Last pointer position in NDC; converted lazily so camera moves (resize, shake) stay in sync.
  let ndc: { x: number; y: number } | null = null

  function track(clientX: number, clientY: number): void {
    const r = canvas.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const x = ((clientX - r.left) / r.width) * 2 - 1
    const y = 1 - ((clientY - r.top) / r.height) * 2
    ndc = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) }
  }

  const onPointerMove = (e: PointerEvent): void => {
    track(e.clientX, e.clientY)
  }
  const onPointerDown = (e: PointerEvent): void => {
    track(e.clientX, e.clientY)
  }
  const onTouch = (e: TouchEvent): void => {
    const t = e.touches[0]
    if (!t) return
    track(t.clientX, t.clientY)
    // Keep the page from scrolling or zooming while dragging the gloves.
    if (mouseOn && e.cancelable) e.preventDefault()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'KeyD' || e.repeat) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return
    api.toggle()
  }

  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('touchstart', onTouch, { passive: false })
  canvas.addEventListener('touchmove', onTouch, { passive: false })
  window.addEventListener('keydown', onKey)

  const api: KeeperInput = {
    get mouseOn() {
      return mouseOn
    },
    setMouse(on) {
      if (on === mouseOn) return
      mouseOn = on
      onToggle?.(mouseOn)
    },
    toggle() {
      api.setMouse(!mouseOn)
      return mouseOn
    },
    target() {
      if (!mouseOn || !ndc) return null
      return screenToGoal(ndc.x, ndc.y)
    },
    dispose() {
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('touchstart', onTouch)
      canvas.removeEventListener('touchmove', onTouch)
      window.removeEventListener('keydown', onKey)
    },
  }
  return api
}
