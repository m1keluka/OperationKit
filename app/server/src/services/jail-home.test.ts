/**
 * obj 900038 — per-session jail homes must not leave secrets on disk.
 *
 * Before this: /tmp/cc-jail-homes/<sid>/ was drwxrwxrwx and held <sid>.env (the
 * docker --env-file: every injected secret in plaintext) and <sid>.sh (the
 * wrapper, with one `export KEY="value"` per secret). Nothing removed them when
 * a session died early, and nothing swept them when the control plane crashed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  jailHomePaths,
  secretFiles,
  createJailHome,
  scrubJailSecrets,
  cleanupJailHome,
  materializeTranscript,
  dropEnvFile,
  sweepOrphanJailHomes,
  sweepOrphanJailHomesThrottled,
  SWEEP_INTERVAL_MS,
  __resetJailHomeSweepThrottleForTests,
} from './jail-home.js'

const SID = 'cc-900038-1762000000000'
const SECRET = 'sk-live-do-not-leak-0123456789'

let root: string
let canonicalDir: string

/** Stand up a jail home exactly as spawnInTmux does, secrets and all. */
function seedSession(sid = SID): ReturnType<typeof jailHomePaths> {
  const p = createJailHome(sid, root)
  fs.writeFileSync(p.envFile, `ANTHROPIC_API_KEY=${SECRET}\nFOO=bar\n`)
  fs.writeFileSync(p.scriptFile, `#!/bin/bash\nexport ANTHROPIC_API_KEY="${SECRET}"\n`)
  fs.writeFileSync(p.promptFile, 'do the thing')
  fs.writeFileSync(p.jsonl, '{"type":"result","result":"done"}\n')
  fs.writeFileSync(p.log, '[wrapper] Starting\n')
  return p
}

/** The canonical TRANSCRIPT_DIR symlinks that linkTranscript() creates. */
function linkCanonical(p: ReturnType<typeof jailHomePaths>, sid = SID) {
  const jsonl = path.join(canonicalDir, `${sid}.jsonl`)
  const log = path.join(canonicalDir, `${sid}.log`)
  fs.symlinkSync(p.jsonl, jsonl)
  fs.symlinkSync(p.log, log)
  return { jsonl, log }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jail-homes-'))
  canonicalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-transcripts-'))
  __resetJailHomeSweepThrottleForTests()
})
afterEach(() => {
  for (const d of [root, canonicalDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
})

describe('createJailHome — 0700, never 0777', () => {
  it('creates the HOME and .cc without world or group bits', () => {
    const p = createJailHome(SID, root)
    for (const dir of [p.home, p.scriptDir]) {
      const mode = fs.statSync(dir).mode & 0o777
      expect(mode).not.toBe(0o777)
      expect(mode & 0o004).toBe(0) // not readable by other => not listable
      expect(mode & 0o040).toBe(0) // not readable by group
    }
  })

  it('refuses a session id that would escape the root', () => {
    for (const bad of ['../evil', '/abs', 'a/b', '']) {
      expect(() => jailHomePaths(bad, root)).toThrow(/unsafe session id/)
    }
  })
})

describe('dropEnvFile — the --env-file dies with `docker run`', () => {
  it('removes the plaintext env file and is a no-op twice', () => {
    const p = seedSession()
    expect(fs.readFileSync(p.envFile, 'utf8')).toContain(SECRET)
    expect(dropEnvFile(p.envFile)).toBe(true)
    expect(fs.existsSync(p.envFile)).toBe(false)
    expect(dropEnvFile(p.envFile)).toBe(true)
    expect(dropEnvFile(undefined)).toBe(false)
  })
})

describe('scrubJailSecrets — nothing with a credential in it survives', () => {
  it('removes env file, wrapper and prompt but KEEPS the transcripts', () => {
    const p = seedSession()
    const removed = scrubJailSecrets(SID, root)
    expect(removed.sort()).toEqual(secretFiles(SID, root).sort())
    for (const f of secretFiles(SID, root)) expect(fs.existsSync(f)).toBe(false)
    expect(fs.existsSync(p.jsonl)).toBe(true)
    expect(fs.existsSync(p.log)).toBe(true)
  })

  it('leaves no file anywhere under the home still containing the secret', () => {
    seedSession()
    scrubJailSecrets(SID, root)
    const hits: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name)
        if (e.isDirectory()) walk(f)
        else if (fs.readFileSync(f, 'utf8').includes(SECRET)) hits.push(f)
      }
    }
    walk(root)
    expect(hits).toEqual([])
  })

  it('is a silent no-op for a session that was never jailed', () => {
    expect(scrubJailSecrets('cc-never-existed-1', root)).toEqual([])
  })
})

