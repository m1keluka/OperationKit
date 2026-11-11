import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getActiveStateBlock, getVaultDeltaBlock, getOpenTasksBlock, buildSessionContext } from './mentor-context.js'

let vaultRoot: string

function write(rel: string, content: string, mtimeDaysAgo = 0): void {
  const full = path.join(vaultRoot, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  if (mtimeDaysAgo > 0) {
    const t = (Date.now() - mtimeDaysAgo * 24 * 60 * 60 * 1000) / 1000
    fs.utimesSync(full, t, t)
  }
}

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-ctx-'))
})

afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('getActiveStateBlock', () => {
  it('returns empty string when no active.md exists anywhere', () => {
    expect(getActiveStateBlock({ vaultRoot })).toBe('')
  })

  it('includes personal active.md', () => {
    write('personal/active.md', '---\nworkspace: personal\n---\n\n# Personal\n\nIn progress: foo')
    const block = getActiveStateBlock({ vaultRoot })
    expect(block).toContain('### Personal')
    expect(block).toContain('In progress: foo')
    expect(block).not.toContain('---\nworkspace')
  })

  it('discovers and concatenates workspace active.md files in alpha order', () => {
    write('personal/active.md', '# Personal\n\nP')
    write('workspaces/zebra/active.md', '# Zebra\n\nZ')
    write('workspaces/alpha/active.md', '# Alpha\n\nA')
    const block = getActiveStateBlock({ vaultRoot })
    expect(block.indexOf('### Personal')).toBeLessThan(block.indexOf('### Workspace: alpha'))
    expect(block.indexOf('### Workspace: alpha')).toBeLessThan(block.indexOf('### Workspace: zebra'))
  })

  it('skips workspaces missing an active.md', () => {
    write('personal/active.md', '# P')
    fs.mkdirSync(path.join(vaultRoot, 'workspaces/empty'), { recursive: true })
    const block = getActiveStateBlock({ vaultRoot })
    expect(block).not.toContain('empty')
  })

  it('filters to allowedWorkspaces when provided', () => {
    write('personal/active.md', '# Personal\n\nP')
    write('workspaces/example/active.md', '# Example\n\nA')
    write('workspaces/secret/active.md', '# Secret\n\nS')
    const block = getActiveStateBlock({ vaultRoot, allowedWorkspaces: ['example'] })
    expect(block).toContain('Example')
    expect(block).not.toContain('Secret')
    expect(block).not.toContain('Personal')
  })

  it('includes personal when allowedWorkspaces explicitly lists it', () => {
    write('personal/active.md', '# Personal\n\nP')
    write('workspaces/example/active.md', '# Example\n\nA')
    const block = getActiveStateBlock({ vaultRoot, allowedWorkspaces: ['personal', 'example'] })
    expect(block).toContain('Personal')
    expect(block).toContain('Example')
  })

  it('allowedWorkspaces=null scans everything (admin-equivalent)', () => {
    write('personal/active.md', '# Personal')
    write('workspaces/example/active.md', '# Example')
    write('workspaces/secret/active.md', '# Secret')
    const block = getActiveStateBlock({ vaultRoot, allowedWorkspaces: null })
    expect(block).toContain('Personal')
    expect(block).toContain('Example')
    expect(block).toContain('Secret')
  })

  it('empty allowedWorkspaces yields empty block', () => {
    write('personal/active.md', '# P')
    write('workspaces/example/active.md', '# A')
    expect(getActiveStateBlock({ vaultRoot, allowedWorkspaces: [] })).toBe('')
  })
})

