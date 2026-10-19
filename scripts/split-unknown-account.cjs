#!/usr/bin/env node
/*
 * One-time: attribute historical 'unknown'-account cost evenly (by dollars)
 * across accounts `a` and `c`, per Mike's directive (2026-06-14).
 *
 * Why this exists: ~874 historical sessions ran before CC durably recorded which
 * subscription account they used, so their (real, counted) cost landed in an
 * 'unknown' bucket. Mike chose to split that pool evenly across his two primary
 * accounts rather than leave it unattributed. The cost TOTAL is unchanged — this
 * only decides which account column it shows under.
 *
 * Mechanism: writes session_account_override (session_id -> account_id).
 * backfillDailyUsage() in session-intel.ts consults it as a fallback AFTER
 * session_intel, so a recovered real account always wins and the assignment
 * survives every idempotent rebuild. Reversible: DELETE FROM
 * session_account_override WHERE reason LIKE 'historical unknown%' then re-run
 * the backfill (boot/sweep) -> those sessions return to 'unknown'.
 *
 * Deterministic + idempotent: greedy longest-processing-time over unknown
 * sessions sorted by cost desc (tie: session_id), so re-running converges.
 *
 * Run: docker exec -w /app command-center node scripts/split-unknown-account.cjs
 * After running, trigger a full backfill (restart the backend) to apply it.
 */
const Database = require('better-sqlite3');
const DB_PATH = process.env.DB_PATH || '/app/data/command-center.db';
const TARGETS = ['a', 'c'];
const REASON = 'historical unknown account — even A/C split per Mike 2026-06-14';

const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS session_account_override (
  session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, reason TEXT );`);

const rows = db.prepare(
  `SELECT session_id, SUM(cost_usd) cost FROM session_usage_daily
   WHERE account_id IS NULL GROUP BY session_id
   ORDER BY SUM(cost_usd) DESC, session_id ASC`
).all();

const running = Object.fromEntries(TARGETS.map((t) => [t, 0]));
const count = Object.fromEntries(TARGETS.map((t) => [t, 0]));
const ins = db.prepare(
  'INSERT OR REPLACE INTO session_account_override (session_id, account_id, reason) VALUES (?, ?, ?)'
);
db.transaction(() => {
  for (const r of rows) {
    // assign to the account with the lowest running total -> even by dollars
    const acct = TARGETS.reduce((lo, t) => (running[t] < running[lo] ? t : lo), TARGETS[0]);
    running[acct] += r.cost || 0;
    count[acct]++;
    ins.run(r.session_id, acct, REASON);
  }
})();

console.log(`split ${rows.length} unknown sessions across ${TARGETS.join('+')}:`);
for (const t of TARGETS) console.log(`  ${t}: ${count[t]} sessions  $${running[t].toFixed(2)}`);
console.log('NOTE: restart the backend (full backfill) to apply to the ledger.');
db.close();