describe('cleanupJailHome — on session end, including an EARLY death', () => {
  it('an early death (wrapper never ran) still leaves no jail home and no secret', () => {
    // The exact shape of the bug: the wrapper exited at `cd` before writing
    // anything, so its own `rm -f` never ran.
    const p = createJailHome(SID, root)
    fs.writeFileSync(p.envFile, `ANTHROPIC_API_KEY=${SECRET}\n`)
    fs.writeFileSync(p.scriptFile, `export ANTHROPIC_API_KEY="${SECRET}"\n`)
    fs.writeFileSync(p.jsonl, '')
    fs.writeFileSync(p.log, '')

    expect(cleanupJailHome(SID, { root })).toBe(true)
    expect(fs.existsSync(p.home)).toBe(false)
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('materialises the canonical transcripts first, so the card keeps its evidence', () => {
    const p = seedSession()
    const canon = linkCanonical(p)
    expect(fs.lstatSync(canon.jsonl).isSymbolicLink()).toBe(true)

    cleanupJailHome(SID, { root, transcriptPaths: [canon.jsonl, canon.log] })

    expect(fs.existsSync(p.home)).toBe(false)
    expect(fs.lstatSync(canon.jsonl).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(canon.jsonl, 'utf8')).toContain('"result"')
    expect(fs.readFileSync(canon.log, 'utf8')).toContain('[wrapper] Starting')
  })

  it('keepHome scrubs the secrets but leaves the directory', () => {
    const p = seedSession()
    cleanupJailHome(SID, { root, keepHome: true })
    expect(fs.existsSync(p.home)).toBe(true)
    expect(fs.existsSync(p.envFile)).toBe(false)
    expect(fs.existsSync(p.jsonl)).toBe(true)
  })

  it('is idempotent and never throws on an absent home', () => {
    expect(cleanupJailHome('cc-nope-1', { root })).toBe(false)
    expect(cleanupJailHome('../escape', { root })).toBe(false)
  })

  it('materializeTranscript leaves a real file untouched', () => {
    const real = path.join(canonicalDir, 'real.jsonl')
    fs.writeFileSync(real, 'x')
    expect(materializeTranscript(real)).toBe(false)
    expect(fs.readFileSync(real, 'utf8')).toBe('x')
  })
})

describe('sweepOrphanJailHomes — the crashed-control-plane backstop', () => {
  const HOUR = 3_600_000

  function age(dir: string, ms: number, now: number) {
    const t = new Date(now - ms)
    fs.utimesSync(dir, t, t)
  }

  it('removes an old home with no live session, keeping live and recent ones', () => {
    const now = Date.now()
    const dead = seedSession('cc-dead-1')
    const live = seedSession('cc-live-2')
    const recent = seedSession('cc-recent-3')
    age(dead.home, 3 * HOUR, now)
    age(live.home, 3 * HOUR, now)
    age(recent.home, 60_000, now)

    const r = sweepOrphanJailHomes({ liveSessionIds: ['cc-live-2'], maxAgeMin: 120, root, now })

    expect(r.removed).toEqual(['cc-dead-1'])
    expect(r.skippedLive).toEqual(['cc-live-2'])
    expect(fs.existsSync(dead.home)).toBe(false)
    expect(fs.existsSync(live.home)).toBe(true)
    expect(fs.existsSync(recent.home)).toBe(true)
    // And the survivors' secrets were not touched by someone else's sweep.
    expect(fs.existsSync(live.envFile)).toBe(true)
  })

  it('never removes a session the caller says is live, however old', () => {
    const now = Date.now()
    const p = seedSession('cc-forever-9')
    age(p.home, 400 * HOUR, now)
    const r = sweepOrphanJailHomes({ liveSessionIds: ['cc-forever-9'], maxAgeMin: 1, root, now })
    expect(r.removed).toEqual([])
    expect(fs.existsSync(p.home)).toBe(true)
  })

  it('returns an empty result when the root does not exist', () => {
    const r = sweepOrphanJailHomes({ liveSessionIds: [], root: path.join(root, 'nope'), now: Date.now() })
    expect(r).toEqual({ scanned: 0, removed: [], skippedLive: [] })
  })

  it('throttled wrapper: no-op when disabled, then once per interval', () => {
    const now = Date.now()
    expect(sweepOrphanJailHomesThrottled({ enabled: false, liveSessionIds: [], now })).toBeNull()
    expect(sweepOrphanJailHomesThrottled({ enabled: true, liveSessionIds: [], now })).not.toBeNull()
    expect(sweepOrphanJailHomesThrottled({ enabled: true, liveSessionIds: [], now: now + 1000 })).toBeNull()
    expect(
      sweepOrphanJailHomesThrottled({ enabled: true, liveSessionIds: [], now: now + SWEEP_INTERVAL_MS + 1 }),
    ).not.toBeNull()
  })
})
