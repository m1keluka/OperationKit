const { chromium } = require('/tmp/cc-worktree-701977/node_modules/playwright-core')
const fs = require('fs')

const EXE = '/home/ccuser-c/.playwright-browsers/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'
const OUT = '/tmp/cc702389_shots'
const BASE = 'http://localhost:4599/'
fs.mkdirSync(OUT, { recursive: true })
const log = (...a) => console.log(...a)

;(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  page.on('pageerror', e => log('PAGEERROR:', e.message))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // Board renders → header Search affordance present
  await page.waitForSelector('[aria-label="Search objectives"]', { timeout: 15000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/01-board-with-search.png` })
  log('01 board — search button present:', await page.isVisible('[aria-label="Search objectives"]'))

  // Open the search panel
  await page.click('[aria-label="Search objectives"]')
  await page.waitForSelector('input[placeholder^="Search objectives"]', { timeout: 5000 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/02-panel-open.png` })
  log('02 panel open — keyword input focused')

  // Keyword mode: type a query that spans stages incl. DONE
  await page.fill('input[placeholder^="Search objectives"]', 'board')
  await page.waitForTimeout(700) // debounce + fetch
  await page.waitForSelector('[role="option"]', { timeout: 5000 })
  const kwRows = await page.$$eval('[role="option"]', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()))
  await page.screenshot({ path: `${OUT}/03-keyword-results.png` })
  log('03 keyword results (' + kwRows.length + '):'); kwRows.forEach(r => log('   ', r))

  // Prove a DONE objective is found + badged: search 'portal' → id 402 done
  await page.fill('input[placeholder^="Search objectives"]', 'portal')
  await page.waitForTimeout(700)
  await page.waitForSelector('[role="option"]', { timeout: 5000 })
  const doneRow = await page.$$eval('[role="option"]', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()))
  await page.screenshot({ path: `${OUT}/04-keyword-done-badge.png` })
  log('04 done search rows:'); doneRow.forEach(r => log('   ', r))

  // AI mode: toggle, type, submit (Enter)
  await page.click('button[aria-pressed]:has-text("AI")')
  await page.waitForTimeout(200)
  await page.fill('input[placeholder^="Describe"]', 'work that shipped, done and deploy')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  await page.waitForSelector('[role="option"]', { timeout: 5000 })
  const aiRows = await page.$$eval('[role="option"]', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()))
  await page.screenshot({ path: `${OUT}/05-ai-results.png` })
  log('05 AI results (' + aiRows.length + '):'); aiRows.forEach(r => log('   ', r))

  // AI 502 graceful message
  await page.fill('input[placeholder^="Describe"]', 'unconfigured')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  const errText = await page.textContent('[role="listbox"]').catch(() => '')
  await page.screenshot({ path: `${OUT}/06-ai-502-message.png` })
  log('06 AI 502 panel text:', (errText || '').replace(/\s+/g, ' ').trim().slice(0, 120))

  // Click a DONE result → ObjectiveModal opens with Re-Open
  await page.click('button[aria-pressed]:has-text("Keyword")')
  await page.fill('input[placeholder^="Search objectives"]', 'portal')
  await page.waitForTimeout(700)
  await page.waitForSelector('[role="option"]', { timeout: 5000 })
  await page.click('[role="option"]')
  // modal shows the title in an input + a Re-Open button for terminal state
  await page.waitForSelector('button:has-text("Re-Open")', { timeout: 6000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/07-modal-done-reopen.png` })
  const hasReopen = await page.isVisible('button:has-text("Re-Open")')
  const titleVal = await page.$eval('input', el => el.value).catch(() => '')
  log('07 modal opened — Re-Open visible:', hasReopen, '| title field:', JSON.stringify(titleVal))

  await browser.close()
  log('DONE — shots in ' + OUT)
})().catch(e => { console.error('DRIVER ERROR:', e); process.exit(1) })
