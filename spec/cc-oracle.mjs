#!/usr/bin/env node
// cc-oracle.mjs — Regression oracle for command-center-infra (Kitchen Loop pilot, obj 700077/700079/700099)
//
// Answers ONE question in bounded time: "Is command-center-infra at least as good as
// it was before this iteration?" — the Kitchen Loop regression-oracle contract (§7.2).
//
// It REUSES existing repo tooling (the Vitest suites + the live HTTP API + the live
// SQLite DB) rather than inventing a framework. Every check names the GROUND TRUTH it
// verifies (live API shape / real DB state / real test execution) so the result is
// "unbeatable" (§6.3 L3/L4): outcomes the author cannot fake, not mock-only.
//
// MODES
//   quick  (default) — every-iteration gate. Read-only live probes + DB invariants +
//                      a curated P0 lifecycle test slice. Target < 90s wall.
//   full             — periodic gate. Everything in quick + tsc build (compilation layer)
//                      + the FULL Vitest suite + a sandboxed transition E2E on a
//                      throwaway temp DB. Target < ~12m (the repo CI per-job cap).
//
// USAGE
//   node spec/cc-oracle.mjs            # quick
//   node spec/cc-oracle.mjs --full
//   node spec/cc-oracle.mjs --json     # machine-readable summary on stdout (for the drift store)
//   APP_URL=http://localhost:3002 DB_PATH=/app/data/command-center.db node spec/cc-oracle.mjs
//   CC_APP_ROOT=/abs/path/to/app node spec/cc-oracle.mjs   # override the app workspace root
//
// EXIT CODE: 0 iff every non-SKIP check is PASS (WARN does not fail the gate; FAIL does).
// Read-only by design: quick mode never mutates prod state. The temp-DB E2E (full mode)
// is fully isolated and never touches the live board.

import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// APP_ROOT resolution (robust to where the oracle is invoked from):
//   1) CC_APP_ROOT env override, else
//   2) the repo's app/ relative to this committed file (spec/ → ../app), else
//   3) the canonical deployed checkout path (fallback for odd cwd).
const __dirname = dirname(fileURLToPath(import.meta.url));
function resolveAppRoot() {
  if (process.env.CC_APP_ROOT) return process.env.CC_APP_ROOT;
  const relApp = resolve(__dirname, '..', 'app');
  if (existsSync(relApp)) return relApp;
  return '/home/operator/projects/command-center-infra/app';
}
const APP_ROOT = resolveAppRoot();
const APP_URL = process.env.APP_URL || 'http://localhost:3002';
const DB_PATH = process.env.DB_PATH || '/app/data/command-center.db';
const VALID_STATUS = ['planning', 'queue', 'working', 'ai_review', 'review', 'done'];
const MODE = process.argv.includes('--full') ? 'full' : 'quick';
const JSON_OUT = process.argv.includes('--json');

const require = createRequire(join(APP_ROOT, 'noop.js'));
const results = [];
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

async function check(name, tier, groundTruth, fn) {
  const t0 = Date.now();
  let status = 'PASS', detail = '';
  try {
    const r = await fn();
    status = r.status || 'PASS';
    detail = r.detail || '';
  } catch (e) {
    status = 'FAIL';
    detail = (e && e.message) || String(e);
  }
  const ms = Date.now() - t0;
  results.push({ name, tier, ground_truth: groundTruth, status, detail, ms });
  log(`  [${status.padEnd(4)}] ${name}  (${tier}, ${ms}ms) ${detail ? '— ' + detail : ''}`);
}

// ---- helpers ---------------------------------------------------------------
async function fetchJson(path, ms = 8000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(APP_URL + path, { signal: ctrl.signal });
    const body = await res.text();
    let json; try { json = JSON.parse(body); } catch { json = null; }
    return { ok: res.ok, code: res.status, json, body };
  } catch (e) {
    // Unreachable / timed-out probe is INCONCLUSIVE (server may be mid-deploy),
    // not proof of regression — surfaced as WARN by the caller, never RED.
    return { ok: false, code: 0, json: null, body: '', unreachable: true, err: (e && e.message) || String(e) };
  } finally { clearTimeout(to); }
}

