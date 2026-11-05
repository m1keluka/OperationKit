import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  listFiles,
  collisionName,
  moveVaultTree,
  isAccountedFor,
  retireSourceTree,
} from './workspace-vault-move.js'

let root: string
const w = (p: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
  fs.writeFileSync(path.join(root, p), body)
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-vault-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('collisionName', () => {
  it('keeps the extension and the directory', () => {
    expect(collisionName('data/Connections.csv', 'example')).toBe('data/Connections.from-example.csv')
    expect(collisionName('README.md', 'example')).toBe('README.from-example.md')
    expect(collisionName('Makefile', 'example')).toBe('Makefile.from-example')
  })
})

describe('moveVaultTree', () => {
  beforeEach(() => {
    w('src/decisions/a.md', 'alpha')
    w('src/data/linkedin-connections-2026-09-03/Connections.csv', 'id,name\n1,mike\n')
    w('src/shared.md', 'SOURCE version')
    w('src/same.md', 'identical')
    w('dest/shared.md', 'DEST version — newer')
    w('dest/same.md', 'identical')
  })

  it('dry-run reports exactly what apply does, and writes nothing', () => {
    const before = listFiles(path.join(root, 'dest'))
    const plan = moveVaultTree(path.join(root, 'src'), path.join(root, 'dest'), 'example')
    expect(listFiles(path.join(root, 'dest'))).toEqual(before)
    expect(plan.files).toBe(4)
    expect(plan.copied).toBe(2)
    expect(plan.collisions).toEqual([
      { relPath: 'same.md', kind: 'duplicate' },
      { relPath: 'shared.md', kind: 'renamed', landedAs: 'shared.from-example.md' },
    ])
    expect(isAccountedFor(plan)).toBe(true)
  })

  it('apply copies, never overwrites, and lands the differing file beside', () => {
    const plan = moveVaultTree(path.join(root, 'src'), path.join(root, 'dest'), 'example', { apply: true })
    const r = (p: string) => fs.readFileSync(path.join(root, 'dest', p), 'utf8')
    expect(r('decisions/a.md')).toBe('alpha')
    expect(r('data/linkedin-connections-2026-09-03/Connections.csv')).toBe('id,name\n1,mike\n')
    // The destination's own file is untouched...
    expect(r('shared.md')).toBe('DEST version — newer')
    // ...and the source's version is preserved beside it, not lost.
    expect(r('shared.from-example.md')).toBe('SOURCE version')
    // A byte-identical duplicate is not duplicated.
    expect(fs.existsSync(path.join(root, 'dest', 'same.from-example.md'))).toBe(false)
    // Nothing left the source tree.
    expect(listFiles(path.join(root, 'src'))).toHaveLength(4)
    expect(isAccountedFor(plan)).toBe(true)
  })

  it('retires the source by renaming, and only when everything is accounted for', () => {
    const plan = moveVaultTree(path.join(root, 'src'), path.join(root, 'dest'), 'example', { apply: true })
    const target = retireSourceTree(plan, 'example')
    expect(target).toBe(path.join(root, '_archived-example'))
    expect(fs.existsSync(path.join(root, 'src'))).toBe(false)
    // Renamed, not deleted — every byte is still on disk.
    expect(listFiles(target)).toHaveLength(4)
    expect(fs.readFileSync(path.join(target, 'shared.md'), 'utf8')).toBe('SOURCE version')
  })

  it('refuses to retire on an incomplete plan', () => {
    const plan = moveVaultTree(path.join(root, 'src'), path.join(root, 'dest'), 'example', { apply: true })
    expect(() => retireSourceTree({ ...plan, files: plan.files + 1 }, 'example')).toThrow(/refusing to retire/)
    expect(fs.existsSync(path.join(root, 'src'))).toBe(true)
  })

  it('refuses to clobber an existing archive', () => {
    fs.mkdirSync(path.join(root, '_archived-example'))
    const plan = moveVaultTree(path.join(root, 'src'), path.join(root, 'dest'), 'example', { apply: true })
    expect(() => retireSourceTree(plan, 'example')).toThrow(/already exists/)
  })

  it('an absent source tree is an empty plan, not a crash', () => {
    const plan = moveVaultTree(path.join(root, 'nope'), path.join(root, 'dest'), 'example')
    expect(plan.files).toBe(0)
    expect(isAccountedFor(plan)).toBe(true)
  })
})
