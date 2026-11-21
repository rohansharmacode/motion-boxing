// Smoke test: dashboard -> goalkeeper (mouse mode via ?auto=mouse) -> full 5-kick shootout -> result
// screen -> Home. Runs against the real shell + game in /tests/gk-shell.html (real Three.js WebGL via
// swiftshader). Fails on any uncaught page error or console.error.
import { expect, test } from '@playwright/test'
import type { ConsoleMessage, Page } from '@playwright/test'

interface MotionEvent {
  sport: string
  event_type: string
  metrics: Record<string, unknown>
}

// The shell has two dashboard layouts behind a flag in src/shell/shell.ts (`channels`): the hero tile
// grid (.shell-tile, click launches) and the channel grid (.ch-tile, click opens a preview whose Start
// launches). These helpers work with whichever one is live.
const GK_TILE = '.shell-tile[data-id=goalkeeper], .ch-tile[data-id=goalkeeper]'

async function isChannels(page: Page): Promise<boolean> {
  return page.locator('.shell').evaluate((el) => el.classList.contains('shell--channels'))
}

/** Clicks the goalkeeper tile (and the preview's Start on the channel grid). */
async function openGoalkeeper(page: Page): Promise<void> {
  await page.locator(GK_TILE).click()
  if (await isChannels(page)) {
    await expect(page.locator('.ch-preview')).toHaveAttribute('data-id', 'goalkeeper')
    await page.locator('.ch-btn--start').click()
  }
}

/** The goalkeeper's record line on the dashboard (tile on the hero grid, preview panel on channels). */
async function bestLine(page: Page): Promise<string> {
  if (!(await isChannels(page))) return (await page.locator('.shell-tile[data-id=goalkeeper] .shell-tile-best').textContent()) ?? ''
  await page.locator('.ch-tile[data-id=goalkeeper]').click()
  await expect(page.locator('.ch-preview')).toBeVisible()
  const text = (await page.locator('.ch-preview-best').textContent()) ?? ''
  await page.keyboard.press('Escape')
  await expect(page.locator('.ch-preview')).toBeHidden()
  return text
}

/** Collects page errors and console.error lines for the whole test. */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })
  return errors
}

test('dashboard → goalkeeper via ?auto=mouse → result screen → Home', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = watchErrors(page)

  await page.goto('/tests/gk-shell.html?auto=mouse')

  // Dashboard
  const tile = page.locator(GK_TILE)
  await expect(tile).toBeVisible()
  await expect(tile).toHaveAttribute('data-ready', 'true')
  await expect(page.locator('.shell')).toHaveAttribute('data-view', 'home')
  expect(await bestLine(page)).toBe('No rounds yet')
  await openGoalkeeper(page)

  // auto=mouse skips the start screen straight into play.
  const hud = page.locator('.gk-hud')
  await expect(hud).toHaveAttribute('data-view', 'play', { timeout: 15_000 })
  await expect(page.locator('.shell')).toHaveAttribute('data-view', 'game')
  expect(await page.evaluate(() => (window as unknown as { __shell: { current: string | null } }).__shell.current)).toBe(
    'goalkeeper',
  )
  await expect(page.locator('.gk-badge')).toHaveAttribute('data-mode', 'mouse')

  // Sweep the mouse around the canvas until the shootout ends.
  const canvas = page.locator('.gk-root canvas')
  await expect(canvas).toHaveCount(1)
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas has no bounding box')
  const deadline = Date.now() + 90_000
  let t = 0
  while ((await hud.getAttribute('data-view')) !== 'end') {
    if (Date.now() > deadline) throw new Error('shootout did not reach the end screen within 90 s')
    t += 1
    const x = box.x + box.width * (0.5 + 0.3 * Math.sin(t * 0.7))
    const y = box.y + box.height * (0.5 + 0.2 * Math.cos(t * 1.1))
    await page.mouse.move(x, y, { steps: 4 })
    await page.waitForTimeout(150)
  }

  // Result screen
  const end = page.locator('.gk-end')
  await expect(end).toBeVisible()
  const heading = end.locator('.gk-end-saves')
  await expect(heading).toHaveText(/^SAVES [0-5]\/5$/)
  await expect(end.locator('.gk-kicks tbody tr')).toHaveCount(5)
  // Stats block (labels vary between HUD revisions; Score and an average-reaction stat are required).
  const statLabels = await end.locator('.gk-stats dt').allTextContents()
  expect(statLabels).toContain('Score')
  expect(statLabels.some((l) => /^Avg react/i.test(l))).toBe(true)
  const statValue = async (label: string): Promise<string> =>
    ((await end.locator('.gk-stat', { has: page.locator('dt', { hasText: label }) }).locator('dd').textContent()) ?? '').trim()
  expect(await statValue('Score')).toMatch(/^\d[\d,]*$/)
  // Actions: replay (labelled "Again" or, in newer HUDs, "Rematch") then Home.
  const actions = end.locator('.gk-actions button')
  await expect(actions).toHaveCount(2)
  await expect(actions.nth(0)).toHaveText(/^(Again|Rematch)$/)
  await expect(actions.nth(0)).toBeVisible()
  await expect(actions.nth(1)).toHaveText('Home')
  await expect(actions.nth(1)).toBeVisible()

  // Telemetry: exactly 5 kick results and one summary TICK.
  const events = await page.evaluate(() => (window as unknown as { __events: MotionEvent[] }).__events)
  const kicks = events.filter((e) => e.event_type === 'SAVE' || e.event_type === 'GOAL')
  expect(kicks).toHaveLength(5)
  for (const k of kicks) expect(k.sport).toBe('GOALKEEPER')
  const summaries = events.filter((e) => e.event_type === 'TICK' && e.metrics.summary === true)
  expect(summaries).toHaveLength(1)
  // Heading agrees with the SAVE events.
  const saves = kicks.filter((k) => k.event_type === 'SAVE').length
  await expect(heading).toHaveText(`SAVES ${saves}/5`)
  if (statLabels.includes('Save %')) expect(await statValue('Save %')).toBe(`${saves * 20} %`)

  // Home tears the game down.
  await actions.nth(1).click()
  await expect(page.locator('.shell')).toHaveAttribute('data-view', 'home')
  expect(await page.evaluate(() => (window as unknown as { __shell: { current: string | null } }).__shell.current)).toBeNull()
  await expect(page.locator('.gk-root')).toHaveCount(0)
  await expect(page.locator('canvas')).toHaveCount(0)

  // Dashboard record updated from the summary TICK.
  const record = await page.evaluate(() => {
    const raw = localStorage.getItem('motion-sports.records.v1')
    return raw ? (JSON.parse(raw) as Record<string, { rounds: number }>) : null
  })
  expect(record?.goalkeeper?.rounds).toBe(1)
  // The dashboard's record line reflects the new round.
  expect(await bestLine(page)).toMatch(/^1 round( |$)/)

  expect(errors).toEqual([])
})