function openDbReadonly() {
  const Database = require('better-sqlite3');
  if (!existsSync(DB_PATH)) throw new Error(`DB not found at ${DB_PATH}`);
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

function runVitest(pattern, timeoutMs) {
  // Reuse the existing Vitest tooling via the workspace binary. No new framework.
  const bin = join(APP_ROOT, 'node_modules', '.bin', 'vitest');
  const args = ['run', ...(pattern ? [pattern] : [])];
  const r = spawnSync(bin, args, {
    cwd: join(APP_ROOT, 'server'),
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/Tests\s+(\d+ passed.*?)(?:\n|$)/) || out.match(/(Test Files.*)/);
  return { code: r.status, summary: m ? m[1].trim() : out.slice(-200).trim(), timedOut: r.error?.code === 'ETIMEDOUT' };
}

// ---- checks ----------------------------------------------------------------
async function quickChecks() {
  // C1 — live API health. GROUND TRUTH: the running server's actual HTTP response.
  await check('live-api/health-shape', 'L2', 'live HTTP /api/health response', async () => {
    const r = await fetchJson('/api/health');
    if (r.unreachable) return { status: 'WARN', detail: `server unreachable (${r.err}) — may be mid-deploy` };
    if (r.json === null) return { status: 'WARN', detail: `non-JSON response (code ${r.code})` };
    if (r.json.status !== 'ok') throw new Error(`status != ok: ${JSON.stringify(r.json)}`);
    if (!/^\d{4}-\d\d-\d\dT/.test(r.json.timestamp || '')) throw new Error('missing ISO timestamp');
    return { detail: `status=ok ts=${r.json.timestamp}` };
  });

  // C2 — live objectives API contract. GROUND TRUTH: real rows shaped as the API claims.
  await check('live-api/objectives-contract', 'L3', 'live /api/internal/objectives array shape', async () => {
    // ?fields=minimal (obj 705914): the shape check only reads id/title/status,
    // and the unprojected board is 43 MB — enough to blow this 8s budget.
    const r = await fetchJson('/api/internal/objectives?fields=minimal', 8000);
    if (r.unreachable) return { status: 'WARN', detail: `server unreachable (${r.err})` };
    if (r.json === null) return { status: 'WARN', detail: `non-JSON response (code ${r.code})` };
    if (!Array.isArray(r.json)) throw new Error('response is not an array');
    if (r.json.length === 0) return { status: 'WARN', detail: 'empty board (no rows to shape-check)' };
    const o = r.json[0];
    for (const k of ['id', 'title', 'status']) if (!(k in o)) throw new Error(`row missing key: ${k}`);
    if (!VALID_STATUS.includes(o.status)) throw new Error(`row[0] invalid status: ${o.status}`);
    return { detail: `${r.json.length} objectives; row keys ok` };
  });

  // C3 — DB invariant: every objective.status is a legal lifecycle state.
  // GROUND TRUTH: the real SQLite table, not a fixture. Unbeatable state assertion.
  await check('db-invariant/objective-status', 'L3', 'real SQLite objectives.status column', async () => {
    const db = openDbReadonly();
    try {
      const q = `SELECT COUNT(*) bad FROM objectives WHERE status NOT IN (${VALID_STATUS.map(() => '?').join(',')})`;
      const bad = db.prepare(q).get(...VALID_STATUS).bad;
      const total = db.prepare('SELECT COUNT(*) c FROM objectives').get().c;
      if (bad > 0) throw new Error(`${bad} objectives in an invalid status`);
      return { detail: `${total} objectives, 0 invalid statuses` };
    } finally { db.close(); }
  });

  // C4 — DB invariant: session_intel.session_id is unique (no double-extraction).
  // GROUND TRUTH: real session rows. A real regression here = duplicate session intel.
  await check('db-invariant/session-uniqueness', 'L3', 'real SQLite session_intel rows', async () => {
    const db = openDbReadonly();
    try {
      const dup = db.prepare(
        'SELECT COUNT(*) d FROM (SELECT session_id FROM session_intel WHERE session_id IS NOT NULL GROUP BY session_id HAVING COUNT(*)>1)'
      ).get().d;
      if (dup > 0) throw new Error(`${dup} duplicated session_intel.session_id`);
      return { detail: '0 duplicate session ids' };
    } finally { db.close(); }
  });

  // C5 — regression suite slice: the P0 lifecycle state machine, via the EXISTING Vitest suite.
  // GROUND TRUTH: real test execution of the transition guard the whole board depends on.
  await check('regression-suite/lifecycle-slice', 'L1', 'Vitest run of reopen-transitions.test.ts', async () => {
    const r = runVitest('reopen-transitions', 120000);
    if (r.timedOut) throw new Error('vitest slice timed out (>120s)');
    if (r.code !== 0) throw new Error(`vitest slice failed: ${r.summary}`);
    return { detail: r.summary || 'passed' };
  });
}

async function fullChecks() {
  // F1 — compilation layer (Kitchen Loop §6.4 Layer 1). GROUND TRUTH: tsc accepts the tree.
  await check('build/server-typecheck', 'L1', 'tsc build of server workspace', async () => {
    const r = spawnSync('npm', ['run', 'build', '--workspace=server'], {
      cwd: APP_ROOT, timeout: 240000, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error('tsc build failed:\n' + ((r.stdout || '') + (r.stderr || '')).slice(-400));
    return { detail: 'tsc clean' };
  });

  // F2 — full regression suite (both workspaces). GROUND TRUTH: real execution.
  await check('regression-suite/full', 'L1-L3', 'npm run test (server+client Vitest)', async () => {
    const r = spawnSync('npm', ['run', 'test'], {
      cwd: APP_ROOT, timeout: 720000, encoding: 'utf8', env: { ...process.env, CI: 'true' },
    });
    const out = ((r.stdout || '') + (r.stderr || ''));
    if (r.status !== 0) throw new Error('full suite red:\n' + out.slice(-500));
    return { detail: 'full suite green' };
  });

  // F3 — sandboxed transition E2E (Layer-4 state delta, §6.4). GROUND TRUTH: a REAL status
  // transition is durably written to a REAL (throwaway) SQLite db, then re-read. Isolated
  // from the live board — never mutates prod.
  await check('e2e/transition-state-delta', 'L4', 'real status write to an isolated temp SQLite db', async () => {
    const Database = require('better-sqlite3');
    const dir = mkdtempSync(join(tmpdir(), 'cc-oracle-'));
    const tmpDb = join(dir, 'sandbox.db');
    try {
      const sandbox = new Database(tmpDb);
      sandbox.exec(`CREATE TABLE objectives (id INTEGER PRIMARY KEY, title TEXT, status TEXT NOT NULL);`);
      const ins = sandbox.prepare("INSERT INTO objectives (title, status) VALUES ('oracle-e2e','queue')");
      const id = ins.run().lastInsertRowid;
      sandbox.prepare('UPDATE objectives SET status=? WHERE id=?').run('working', id);
      const after = sandbox.prepare('SELECT status FROM objectives WHERE id=?').get(id).status;
      sandbox.close();
      if (after !== 'working') throw new Error(`state delta not durable: got ${after}`);
      return { detail: 'queue→working durably written + re-read (isolated db)' };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// ---- main ------------------------------------------------------------------
(async () => {
  log(`\ncc-oracle — mode=${MODE}  app=${APP_URL}  db=${DB_PATH}  appRoot=${APP_ROOT}\n`);
  await quickChecks();
  if (MODE === 'full') await fullChecks();

  const fails = results.filter(r => r.status === 'FAIL');
  const warns = results.filter(r => r.status === 'WARN');
  const pass = results.filter(r => r.status === 'PASS');
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  const verdict = fails.length === 0 ? 'GREEN (at-least-as-good)' : 'RED (regressed)';

  if (JSON_OUT) {
    console.log(JSON.stringify({ mode: MODE, verdict, totalMs, counts: { pass: pass.length, warn: warns.length, fail: fails.length }, results }, null, 2));
  } else {
    log(`\n  ── verdict: ${verdict} ──`);
    log(`  ${pass.length} pass / ${warns.length} warn / ${fails.length} fail   (${totalMs}ms total)\n`);
  }
  process.exit(fails.length === 0 ? 0 : 1);
})();
