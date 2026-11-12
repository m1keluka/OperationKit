# Notifications: which types fire (obj 900677)

The bell (and email, for `high` / `emergency`) reads the `alerts` table. Every
server-side writer goes through `insertAlert` / `notify` in
`app/server/src/services/notifier.ts`, which now checks one registry,
`NOTIFICATION_TYPES`, before it writes anything.

**Rule:** a type is on only if a human has to act and nothing else already
covers it. Nothing else means: not the card itself, not its owner bot, and not an
automatic retry. Per-card problems show on the card and wake the card's bot, so
they are off.

## Types

| Key (`source[:kind]`) | Default | Why |
|---|---|---|
| `objectives-safety` | on | The board row count dropped sharply: possible data loss. |
| `account-router` | on | A Claude account needs reconnecting or an admin. |
| `seat-pool` | on | A seat credential expired or expires soon. |
| `drift-guard` | on | Unbacked edits on the live checkout, ahead of main, or behind main for 2h+. |
| `disk-watchdog` | on | Disk low or critically full. |
| `n8n-watchdog` | on | n8n is down after the auto-restart. |
| `preview-health-watchdog` | on | The PR preview tier is down. |
| `routines` | on | A routine stopped firing or was auto-paused. |
| `posthog-hot-owner-sync` | on | PostHog sync failed several runs in a row. |
| `disabled-model-rescue` | on | Open cards point at a disabled model. |
| `ci-green-gate` | on | A PR hit the CI hold cap and will not be retried. |
| `pr-health-watchdog` | on | A red PR has no session left to fix it. |
| `stall-watchdog` | **off** | Per card. Stalled flag on the card; owner bot woken. |
| `abnormal-end` | **off** | Per card. Card parked blocked; owner bot woken. |
| `runner-failure` | **off** | Per card. Card parked in Review, blocked. |
| `state-poller` | **off** | Per card. Delegator parked in Review after no-progress wakes. |
| `disk-watchdog:warn` | **off** | Early warning. Cleanup runs by itself at 90%. |
| `n8n-watchdog:recovered` | **off** | Recovery now clears the "down" item instead. |
| `preview-health-watchdog:recovered` | **off** | Recovery now clears the "down" item instead. |

A source that is not listed, such as a cron script posting to `POST /api/alerts`,
is **on**. A `source:kind` with no entry of its own follows its source.

## Turning a type on or off

No deploy needed. The setting is read on every alert:

```sql
INSERT OR REPLACE INTO settings (key, value) VALUES ('notify:stall-watchdog', '1');  -- on
INSERT OR REPLACE INTO settings (key, value) VALUES ('notify:seat-pool', '0');       -- off
```

## One item per condition

- A condition whose alert is still **unread** is not raised again (same
  `dedup_key`). Before, the only dedup was a 10-minute in-memory window. A
  condition that lasted a day added a row every 10 minutes and again after every
  restart.
- A recovery passes `resolves: '<down dedup_key>'`. The down item is marked read
  (`acked_by = 'auto-resolved'`) and no "recovered" item is added.
- Disk alerts use stable keys and throttle by time bucket in the watchdog itself.
- `drift-guard` alerts at once for dirty or ahead. When the checkout is only
  behind main, it waits `DRIFT_BEHIND_GRACE_MS` (2h). Every merge leaves the
  checkout behind until auto-deploy pulls it, so the old check alerted after
  nearly every merge.
- `disabled-model-rescue` ignores `cancelled` cards. They never spawn, and they
  re-raised this alert on every boot.

## Not covered here

Telegram sends (`sendTelegram`) are a separate channel and were not changed.
These include review cap-outs, watchdog force-routes, usage-limit pauses and the
Assistant nudge.
