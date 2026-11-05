import { describe, it, expect } from 'vitest'
import { parseArgs } from './workspace-merge.js'

describe('workspace-merge CLI args', () => {
  it('is dry-run unless --apply is passed', () => {
    expect(parseArgs(['--from', 'example', '--to', 'your-org']).apply).toBe(false)
    expect(parseArgs(['--from', 'example', '--to', 'your-org', '--apply']).apply).toBe(true)
  })

  it('reads the slugs, vault root and backup dir', () => {
    const a = parseArgs([
      '--from', 'example', '--to', 'your-org',
      '--vault-root', '/home/operator/second-brain/workspaces',
      '--backup-dir', '/home/operator/backups/ws-merge',
      '--db', '/app/data/command-center.db',
    ])
    expect(a).toMatchObject({
      from: 'example',
      to: 'your-org',
      vaultRoot: '/home/operator/second-brain/workspaces',
      backupDir: '/home/operator/backups/ws-merge',
      db: '/app/data/command-center.db',
      skipVault: false,
      retireSourceVault: false,
    })
  })

  it('treats --unarchive as its own mode', () => {
    const a = parseArgs(['--unarchive', 'operationkit', '--apply'])
    expect(a.unarchive).toBe('operationkit')
    expect(a.from).toBeUndefined()
    expect(a.to).toBeUndefined()
  })

  it('carries the opt-in destructive-ish flags only when asked', () => {
    expect(parseArgs(['--skip-vault']).skipVault).toBe(true)
    expect(parseArgs(['--retire-source-vault']).retireSourceVault).toBe(true)
  })

  it('defaults the db path from DB_PATH', () => {
    const prev = process.env.DB_PATH
    process.env.DB_PATH = '/tmp/x.db'
    try {
      expect(parseArgs([]).db).toBe('/tmp/x.db')
    } finally {
      if (prev === undefined) delete process.env.DB_PATH
      else process.env.DB_PATH = prev
    }
  })
})
