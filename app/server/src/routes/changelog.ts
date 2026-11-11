// "What's Shipping" changelog routes (obj 937).
//
// `default` export = the PUBLIC surface (mounted by the lead, no auth — gated by
// CHANGELOG_PUBLIC / CHANGELOG_TOKEN). `internalChangelogRouter` = localhost-only
// seed/admin surface (mounted at /api/internal/changelog by the lead).

import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  collectFromMergedPR,
  translateEntry,
  listPublished,
  listAllEntries,
  type MergedPRPayload,
} from '../services/changelog.js'
import type { ChangelogEntry } from '@operationkit/shared'

// ── helpers ──

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const CATEGORY_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  feature: { label: 'New', bg: '#e0f2fe', fg: '#0369a1' },
  fix: { label: 'Fix', bg: '#fef3c7', fg: '#92400e' },
  improvement: { label: 'Improved', bg: '#dcfce7', fg: '#166534' },
  infra: { label: 'Infra', bg: '#ede9fe', fg: '#5b21b6' },
}

function monthKey(iso: string): { key: string; label: string } {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { key: 'unknown', label: 'Recently' }
  const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label }
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function renderEntry(e: ChangelogEntry): string {
  const cat = CATEGORY_STYLE[e.category] || CATEGORY_STYLE.feature
  const shots = (e.screenshots || [])
    .map(
      (url) =>
        `<img class="shot" src="${esc(url)}" loading="lazy" alt="${esc(e.headline)} screenshot" />`
    )
    .join('\n')
  const overview = e.overview
    ? `<details class="how"><summary>How it works</summary><div class="how-body">${esc(
        e.overview
      )}</div></details>`
    : ''
  return `
  <article class="card">
    <div class="badges">
      <span class="badge platform">${esc(e.platform)}</span>
      <span class="badge cat" style="background:${cat.bg};color:${cat.fg}">${esc(cat.label)}</span>
      <span class="date">${esc(fmtDate(e.merged_at))}</span>
    </div>
    <h3 class="headline">${esc(e.headline || e.title_eng)}</h3>
    ${e.body_stakeholder ? `<p class="body">${esc(e.body_stakeholder)}</p>` : ''}
    ${overview}
    ${shots ? `<div class="shots">${shots}</div>` : ''}
    ${e.pr_url ? `<a class="pr" href="${esc(e.pr_url)}" target="_blank" rel="noopener">View PR</a>` : ''}
  </article>`
}

function renderPage(entries: ChangelogEntry[], banner?: string): string {
  // Group by month, preserving merged_at DESC order.
  const groups: { key: string; label: string; items: ChangelogEntry[] }[] = []
  for (const e of entries) {
    const { key, label } = monthKey(e.merged_at)
    let g = groups.find((x) => x.key === key)
    if (!g) {
      g = { key, label, items: [] }
      groups.push(g)
    }
    g.items.push(e)
  }

  const sections = groups
    .map(
      (g) =>
        `<section class="month"><h2 class="month-title">${esc(g.label)}</h2>${g.items
          .map(renderEntry)
          .join('\n')}</section>`
    )
    .join('\n')

  const empty = entries.length === 0 ? `<p class="empty">No updates published yet — check back soon.</p>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>What's Shipping</title>
<style>
  :root {
    --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --bg: #f8fafc;
    --card: #ffffff; --accent: #2563eb;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.55; -webkit-font-smoothing: antialiased;
  }
  .hero {
    background: linear-gradient(135deg, #1e293b 0%, #2563eb 100%);
    color: #fff; padding: 72px 24px 56px;
  }
  .hero-inner { max-width: 760px; margin: 0 auto; }
  .hero h1 { margin: 0 0 10px; font-size: 40px; letter-spacing: -0.02em; font-weight: 700; }
  .hero p { margin: 0; font-size: 18px; opacity: 0.85; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 40px 24px 80px; }
  .banner {
    background: #fffbeb; border: 1px solid #fde68a; color: #92400e;
    padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 28px;
  }
  .month { margin-bottom: 40px; }
  .month-title {
    font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); font-weight: 600; margin: 0 0 16px; padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 22px 24px; margin-bottom: 16px;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04);
  }
  .badges { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  .badge {
    font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px;
  }
  .badge.platform { background: #f1f5f9; color: #334155; }
  .date { margin-left: auto; font-size: 12px; color: var(--muted); }
  .headline { margin: 4px 0 8px; font-size: 21px; font-weight: 650; letter-spacing: -0.01em; }
  .body { margin: 0 0 12px; color: #334155; font-size: 15.5px; }
  .how { margin: 8px 0 12px; }
  .how summary {
    cursor: pointer; font-size: 13px; color: var(--accent); font-weight: 600;
    list-style: none; user-select: none;
  }
  .how summary::-webkit-details-marker { display: none; }
  .how summary::before { content: "▸ "; }
  .how[open] summary::before { content: "▾ "; }
  .how-body {
    margin-top: 8px; font-size: 14.5px; color: #475569;
    background: #f8fafc; border-left: 3px solid var(--line); padding: 10px 14px; border-radius: 6px;
  }
  .shots { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
  .shot {
    max-width: 100%; border-radius: 10px; border: 1px solid var(--line); display: block;
  }
  .pr {
    display: inline-block; margin-top: 6px; font-size: 13px; color: var(--muted);
    text-decoration: none; border-bottom: 1px dotted var(--muted);
  }
  .pr:hover { color: var(--accent); border-color: var(--accent); }
  .empty { color: var(--muted); text-align: center; padding: 60px 0; }
  footer { text-align: center; color: var(--muted); font-size: 12px; padding: 0 0 40px; }
</style>
</head>
<body>
  <header class="hero"><div class="hero-inner">
    <h1>What's Shipping</h1>
    <p>The latest improvements across our platforms.</p>
  </div></header>
  <main class="wrap">
    ${banner ? `<div class="banner">${esc(banner)}</div>` : ''}
    ${sections}
    ${empty}
  </main>
  <footer>Updated automatically as we ship.</footer>
</body>
</html>`
}

