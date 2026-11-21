// Customise screen: pick a colour scheme, head, gloves and a name, with a slowly turning 3D preview.
// Every choice saves straight to localStorage; boxing reads it when a match starts.
// All buttons carry data-dwell and are at least 72px, so the hand cursor can pick them.
import './customise.css'
import {
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  RingGeometry,
  Scene,
  WebGLRenderer,
} from 'three'
import type { GameContext, GameSession } from '../shell/types.ts'
import { GLOVES, HEADS, NAME_MAX, SCHEMES, cleanName, loadLook, saveLook, schemeOf } from './look.ts'
import type { RobotLook } from './look.ts'
import { buildPreviewRobot } from './robot.ts'
import type { PreviewRobot } from './robot.ts'

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`

const NAME_A = ['Neo', 'Volt', 'Rex', 'Zip', 'Max', 'Bolt', 'Pix', 'Jet', 'Ace', 'Kit']
const NAME_B = ['Punch', 'Byte', 'Spark', 'Flux', 'Dash', 'Gear', 'Hex', 'Nova', 'Rush', 'Bop']
const randomName = (): string =>
  `${NAME_A[Math.floor(Math.random() * NAME_A.length)]}${NAME_B[Math.floor(Math.random() * NAME_B.length)]}`

/** Head icons: simple outlines, drawn for this project. */
const HEAD_ICON: Record<string, string> = {
  visor: '<path d="M12 30a20 20 0 0 1 40 0v8a14 14 0 0 1-14 14H26a14 14 0 0 1-14-14z"/><path d="M18 32h28" stroke-width="5"/><path d="M32 10V4"/>',
  dome: '<circle cx="32" cy="32" r="21"/><path d="M15 30q17-9 34 0" stroke-width="5"/>',
  antenna: '<path d="M14 26l18-10 18 10v16l-18 10-18-10z"/><path d="M24 33h4M36 33h4" stroke-width="5"/><path d="M32 16V7"/><circle cx="32" cy="5" r="2.5"/>',
  block: '<rect x="13" y="16" width="38" height="34" rx="3"/><path d="M19 31h26" stroke-width="5"/><path d="M9 30v6M55 30v6"/>',
}
const icon = (body: string): string =>
  `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export function startCustomise(ctx: GameContext): GameSession {
  let look: RobotLook = loadLook()

  const root = document.createElement('div')
  root.className = 'cz'
  root.innerHTML = `
    <div class="cz-frame">
      <header class="cz-head">
        <h1 class="cz-title">Customise</h1>
        <p class="cz-sub">Your robot in boxing and online 1v1</p>
      </header>
      <div class="cz-body">
        <section class="cz-card cz-stage" aria-label="Preview">
          <div class="cz-canvas"></div>
          <div class="cz-nameplate"></div>
        </section>
        <section class="cz-card cz-options">
          <div class="cz-group">
            <h2 class="cz-label">Name</h2>
            <div class="cz-name-row">
              <input class="cz-name" type="text" maxlength="${NAME_MAX}" placeholder="Your name" autocomplete="off" spellcheck="false" aria-label="Robot name" />
              <button type="button" class="cz-btn cz-random" data-dwell>Random</button>
            </div>
          </div>
          <div class="cz-group">
            <h2 class="cz-label">Colour</h2>
            <div class="cz-grid cz-grid--6" data-field="scheme">
              ${SCHEMES.map((s) => `<button type="button" class="cz-opt cz-swatch" data-dwell data-value="${s.id}" aria-label="${s.label}" style="--c:${hex(s.accent)};--d:${hex(s.armour)}"><span class="cz-dot"></span><span class="cz-opt-label">${s.label}</span></button>`).join('')}
            </div>
          </div>
          <div class="cz-group">
            <h2 class="cz-label">Head</h2>
            <div class="cz-grid cz-grid--4" data-field="head">
              ${HEADS.map((h) => `<button type="button" class="cz-opt" data-dwell data-value="${h.id}" aria-label="${h.label}">${icon(HEAD_ICON[h.id] ?? '')}<span class="cz-opt-label">${h.label}</span></button>`).join('')}
            </div>
          </div>
          <div class="cz-group">
            <h2 class="cz-label">Gloves</h2>
            <div class="cz-grid cz-grid--6" data-field="glove">
              ${GLOVES.map((g) => `<button type="button" class="cz-opt cz-swatch" data-dwell data-value="${g.id}" aria-label="${g.label}" style="--l:${hex(g.colors[0])};--r:${hex(g.colors[1])}"><span class="cz-dot cz-dot--split"></span><span class="cz-opt-label">${g.label}</span></button>`).join('')}
            </div>
          </div>
        </section>
      </div>
      <footer class="cz-foot">
        <button type="button" class="cz-btn cz-reset" data-dwell>Reset</button>
        <button type="button" class="cz-btn cz-btn--primary cz-done" data-dwell>Done</button>
      </footer>
    </div>`
  ctx.host.append(root)

  const q = <T extends Element>(sel: string): T => {
    const el = root.querySelector<T>(sel)
    if (!el) throw new Error(`customise: missing ${sel}`)
    return el
  }
  const nameInput = q<HTMLInputElement>('.cz-name')
  const nameplate = q<HTMLElement>('.cz-nameplate')
  const canvasHost = q<HTMLElement>('.cz-canvas')

  // ---------- 3D preview ----------
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  canvasHost.append(renderer.domElement)
  const scene = new Scene()
  const camera = new PerspectiveCamera(30, 1, 0.1, 20)
  camera.position.set(0, 1.05, 4.1)
  camera.lookAt(0, 0.88, 0)
  const key = new DirectionalLight(0xffffff, 2.2)
  key.position.set(2, 3, 3)
  const rim = new DirectionalLight(0x9fb2ff, 1.2)
  rim.position.set(-2, 2, -3)
  scene.add(new HemisphereLight(0xc8d4ff, 0x141824, 1.4), new AmbientLight(0xffffff, 0.25), key, rim)
  const floorMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 })
  const floor = new Mesh(new RingGeometry(0.55, 0.58, 64), floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.position.y = 0.06
  scene.add(floor)
  const turntable = new Group()
  scene.add(turntable)
  let robot: PreviewRobot | null = null

  const rebuild = (): void => {
    if (robot) {
      turntable.remove(robot.group)
      robot.dispose()
    }
    robot = buildPreviewRobot(look)
    turntable.add(robot.group)
    floorMat.color.setHex(schemeOf(look).accent)
  }

  const resize = (): void => {
    const w = canvasHost.clientWidth
    const h = canvasHost.clientHeight
    if (w === 0 || h === 0) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(canvasHost)

  let raf = 0
  let last = performance.now()
  const loop = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    turntable.rotation.y += dt * 0.6
    if (robot) robot.group.position.y = Math.sin(now / 900) * 0.015
    renderer.render(scene, camera)
    raf = requestAnimationFrame(loop)
  }

  // ---------- options ----------
  const sync = (): void => {
    for (const grid of root.querySelectorAll<HTMLElement>('[data-field]')) {
      const field = grid.dataset.field as 'scheme' | 'head' | 'glove'
      for (const b of grid.querySelectorAll<HTMLButtonElement>('button')) {
        const on = b.dataset.value === look[field]
        b.classList.toggle('is-on', on)
        b.setAttribute('aria-pressed', String(on))
      }
    }
    if (document.activeElement !== nameInput) nameInput.value = look.name
    nameplate.textContent = look.name || 'Player'
    root.style.setProperty('--cz-accent', hex(schemeOf(look).accent))
  }

  const update = (patch: Partial<RobotLook>, rebuildModel = true): void => {
    look = { ...look, ...patch }
    saveLook(look)
    sync()
    if (rebuildModel) rebuild()
  }

  root.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button')
    if (!b) return
    const field = b.parentElement?.dataset.field
    if (field && b.dataset.value) update({ [field]: b.dataset.value } as Partial<RobotLook>)
    else if (b.classList.contains('cz-random')) update({ name: randomName() }, false)
    else if (b.classList.contains('cz-reset')) update({ scheme: 'volt', head: 'visor', glove: 'classic' })
    else if (b.classList.contains('cz-done')) ctx.exit()
  })
  nameInput.addEventListener('input', () => update({ name: cleanName(nameInput.value) }, false))
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur()
    e.stopPropagation() // typing must not reach game or shell key handlers
  })
  nameInput.addEventListener('blur', sync)

  sync()
  rebuild()
  resize()
  raf = requestAnimationFrame(loop)

  return {
    dispose() {
      cancelAnimationFrame(raf)
      observer.disconnect()
      robot?.dispose()
      floor.geometry.dispose()
      floorMat.dispose()
      renderer.dispose()
      root.remove()
    },
  }
}
