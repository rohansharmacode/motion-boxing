// Mouse / touch / keyboard fallback for Aero Bow (D toggles mouse mode, hold button / touch / Space to draw).

export interface ArcheryInput {
  readonly mouseOn: boolean
  setMouse(on: boolean): void
  /** Flips mouse mode and returns the new state. */
  toggle(): boolean
  /** Latest pointer in NDC (-1..1, y up) over the canvas. null when mouse mode is off or the pointer never moved. */
  pointer(): { x: number; y: number } | null
  /** True while mouse mode is on and the primary button, a touch, or Space is held. */
  readonly drawing: boolean
  dispose(): void
}

export interface ArcheryInputOptions {
  canvas: HTMLCanvasElement
  onToggle?: (mouseOn: boolean) => void
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Space on a focused control would click it, so leave those alone. */
function isControlTarget(t: EventTarget | null): boolean {
  if (isTypingTarget(t)) return true
  return t instanceof HTMLElement && t.tagName === 'BUTTON'
}

export function createArcheryInput(opts: ArcheryInputOptions): ArcheryInput {
  const { canvas, onToggle } = opts
  let mouseOn = false
  let ndc: { x: number; y: number } | null = null
  let pointerHeld = false
  let touchHeld = false
  let spaceHeld = false

  function track(clientX: number, clientY: number): void {
    const r = canvas.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const x = ((clientX - r.left) / r.width) * 2 - 1
    const y = 1 - ((clientY - r.top) / r.height) * 2
    ndc = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) }
  }

  function releaseAll(): void {
    pointerHeld = false
    touchHeld = false
    spaceHeld = false
  }

  const onPointerMove = (e: PointerEvent): void => {
    track(e.clientX, e.clientY)
  }
  const onPointerDown = (e: PointerEvent): void => {
    track(e.clientX, e.clientY)
    // Touch is handled by the touch listeners; only the primary mouse / pen button draws here.
    if (e.pointerType === 'touch' || e.button !== 0) return
    if (mouseOn) pointerHeld = true
  }
  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return
    pointerHeld = false
  }
  const onPointerCancel = (): void => {
    pointerHeld = false
  }
  const onTouchStart = (e: TouchEvent): void => {
    const t = e.touches[0]
    if (!t) return
    track(t.clientX, t.clientY)
    if (!mouseOn) return
    touchHeld = true
    if (e.cancelable) e.preventDefault()
  }
  const onTouchMove = (e: TouchEvent): void => {
    const t = e.touches[0]
    if (!t) return
    track(t.clientX, t.clientY)
    // Keep the page from scrolling or zooming while aiming.
    if (mouseOn && e.cancelable) e.preventDefault()
  }
  const onTouchEnd = (e: TouchEvent): void => {
    if (e.touches.length === 0) touchHeld = false
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.code === 'KeyD') {
      if (e.repeat) return
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return
      api.toggle()
      return
    }
    if (e.code === 'Space') {
      if (!mouseOn) return
      if (isControlTarget(e.target) || isControlTarget(document.activeElement)) return
      e.preventDefault()
      if (e.repeat) return
      spaceHeld = true
    }
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') spaceHeld = false
  }
  const onBlur = (): void => {
    releaseAll()
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') releaseAll()
  }

  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  canvas.addEventListener('touchstart', onTouchStart, { passive: false })
  canvas.addEventListener('touchmove', onTouchMove, { passive: false })
  window.addEventListener('touchend', onTouchEnd)
  window.addEventListener('touchcancel', onTouchEnd)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)

  const api: ArcheryInput = {
    get mouseOn() {
      return mouseOn
    },
    get drawing() {
      return mouseOn && (pointerHeld || touchHeld || spaceHeld)
    },
    setMouse(on) {
      if (on === mouseOn) return
      mouseOn = on
      if (!on) releaseAll()
      onToggle?.(mouseOn)
    },
    toggle() {
      api.setMouse(!mouseOn)
      return mouseOn
    },
    pointer() {
      if (!mouseOn || !ndc) return null
      return { x: ndc.x, y: ndc.y }
    },
    dispose() {
      releaseAll()
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchEnd)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
  return api
}
