import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { generateTempPassword, TEMP_PASSWORD_ALPHABET, TEMP_PASSWORD_LENGTH } from './tempPassword'

describe('generateTempPassword', () => {
  it('draws from the Web Crypto CSPRNG, never Math.random', () => {
    const csprng = vi.spyOn(globalThis.crypto, 'getRandomValues')
    const weak = vi.spyOn(Math, 'random')
    const pwd = generateTempPassword()
    expect(csprng).toHaveBeenCalled()
    expect(weak).not.toHaveBeenCalled()
    expect(pwd).toHaveLength(TEMP_PASSWORD_LENGTH)
    expect([...pwd].every(c => TEMP_PASSWORD_ALPHABET.includes(c))).toBe(true)
    csprng.mockRestore()
    weak.mockRestore()
  })

  it('rejects biased bytes instead of folding them with modulo', () => {
    // 56-char alphabet → bytes >= 224 must be skipped. Feed 255s first, then 0s.
    let call = 0
    const fake = (a: Uint8Array) => { a.fill(call++ === 0 ? 255 : 0); return a }
    expect(generateTempPassword(4, fake)).toBe('AAAA')
    expect(call).toBe(2)
  })

  it('does not repeat across calls', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTempPassword()))
    expect(seen.size).toBe(200)
  })

  it('UsersTab uses the CSPRNG helper and no Math.random (source scan)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../components/config/UsersTab.tsx'), 'utf8')
    expect(src).not.toMatch(/Math\.random/)
    expect(src).toMatch(/from '\.\.\/\.\.\/lib\/tempPassword'/)
  })
})
