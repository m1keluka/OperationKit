// Script routines (obj 64 Part B) — pure outcome decision + the real executor.
import { describe, it, expect } from 'vitest'
import {
  decideScriptOutcome,
  findAlertLine,
  defaultScriptExecutor,
  tailOf,
  DEFAULT_ALERT_MARKER,
} from './routine-script.js'

const run = (exitCode: number | null, output = '', extra: Partial<{ timedOut: boolean; spawnError: string; signal: string }> = {}) => ({
  exitCode,
  output,
  timedOut: extra.timedOut ?? false,
  spawnError: extra.spawnError,
  signal: extra.signal ?? null,
})

describe('decideScriptOutcome', () => {
  it('exit 0 with no marker → ok, no escalation, not a failure', () => {
    const o = decideScriptOutcome(run(0, 'all good\nok\n'))
    expect(o).toMatchObject({ status: 'ok', escalate: false, isFailure: false })
  })

  it('non-zero exit → failed, escalates, counts as a failure', () => {
    const o = decideScriptOutcome(run(2, 'boom'))
    expect(o).toMatchObject({ status: 'failed', escalate: true, isFailure: true, reason: 'exit 2' })
  })

  it("exit 0 with an 'ALERT:' line → alert, escalates, NOT a failure", () => {
    const o = decideScriptOutcome(run(0, 'checking\nALERT: disk 91%\ndone'))
    expect(o).toMatchObject({ status: 'alert', escalate: true, isFailure: false, alertLine: 'ALERT: disk 91%' })
    expect(DEFAULT_ALERT_MARKER).toBe('ALERT:')
  })

  it('honours a custom per-routine marker (and ignores the default one then)', () => {
    expect(decideScriptOutcome(run(0, '!!PAGE dns down'), { alertMarker: '!!PAGE' }).status).toBe('alert')
    expect(decideScriptOutcome(run(0, 'ALERT: x'), { alertMarker: '!!PAGE' }).status).toBe('ok')
  })

  it('the marker must be at the START of a line', () => {
    expect(decideScriptOutcome(run(0, 'note: ALERT: not really')).status).toBe('ok')
    expect(decideScriptOutcome(run(0, '  ALERT: indented')).status).toBe('ok')
    expect(decideScriptOutcome(run(0, 'first\r\nALERT: crlf\r\n')).status).toBe('alert')
  })

  it('timeout → failed even if exit code looks clean', () => {
    const o = decideScriptOutcome(run(null, '', { timedOut: true }), { timeoutSec: 600 })
    expect(o).toMatchObject({ status: 'failed', isFailure: true, escalate: true, reason: 'timed out after 600s' })
  })

  it('spawn error → failed', () => {
    expect(decideScriptOutcome(run(null, '', { spawnError: 'ENOENT' }))).toMatchObject({ status: 'failed', isFailure: true })
  })

  it('non-zero exit with an alert line is still a failure', () => {
    expect(decideScriptOutcome(run(1, 'ALERT: x')).isFailure).toBe(true)
  })

  it('signal-killed (exitCode null) → failed', () => {
    expect(decideScriptOutcome(run(null, '', { signal: 'SIGKILL' })).reason).toBe('killed by SIGKILL')
  })
})

describe('helpers', () => {
  it('findAlertLine returns the first matching line', () => {
    expect(findAlertLine('a\nALERT: one\nALERT: two', 'ALERT:')).toBe('ALERT: one')
    expect(findAlertLine('a', '')).toBeNull()
  })
  it('tailOf keeps the last N chars', () => {
    expect(tailOf('abcdef', 3)).toBe('def')
    expect(tailOf('ab', 3)).toBe('ab')
  })
})

describe('defaultScriptExecutor (real bash)', () => {
  it('captures stdout+stderr and the exit code', async () => {
    const r = await defaultScriptExecutor('echo out; echo err 1>&2; exit 3', { timeoutMs: 10_000 })
    expect(r.exitCode).toBe(3)
    expect(r.timedOut).toBe(false)
    expect(r.output).toContain('out')
    expect(r.output).toContain('err')
  })

  it('kills a script that exceeds its timeout', async () => {
    const r = await defaultScriptExecutor('sleep 20', { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(decideScriptOutcome(r).status).toBe('failed')
    expect(r.durationMs).toBeLessThan(10_000)
  })

  it('caps retained output to the tail', async () => {
    const r = await defaultScriptExecutor('for i in $(seq 1 2000); do echo line-$i; done', {
      timeoutMs: 10_000,
      maxOutputBytes: 100,
    })
    expect(r.exitCode).toBe(0)
    expect(r.output.length).toBeLessThanOrEqual(100)
    expect(r.output).toContain('line-2000')
  })
})

describe('scriptEnv (obj 64 hardening)', () => {
  it('drops the server JWT signing secrets but keeps the rest of the env', async () => {
    const { scriptEnv } = await import('./routine-script.js')
    const env = scriptEnv({ JWT_SECRET: 'a', CC_JWT_SECRET: 'b', PATH: '/bin', FOO: 'x' })
    expect(env.JWT_SECRET).toBeUndefined()
    expect(env.CC_JWT_SECRET).toBeUndefined()
    expect(env).toMatchObject({ PATH: '/bin', FOO: 'x' })
  })
})