describe('getVaultDeltaBlock', () => {
  it('returns empty when no vault dirs exist', () => {
    expect(getVaultDeltaBlock({ vaultRoot })).toBe('')
  })

  it('includes recent decisions and insights, newest first', () => {
    write('personal/decisions/old.md', '---\ntitle: Old Decision\n---\n\nbody', 2)
    write('personal/decisions/new.md', '---\ntitle: New Decision\n---\n\nbody', 0)
    write('personal/insights/mid.md', '---\ntitle: Mid Insight\n---\n\nbody', 1)
    const block = getVaultDeltaBlock({ vaultRoot })
    const idxNew = block.indexOf('New Decision')
    const idxMid = block.indexOf('Mid Insight')
    const idxOld = block.indexOf('Old Decision')
    expect(idxNew).toBeGreaterThanOrEqual(0)
    expect(idxMid).toBeGreaterThan(idxNew)
    expect(idxOld).toBeGreaterThan(idxMid)
  })

  it('respects sinceDays cutoff', () => {
    write('personal/decisions/recent.md', '# Recent\n\nbody', 5)
    write('personal/decisions/ancient.md', '# Ancient\n\nbody', 30)
    const block = getVaultDeltaBlock({ vaultRoot, vaultDeltaDays: 14 })
    expect(block).toContain('Recent')
    expect(block).not.toContain('Ancient')
  })

  it('caps at vaultDeltaMaxFiles', () => {
    for (let i = 0; i < 10; i++) {
      write(`personal/decisions/d${i}.md`, `# Decision ${i}\n\nbody`, i * 0.1)
    }
    const block = getVaultDeltaBlock({ vaultRoot, vaultDeltaMaxFiles: 3 })
    const matches = block.match(/^### /gm) || []
    expect(matches.length).toBe(3)
  })

  it('truncates each file body to vaultDeltaBytesPerFile', () => {
    const longBody = 'x'.repeat(2000)
    write('personal/decisions/long.md', `# Long\n\n${longBody}`)
    const block = getVaultDeltaBlock({ vaultRoot, vaultDeltaBytesPerFile: 100 })
    expect(block).toContain('xxxx')
    // Body slice happens after frontmatter strip; total block length stays bounded
    expect(block.length).toBeLessThan(500)
  })

  it('falls back to H1 then filename when no frontmatter title', () => {
    write('personal/decisions/with-h1.md', '# H1 Title\n\nbody')
    write('personal/decisions/no-title.md', 'just body, no h1')
    const block = getVaultDeltaBlock({ vaultRoot })
    expect(block).toContain('### H1 Title')
    expect(block).toContain('### no-title')
  })

  it('walks workspace decisions and insights too', () => {
    write('workspaces/example/decisions/d1.md', '# Example Dec\n\nbody')
    write('workspaces/example/insights/i1.md', '# Example Ins\n\nbody')
    const block = getVaultDeltaBlock({ vaultRoot })
    expect(block).toContain('Example Dec')
    expect(block).toContain('Example Ins')
  })

  it('emits relative paths so the mentor can grep further', () => {
    write('personal/decisions/d.md', '# T\n\nbody')
    const block = getVaultDeltaBlock({ vaultRoot })
    expect(block).toContain('_personal/decisions/d.md_')
  })

  it('filters to allowedWorkspaces when provided', () => {
    write('workspaces/example/decisions/a.md', '# Example Dec\n\nbody')
    write('workspaces/secret/decisions/s.md', '# Secret Dec\n\nbody')
    const block = getVaultDeltaBlock({ vaultRoot, allowedWorkspaces: ['example'] })
    expect(block).toContain('Example Dec')
    expect(block).not.toContain('Secret Dec')
  })

  it('excludes personal when allowedWorkspaces omits it', () => {
    write('personal/decisions/p.md', '# Personal Dec\n\nbody')
    write('workspaces/example/decisions/a.md', '# Example Dec\n\nbody')
    const block = getVaultDeltaBlock({ vaultRoot, allowedWorkspaces: ['example'] })
    expect(block).toContain('Example Dec')
    expect(block).not.toContain('Personal Dec')
  })
})

describe('getOpenTasksBlock', () => {
  it('returns empty string when no tasks dirs exist', () => {
    expect(getOpenTasksBlock({ vaultRoot })).toBe('')
  })

  it('returns empty string when no tasks match filter', () => {
    write('personal/tasks/done.md', '---\ntitle: Done Task\nstatus: done\n---\n\nbody')
    expect(getOpenTasksBlock({ vaultRoot })).toBe('')
  })

  it('includes todo and in-progress tasks from personal and workspaces', () => {
    write('personal/tasks/t1.md', '---\ntitle: Personal Task\nstatus: todo\n---\n\nbody')
    write('workspaces/example/tasks/t2.md', '---\ntitle: Example Task\nstatus: in-progress\n---\n\nbody')
    const block = getOpenTasksBlock({ vaultRoot })
    expect(block).toContain('[personal] Personal Task')
    expect(block).toContain('[example] Example Task')
  })

  it('excludes tasks with non-matching statuses', () => {
    write('personal/tasks/blocked.md', '---\ntitle: Blocked\nstatus: blocked\n---\n\nbody')
    write('personal/tasks/done.md', '---\ntitle: Done\nstatus: done\n---\n\nbody')
    write('personal/tasks/active.md', '---\ntitle: Active\nstatus: in-progress\n---\n\nbody')
    const block = getOpenTasksBlock({ vaultRoot })
    expect(block).not.toContain('Blocked')
    expect(block).not.toContain('Done')
    expect(block).toContain('Active')
  })

  it('sorts by due date ascending, undated last', () => {
    write('personal/tasks/undated.md', '---\ntitle: Undated\nstatus: todo\n---\n\nbody')
    write('personal/tasks/later.md', '---\ntitle: Later\nstatus: todo\ndue_date: 2026-06-01\n---\n\nbody')
    write('personal/tasks/sooner.md', '---\ntitle: Sooner\nstatus: todo\ndue_date: 2026-05-01\n---\n\nbody')
    const block = getOpenTasksBlock({ vaultRoot })
    expect(block.indexOf('Sooner')).toBeLessThan(block.indexOf('Later'))
    expect(block.indexOf('Later')).toBeLessThan(block.indexOf('Undated'))
  })

  it('secondary sorts by priority ascending when due dates equal', () => {
    write('personal/tasks/low.md', '---\ntitle: LowPri\nstatus: todo\npriority: 3\n---\n\nbody')
    write('personal/tasks/high.md', '---\ntitle: HighPri\nstatus: todo\npriority: 1\n---\n\nbody')
    const block = getOpenTasksBlock({ vaultRoot })
    expect(block.indexOf('HighPri')).toBeLessThan(block.indexOf('LowPri'))
  })

  it('respects MAX_OPEN_TASKS cap of 50', () => {
    for (let i = 0; i < 60; i++) {
      write(`personal/tasks/t${i}.md`, `---\ntitle: Task ${i}\nstatus: todo\n---\n\nbody`)
    }
    const block = getOpenTasksBlock({ vaultRoot })
    const matches = block.match(/^- \[/gm) || []
    expect(matches.length).toBe(50)
  })

  it('includes file path in output', () => {
    write('personal/tasks/t1.md', '---\ntitle: My Task\nstatus: todo\n---\n\nbody')
    const block = getOpenTasksBlock({ vaultRoot })
    expect(block).toContain('personal/tasks/t1.md')
  })

  it('includes due date and priority in output when present', () => {
    write('personal/tasks/t1.md', '---\ntitle: My Task\nstatus: todo\ndue_date: 2026-05-15\npriority: 2\n---\n\nbody')
    const block = getOpenTasksBlock({ vaultRoot })
    expect(block).toContain('due 2026-05-15')
    expect(block).toContain('priority 2')
  })

  it('filters tasks to allowedWorkspaces when provided', () => {
    write('workspaces/example/tasks/a.md', '---\ntitle: Example Task\nstatus: todo\n---\n\nbody')
    write('workspaces/secret/tasks/s.md', '---\ntitle: Secret Task\nstatus: todo\n---\n\nbody')
    const block = getOpenTasksBlock({ vaultRoot, allowedWorkspaces: ['example'] })
    expect(block).toContain('Example Task')
    expect(block).not.toContain('Secret Task')
  })

  it('excludes personal tasks when allowedWorkspaces omits personal', () => {
    write('personal/tasks/p.md', '---\ntitle: Personal Task\nstatus: todo\n---\n\nbody')
    write('workspaces/example/tasks/a.md', '---\ntitle: Example Task\nstatus: todo\n---\n\nbody')
    const block = getOpenTasksBlock({ vaultRoot, allowedWorkspaces: ['example'] })
    expect(block).toContain('Example Task')
    expect(block).not.toContain('Personal Task')
  })
})

describe('buildSessionContext', () => {
  it('combines active state and vault delta with date header', () => {
    write('personal/active.md', '# P\n\ncurrent state')
    write('personal/decisions/d.md', '# A Decision\n\nbody')
    const block = buildSessionContext({ vaultRoot })
    expect(block).toContain('Persona is loaded from CLAUDE.md')
    expect(block).toContain('Active State')
    expect(block).toContain('current state')
    expect(block).toContain('Recent Decisions & Insights')
    expect(block).toContain('A Decision')
  })

  it('omits empty sections cleanly', () => {
    const block = buildSessionContext({ vaultRoot })
    expect(block).toContain('Persona is loaded from CLAUDE.md')
    expect(block).not.toContain('Active State')
    expect(block).not.toContain('Recent Decisions')
  })

  it('includes Open Tasks section when tasks exist', () => {
    write('personal/active.md', '# P\n\ncurrent state')
    write('personal/tasks/t1.md', '---\ntitle: My Task\nstatus: todo\n---\n\nbody')
    const block = buildSessionContext({ vaultRoot })
    expect(block).toContain('## Open Tasks')
    expect(block).toContain('My Task')
  })

  it('omits Open Tasks section when no tasks match', () => {
    write('personal/active.md', '# P\n\ncurrent state')
    const block = buildSessionContext({ vaultRoot })
    expect(block).not.toContain('Open Tasks')
  })

  it('places Open Tasks between Active State and Recent Decisions', () => {
    write('personal/active.md', '# P\n\nactive')
    write('personal/tasks/t1.md', '---\ntitle: Task A\nstatus: todo\n---\n\nbody')
    write('personal/decisions/d1.md', '# Decision\n\nbody')
    const block = buildSessionContext({ vaultRoot })
    const idxActive = block.indexOf('Active State')
    const idxTasks = block.indexOf('Open Tasks')
    const idxDecisions = block.indexOf('Recent Decisions')
    expect(idxActive).toBeLessThan(idxTasks)
    expect(idxTasks).toBeLessThan(idxDecisions)
  })
})
