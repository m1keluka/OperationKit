/**
 * Seat management end to end (obj 720330), light + dark:
 *   one-place navigation → add a Claude seat with Sign in with Claude (stubbed
 *   token endpoint, double-clicked Connect) → error states → paste-token
 *   fallback → rename → Reconnect with Sign in with Claude (in place) → Remove
 *   (confirm, gone after reload, audited).
 * Screenshots land in tests/smoke/seat-management/<theme>-NN-<slug>.png.
 */
import { test, expect, type Page, type Locator, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const SHOTS = path.resolve(__dirname, '../../smoke/seat-management')
const STUB = process.env.E2E_STUB_URL || 'http://127.0.0.1:4555'
const USER = process.env.E2E_ADMIN_USER || 'e2e-admin'
const PASS = process.env.E2E_ADMIN_PASS || ''
const PASTED = 'sk-ant-oat01-e2e-pasted-setup-token-0000000000000000000000-p9'

fs.mkdirSync(SHOTS, { recursive: true })

async function shot(page: Page, theme: string, name: string, target?: Locator) {
  await page.waitForTimeout(250)
  const file = path.join(SHOTS, `${theme}-${name}.png`)
  if (target) await target.screenshot({ path: file })
  else await page.screenshot({ path: file, fullPage: true })
}

async function stubCalls(request: APIRequestContext): Promise<number> {
  return (await (await request.get(`${STUB}/__calls`)).json()).count
}

async function login(page: Page, theme: string) {
  await page.addInitScript(t => { localStorage.setItem('ok-theme', t) }, theme)
  const r = await page.request.post('/api/auth/login', { data: { username: USER, password: PASS } })
  expect(r.status()).toBe(200)
}

async function clearSeats(page: Page) {
  const { seats } = await (await page.request.get('/api/admin/seats')).json()
  for (const s of seats) await page.request.delete(`/api/admin/seats/${s.id}`)
}

/** Seat cards only (the usage stats inside a card carry seat-usage-* test ids). */
const allSeatCards = (page: Page) => page.locator('[data-testid^="seat-"]:has(h4)')
const seatCard = (page: Page, label: string) => allSeatCards(page).filter({ hasText: label })
const claudeSection = (page: Page) => page.locator('section[aria-labelledby="seats-claude"]')

/** The state the server put in the sign-in link (what Claude echoes back after `#`). */
async function signInState(scope: Locator): Promise<string> {
  const link = scope.getByRole('link', { name: /Sign in with Claude/ })
  await expect(link).toBeVisible()
  const href = (await link.getAttribute('href'))!
  const u = new URL(href)
  expect(u.origin + u.pathname).toBe('https://claude.com/cai/oauth/authorize')
  expect(u.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
  expect(u.searchParams.get('scope')).toBe('user:inference')
  expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  return u.searchParams.get('state')!
}

test.describe.configure({ mode: 'serial' })

test('seat management: one place, add, errors, fallback, rename, reconnect, remove', async ({ page }, info) => {
  const theme = info.project.name
  await login(page, theme)
  await clearSeats(page)

  // ── 1. One place: old URLs and the System page all lead to Settings → Models ──
  await page.goto('/settings/seats')
  await expect(page).toHaveURL(/\/settings\/models$/)
  await expect(page.getByRole('heading', { name: 'Subscription seats' })).toBeVisible()
  await page.goto('/system')
  await page.getByRole('link', { name: /Manage AI accounts in Settings > Models/ }).click()
  await expect(page).toHaveURL(/\/settings\/models$/)
  // The old Dashboard write routes are gone from the API too.
  const legacy = await page.request.post('/api/admin/accounts', { data: { kind: 'claude', label: 'x' } })
  expect(legacy.status()).toBe(410)
  expect((await legacy.json()).manage).toBe('/settings/models')
  await expect(claudeSection(page)).toContainText('No Claude seats yet')
  await shot(page, theme, '01-seats-empty')

  // ── 2. Add a Claude seat with Sign in with Claude (double-clicked Connect) ──
  await claudeSection(page).getByRole('button', { name: 'Add Claude seat' }).first().click()
  const addForm = page.getByRole('group', { name: 'Add Claude seat' })
  await addForm.getByLabel('Label', { exact: true }).fill('E2E Claude Max')
  const state = await signInState(addForm)
  await shot(page, theme, '02-add-sign-in-link', addForm)
  const before = await stubCalls(page.request)
  await addForm.getByLabel(/Authentication code/).fill(`auth-code-1#${state}`)
  await addForm.getByRole('button', { name: 'Connect seat' }).dblclick()
  await expect(page.getByText('E2E Claude Max is signed in and answered its test turn. Healthy.')).toBeVisible({ timeout: 30_000 })
  expect(await stubCalls(page.request)).toBe(before + 1) // one exchange for a double-click
  await expect(seatCard(page, 'E2E Claude Max')).toHaveCount(1)
  const added = seatCard(page, 'E2E Claude Max')
  await expect(added).toContainText('Healthy')
  await expect(added).toContainText('via Sign in with Claude')
  await expect(added.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
  await shot(page, theme, '03-added-healthy')

  // ── 3. Error states: Claude rejects the code; a code from another link ──
  await claudeSection(page).getByRole('button', { name: 'Add Claude seat' }).click()
  const errForm = page.getByRole('group', { name: 'Add Claude seat' })
  const errState = await signInState(errForm)
  await errForm.getByLabel(/Authentication code/).fill(`bad-code#${errState}`)
  await errForm.getByRole('button', { name: 'Connect seat' }).click()
  await expect(errForm.getByText(/Claude did not accept that code/)).toBeVisible()
  await shot(page, theme, '04-error-bad-code', errForm)
  await errForm.getByLabel(/Authentication code/).fill('some-code#state-from-another-link')
  await errForm.getByRole('button', { name: 'Connect seat' }).click()
  await expect(errForm.getByText(/That code is from a different sign-in link/)).toBeVisible()
  await shot(page, theme, '05-error-state-mismatch', errForm)
  await errForm.getByRole('button', { name: 'Cancel' }).first().click()
  await expect(seatCard(page, 'E2E Claude Max')).toHaveCount(1)
  expect((await (await page.request.get('/api/admin/seats')).json()).seats).toHaveLength(1)

  // ── 4. Paste-token fallback (an "older" seat) ──
  await claudeSection(page).getByRole('button', { name: 'Add Claude seat' }).click()
  const pasteForm = page.getByRole('group', { name: 'Add Claude seat' })
  await pasteForm.getByLabel('Label', { exact: true }).fill('Old pasted seat')
  await pasteForm.getByRole('button', { name: 'Have a setup token already? Paste it instead' }).click()
  await pasteForm.getByLabel('Setup token', { exact: true }).fill(PASTED)
  await shot(page, theme, '06-paste-token-fallback', pasteForm)
  await pasteForm.getByRole('button', { name: 'Add seat' }).dblclick()
  await expect(page.getByText('Old pasted seat added.')).toBeVisible()
  await expect(seatCard(page, 'Old pasted seat')).toHaveCount(1)
  const old = seatCard(page, 'Old pasted seat')
  await expect(old).toContainText('pasted token')
  await expect(old).toContainText(`••••${PASTED.slice(-4)}`)
  const oldTestId = await old.getAttribute('data-testid')

  // ── 5. Rename (nickname persists across reload) ──
  // Address the card by its seat id from here on: the label text changes.
  const nick = page.locator(`[data-testid="${oldTestId}"]`)
  await nick.getByRole('button', { name: 'Rename' }).click()
  await nick.getByLabel('Seat name').fill('Operator Max (nickname)')
  await nick.getByRole('button', { name: 'Save' }).click()
  await expect(nick).toContainText('Operator Max (nickname)')
  await page.reload()
  await expect(nick).toContainText('Operator Max (nickname)')

  // ── 6. Reconnect with Sign in with Claude — in place ──
  await nick.getByRole('button', { name: 'Reconnect with Sign in with Claude' }).click()
  const reconnectForm = nick.getByRole('form', { name: 'Reconnect with Claude' })
  const rState = await signInState(reconnectForm)
  await shot(page, theme, '07-reconnect-sign-in', nick)
  const beforeR = await stubCalls(page.request)
  await reconnectForm.getByLabel(/Authentication code/).fill(`auth-code-2#${rState}`)
  await reconnectForm.getByRole('button', { name: 'Reconnect seat' }).click()
  await expect(page.getByText('Operator Max (nickname) is signed in and answered its test turn. Healthy.')).toBeVisible({ timeout: 30_000 })
  expect(await stubCalls(page.request)).toBe(beforeR + 1)
  await expect(nick).toContainText('via Sign in with Claude') // same data-testid = same seat id
  await expect(nick).not.toContainText(`••••${PASTED.slice(-4)}`)
  await expect(nick).toContainText('Healthy')
  await expect(allSeatCards(page)).toHaveCount(2)
  await shot(page, theme, '08-reconnected-in-place')
  await page.reload()
  await expect(nick).toContainText('Operator Max (nickname)')
  await expect(nick).toContainText('via Sign in with Claude')

  // ── 7. Remove: confirm, gone, stays gone, audited ──
  const target = seatCard(page, 'E2E Claude Max')
  const targetId = (await target.getAttribute('data-testid'))!.replace(/^seat-/, '')
  await target.getByRole('button', { name: 'Remove' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Remove E2E Claude Max?')
  await expect(dialog).toContainText('stored sign-in is deleted')
  await shot(page, theme, '09-remove-confirm')
  await dialog.getByRole('button', { name: 'Remove seat' }).click()
  await expect(page.getByText('E2E Claude Max removed.')).toBeVisible()
  await expect(seatCard(page, 'E2E Claude Max')).toHaveCount(0)
  await page.reload()
  await expect(page.locator(`[data-testid="${oldTestId}"]`)).toBeVisible()
  await expect(seatCard(page, 'E2E Claude Max')).toHaveCount(0)
  const audit = await (await page.request.get('/api/admin/seats/audit?limit=50')).json() as Array<{ action: string; seat_id: string; detail: string }>
  const removed = audit.find(a => a.action === 'remove' && a.seat_id === targetId)
  expect(removed?.detail).toMatch(/credential=deleted/)
  expect(audit.some(a => a.action === 'reconnect' && /via=oauth/.test(a.detail))).toBe(true)
  await shot(page, theme, '10-after-remove')
})

test('seats screen at 360 / 768 / 1440', async ({ page }, info) => {
  const theme = info.project.name
  await login(page, theme)
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/settings/models')
    await expect(page.getByRole('heading', { name: 'Subscription seats' })).toBeVisible()
    await expect(allSeatCards(page).first()).toBeVisible()
    // Nothing on the seats screen scrolls sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await shot(page, theme, `11-seats-${width}`)
  }
})
