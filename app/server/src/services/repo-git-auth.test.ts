import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  GIT_TOKEN_ENV,
  bestEffortFetch,
  buildAuthedFetchArgv,
  ensureCredentialHelperScript,
  redactSecret,
  resolveGitFetchToken,
} from './repo-git-auth.js'

// obj 79 — ensureWorktree's fetch authenticates through a credential helper;
// the token is never in argv, the remote URL, or logs.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-auth-'))
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }))
const TOKEN = 'fake-fetch-token-for-unit-test'

describe('bestEffortFetch', () => {
  it('with a token: token only in the child env — never in argv; helper is wired via -c', () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const ok = bestEffortFetch('/srv/projects/app', TOKEN, {
      helperDir: DIR,
      baseEnv: { PATH: '/usr/bin' },
      execFile: (file, args, opts) => { calls.push({ file, args, env: opts.env }) },
      execShell: () => { throw new Error('unauthenticated path must not run') },
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    const { file, args, env } = calls[0]
    expect(file).toBe('git')
    expect(args.join(' ')).not.toContain(TOKEN)
    expect(args).toEqual(buildAuthedFetchArgv('/srv/projects/app', path.join(DIR, 'git-credential-cc-token.sh')))
    expect(args.slice(0, 4)).toEqual(['-c', 'credential.helper=', '-c', `credential.helper=${path.join(DIR, 'git-credential-cc-token.sh')}`])
    expect(env[GIT_TOKEN_ENV]).toBe(TOKEN)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('the helper script on disk contains no token', () => {
    const p = ensureCredentialHelperScript(DIR)
    expect(fs.readFileSync(p, 'utf8')).not.toContain(TOKEN)
    expect(fs.statSync(p).mode & 0o111).not.toBe(0)
  })

  it('failure is non-fatal and the warning never contains the token', () => {
    const warnings: string[] = []
    const ok = bestEffortFetch('/srv/projects/app', TOKEN, {
      helperDir: DIR,
      warn: (m) => warnings.push(m),
      execFile: () => {
        const e = new Error(`Command failed: git fetch\nremote: Invalid username or password ${TOKEN}`) as Error & { stderr: string }
        e.stderr = `fatal: Authentication failed for 'https://x-access-token:${TOKEN}@github.com/o/r.git'`
        throw e
      },
    })
    expect(ok).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('best-effort fetch failed')
    expect(warnings[0]).not.toContain(TOKEN)
    expect(warnings[0]).toContain('[REDACTED]')
  })

  it('without a token: runs exactly the previous unauthenticated command', () => {
    const cmds: string[] = []
    bestEffortFetch('/srv/projects/app', null, {
      execShell: (cmd) => { cmds.push(cmd) },
      execFile: () => { throw new Error('authed path must not run') },
    })
    expect(cmds).toEqual(['git -C "/srv/projects/app" fetch origin --quiet'])
  })

  it('without a token, a failure is still non-fatal', () => {
    const warnings: string[] = []
    expect(bestEffortFetch('/p', null, { warn: (m) => warnings.push(m), execShell: () => { throw new Error('could not read Username') } })).toBe(false)
    expect(warnings[0]).toContain('could not read Username')
  })
})

describe('credential helper script — real git credential protocol', () => {
  const fill = (env: NodeJS.ProcessEnv, host = 'github.com') => {
    const helper = ensureCredentialHelperScript(DIR)
    return execFileSync('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { PATH: process.env.PATH, HOME: DIR, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...env },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }

  it('answers github.com with the token from the env', () => {
    const out = fill({ [GIT_TOKEN_ENV]: TOKEN })
    expect(out).toContain('username=x-access-token')
    expect(out).toContain(`password=${TOKEN}`)
  })

  it('does not answer other hosts', () => {
    expect(() => fill({ [GIT_TOKEN_ENV]: TOKEN }, 'evil.example.com')).toThrow()
  })

  it('does not answer when no token is in the env', () => {
    expect(() => fill({})).toThrow()
  })
})

describe('resolveGitFetchToken', () => {
  it('falls back to the server env when no owner/workspace token is stored (DB unavailable)', () => {
    expect(resolveGitFetchToken({ workspace: 'example', created_by: null }, { GH_TOKEN: 'envtok' })).toBe('envtok')
    expect(resolveGitFetchToken({ workspace: 'example' }, { GITHUB_TOKEN: 'gh2' })).toBe('gh2')
    expect(resolveGitFetchToken({ workspace: 'example' }, {})).toBeNull()
  })
})

describe('redactSecret', () => {
  it('replaces every occurrence', () => {
    expect(redactSecret(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a [REDACTED] b [REDACTED]')
    expect(redactSecret('x', null)).toBe('x')
  })
})
