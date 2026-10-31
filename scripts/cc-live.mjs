#!/usr/bin/env node
// cc-live — worker-side helper for live card visibility (obj 715699).
// Zero dependencies (Node 18+ global fetch). Talks to the localhost-only
// /api/internal routes, so it works from any session on the box.
//
//   node cc-live.mjs progress <objId> [--step N] [--of M] [--label "..."] [--note "..."]
//                                     [--result "..." | --result-json '{...}'] [--artifact path]...
//   node cc-live.mjs status   <objId> [--limit N]            # read a card's progress view
//   node cc-live.mjs children <objId>                        # children roll-up only
//   node cc-live.mjs artifacts <objId>                       # list live artifacts
//   node cc-live.mjs fanout   <parentId> --spec children.json [--max N] [--no-start]
//
// fanout spec: a JSON array of { title, description, agent_context?, workspace?, project?,
// type?, completion_goal?, model? } — each becomes a child card (type defaults to 'task')
// under <parentId>, then the group is registered with a concurrency ceiling (default 3,
// max 10). The server starts the first wave now and the rest as siblings finish.
//
// Env: CC_API_BASE (default http://localhost:3002).

import fs from 'node:fs'

const BASE = (process.env.CC_API_BASE || 'http://localhost:3002').replace(/\/$/, '')

function die(msg, code = 2) {
  process.stderr.write(`cc-live: ${msg}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const out = { _: [], artifact: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    if (key === 'no-start') { out.noStart = true; continue }
    const val = argv[i + 1]
    if (val === undefined) die(`--${key} needs a value`)
    i++
    if (key === 'artifact') out.artifact.push(val)
    else out[key] = val
  }
  return out
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  if (!res.ok) die(`${method} ${path} → HTTP ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`, 1)
  return json
}

function int(v, name) {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) die(`--${name} must be a non-negative integer`)
  return n
}

const [cmd, ...rest] = process.argv.slice(2)
const args = parseArgs(rest)
const id = int(args._[0], 'objective id')
if (!cmd || cmd === 'help' || cmd === '--help') {
  process.stdout.write(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n') + '\n')
  process.exit(0)
}
if (!id) die('objective id is required')

if (cmd === 'progress') {
  const body = {
    step: int(args.step, 'step'),
    total_steps: int(args.of, 'of'),
    label: args.label,
    note: args.note,
    result: args['result-json'] !== undefined ? JSON.parse(args['result-json']) : args.result,
    artifacts: args.artifact.length ? args.artifact : undefined,
  }
  const ev = await call('POST', `/api/internal/objectives/${id}/progress`, body)
  process.stdout.write(`progress #${ev.id} recorded${ev.step != null ? ` (step ${ev.step}${ev.total_steps ? `/${ev.total_steps}` : ''})` : ''}\n`)
} else if (cmd === 'status') {
  const q = args.limit ? `?limit=${int(args.limit, 'limit')}` : ''
  process.stdout.write(JSON.stringify(await call('GET', `/api/internal/objectives/${id}/progress${q}`), null, 2) + '\n')
} else if (cmd === 'children') {
  const view = await call('GET', `/api/internal/objectives/${id}/progress?limit=1`)
  process.stdout.write(JSON.stringify({ fanout: view.fanout, children: view.children }, null, 2) + '\n')
} else if (cmd === 'artifacts') {
  process.stdout.write(JSON.stringify(await call('GET', `/api/internal/objectives/${id}/artifacts`), null, 2) + '\n')
} else if (cmd === 'fanout') {
  if (!args.spec) die('--spec <children.json> is required')
  const spec = JSON.parse(fs.readFileSync(args.spec, 'utf8'))
  if (!Array.isArray(spec) || spec.length === 0) die('spec must be a non-empty JSON array')
  const parent = await call('GET', `/api/internal/objectives/${id}`)
  const items = spec.map(c => ({
    type: 'task',
    workspace: parent.workspace,
    project: parent.project || undefined,
    agent_context: parent.agent_context,
    ...c,
    parent_id: id,
  }))
  const created = await call('POST', '/api/internal/objectives', items)
  const list = Array.isArray(created) ? created : created.created || created.objectives || []
  const childIds = list.map(o => o.id).filter(Boolean)
  if (childIds.length !== items.length) die(`expected ${items.length} children, server returned ${childIds.length}: ${JSON.stringify(created).slice(0, 300)}`, 1)
  const out = await call('POST', `/api/internal/objectives/${id}/fanout`, {
    child_ids: childIds,
    max_concurrency: int(args.max, 'max'),
    start: !args.noStart,
  })
  process.stdout.write(JSON.stringify({ child_ids: childIds, group: out.group, started: out.tick?.started ?? [] }, null, 2) + '\n')
} else {
  die(`unknown command '${cmd}' (progress | status | children | artifacts | fanout)`)
}