function privatePage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Private changelog</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#475569}
.box{text-align:center}h1{font-size:22px;color:#0f172a;margin:0 0 8px}p{margin:0;font-size:14px}</style>
</head><body><div class="box"><h1>This changelog is private</h1>
<p>A valid access token is required to view this page.</p></div></body></html>`
}

// ── PUBLIC router ──

const router = Router()

// Embeddable JSON feed — always available (published-only), CORS-open.
router.get('/feed.json', (_req: Request, res: Response) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.json({ entries: listPublished() })
})

// Server-rendered HTML changelog page.
router.get('/', (req: Request, res: Response) => {
  const isPublic = process.env.CHANGELOG_PUBLIC === '1'
  const token = process.env.CHANGELOG_TOKEN
  let banner: string | undefined

  if (!isPublic) {
    if (token) {
      const provided = typeof req.query.token === 'string' ? req.query.token : ''
      if (provided !== token) {
        return res.status(401).type('html').send(privatePage())
      }
    } else {
      // dev default-allow with a banner.
      banner = 'Dev mode: CHANGELOG_TOKEN is unset, so this page is open. Set CHANGELOG_TOKEN or CHANGELOG_PUBLIC=1 for production.'
    }
  }

  const entries = listPublished({ limit: 200 })
  res.status(200).type('html').send(renderPage(entries, banner))
})

export default router

// ── INTERNAL router (localhost-only, mounted by lead) ──

export const internalChangelogRouter = Router()

internalChangelogRouter.post('/collect', (req: Request, res: Response) => {
  try {
    const p = req.body as Partial<MergedPRPayload>
    if (!p || !p.repo || !p.prNumber) {
      return res.status(400).json({ error: 'repo and prNumber required' })
    }
    const payload: MergedPRPayload = {
      repo: String(p.repo),
      prNumber: Number(p.prNumber),
      prUrl: String(p.prUrl || ''),
      mergeCommitSha: p.mergeCommitSha ?? null,
      author: p.author ?? null,
      mergedAt: String(p.mergedAt || new Date().toISOString()),
      title: String(p.title || ''),
      body: String(p.body || ''),
      labels: Array.isArray(p.labels) ? p.labels.map(String) : [],
    }
    const { entryId, status } = collectFromMergedPR(payload)
    res.json({ entryId, status })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

internalChangelogRouter.post('/retranslate/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
  const status = translateEntry(id)
  res.json({ entryId: id, status })
})

internalChangelogRouter.get('/entries', (_req: Request, res: Response) => {
  res.json({ entries: listAllEntries() })
})
