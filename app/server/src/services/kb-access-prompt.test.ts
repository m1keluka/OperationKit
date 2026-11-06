/**
 * obj 900204 — the spawn prompt must name a path/interface the session can
 * actually reach. The regression this guards: in `docker` isolation the prompt
 * said "Knowledge base is at ~/second-brain/", a directory that does not exist
 * inside the jail, so cards reported files missing that were plainly in the KB
 * and MANDATORY vault capture failed silently.
 */
import { describe, it, expect } from 'vitest'
import { buildKbAccessBlock, buildVaultCaptureBlock, vaultDecisionsPath, CC_API } from './kb-access-prompt.js'

const obj = { id: 900204, workspace: 'example' } as const

describe('buildKbAccessBlock', () => {
  it('tmux mode is byte-identical to the historical line', () => {
    expect(buildKbAccessBlock(obj, false)).toEqual(['', 'Knowledge base is at ~/second-brain/ for reference.'])
  })

  it('jailed mode never points at a path the jail does not have', () => {
    const text = buildKbAccessBlock(obj, true).join('\n')
    // The vault is never offered as a PATH to use. (It is named once, as the
    // thing that is absent — that warning is the point, not a pointer.)
    expect(text).not.toMatch(/~\/second-brain\//)
    expect(text).not.toMatch(/\/home\/mike\/\w/)
    // ...and says so out loud, so the session does not go hunting.
    expect(text).toMatch(/There is no `~\/second-brain`/)
  })

  it('jailed mode gives the reachable interface, the token, and the workspace', () => {
    const text = buildKbAccessBlock(obj, true).join('\n')
    expect(text).toContain(`${CC_API}/api/files/search`)
    expect(text).toContain(`${CC_API}/api/files/download`)
    expect(text).toContain(`${CC_API}/api/docs/search`)
    expect(text).toContain('$CC_SESSION_TOKEN')
    expect(text).toContain('`example`')
  })

  it('teaches the 403-vs-404 distinction so a card never reports "not in the KB" on a 403', () => {
    const text = buildKbAccessBlock(obj, true).join('\n')
    expect(text).toMatch(/\*\*404\*\*/)
    expect(text).toMatch(/\*\*403\*\*/)
    expect(text).toMatch(/Never report "not in the knowledge base" on a 403/)
  })
})

describe('buildVaultCaptureBlock', () => {
  it('tmux mode keeps the workspace-aware vault path', () => {
    const text = buildVaultCaptureBlock(obj, false).join('\n')
    expect(text).toContain('~/second-brain/workspaces/example/decisions/YYYY-MM-DD-<slug>.md')
    expect(vaultDecisionsPath('example')).toBe('~/second-brain/workspaces/example/decisions/')
    expect(vaultDecisionsPath('personal')).toBe('~/second-brain/personal/decisions/')
    expect(vaultDecisionsPath(null)).toBe('~/second-brain/personal/decisions/')
  })

  it('jailed mode writes through the API instead of an absent path', () => {
    const text = buildVaultCaptureBlock(obj, true).join('\n')
    expect(text).not.toMatch(/~\/second-brain\//)
    expect(text).not.toMatch(/write a decision doc to ~/)
    expect(text).toContain(`PUT "${CC_API}/api/docs/file"`)
    expect(text).toContain('create_dirs:true')
  })

  it('both modes keep the MANDATORY framing and the escape clause', () => {
    for (const jailed of [false, true]) {
      const text = buildVaultCaptureBlock(obj, jailed).join('\n')
      expect(text).toContain('## Vault Capture (MANDATORY before you finish)')
      expect(text).toContain('"No vault capture: <one-line reason>"')
    }
  })
})
