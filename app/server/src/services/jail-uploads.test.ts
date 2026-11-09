import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  JAIL_UPLOADS_PATH,
  buildAttachedFilesBlock,
  listObjectiveUploads,
  rewriteUploadPaths,
  stageUploadsIntoJail,
} from './jail-uploads.js'

// A real 1x1 PNG so the "screenshot" is a screenshot, not a stand-in string.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

let tmp: string
let uploads: string
let jailHome: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-uploads-'))
  uploads = path.join(tmp, 'uploads')
  jailHome = path.join(tmp, 'home')
  fs.mkdirSync(path.join(uploads, '42'), { recursive: true })
  fs.mkdirSync(path.join(uploads, '7'), { recursive: true })
  fs.mkdirSync(jailHome, { recursive: true })
  fs.writeFileSync(path.join(uploads, '42', '1700000000000-screenshot.png'), PNG)
  fs.writeFileSync(path.join(uploads, '7', '1700000000000-other-card.png'), PNG)
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('jail-uploads (obj 900408)', () => {
  it('stages the card\'s own screenshot into the jail HOME, byte-identical', () => {
    expect(stageUploadsIntoJail(42, jailHome, uploads)).toBe(1)
    const staged = path.join(jailHome, 'uploads', '1700000000000-screenshot.png')
    expect(fs.readFileSync(staged).equals(PNG)).toBe(true)
  })

  it('never stages another card\'s uploads', () => {
    stageUploadsIntoJail(42, jailHome, uploads)
    expect(fs.existsSync(path.join(jailHome, 'uploads', '1700000000000-other-card.png'))).toBe(false)
  })

  it('skips symlinks so an upload dir cannot smuggle a host file into the jail', () => {
    fs.symlinkSync('/etc/passwd', path.join(uploads, '42', 'evil.png'))
    expect(listObjectiveUploads(42, uploads).map(f => f.name)).toEqual(['1700000000000-screenshot.png'])
    stageUploadsIntoJail(42, jailHome, uploads)
    expect(fs.existsSync(path.join(jailHome, 'uploads', 'evil.png'))).toBe(false)
  })

  it('is a no-op for a card with no uploads, or a non-numeric id', () => {
    expect(stageUploadsIntoJail(999, jailHome, uploads)).toBe(0)
    expect(stageUploadsIntoJail('../42', jailHome, uploads)).toBe(0)
    expect(fs.existsSync(path.join(jailHome, 'uploads'))).toBe(false)
  })

  it('rewrites this card\'s follow-up attachment paths to the in-jail copies, and only this card\'s', () => {
    const msg = [
      'look at this',
      '',
      'Attached files (accessible on disk):',
      `- ${uploads}/42/1700000000000-screenshot.png`,
      `- ${uploads}/7/1700000000000-other-card.png`,
      `- ${uploads}/420/x.png`,
    ].join('\n')
    const out = rewriteUploadPaths(msg, 42, uploads)
    expect(out).toContain(`- ${JAIL_UPLOADS_PATH}/1700000000000-screenshot.png`)
    expect(out).not.toContain(`${uploads}/42/`)
    expect(out).toContain(`- ${uploads}/7/1700000000000-other-card.png`)
    expect(out).toContain(`- ${uploads}/420/x.png`)
  })

  it('lists files attached at card creation in the prompt, and adds nothing when there are none', () => {
    const block = buildAttachedFilesBlock(42, uploads).join('\n')
    expect(block).toContain('## Files attached to this card')
    expect(block).toContain(`${uploads}/42/1700000000000-screenshot.png`)
    expect(block).not.toContain('other-card')
    expect(buildAttachedFilesBlock(999, uploads)).toEqual([])
  })

  it('end to end: the path the jailed agent is told about is the file that exists in its HOME', () => {
    stageUploadsIntoJail(42, jailHome, uploads)
    const prompt = rewriteUploadPaths(buildAttachedFilesBlock(42, uploads).join('\n'), 42, uploads)
    const guestPath = prompt.split('\n').find(l => l.startsWith('- '))!.slice(2)
    expect(guestPath.startsWith(`${JAIL_UPLOADS_PATH}/`)).toBe(true)
    const hostPath = path.join(jailHome, guestPath.slice('/home/jailuser/'.length))
    expect(fs.readFileSync(hostPath).equals(PNG)).toBe(true)
  })
})
