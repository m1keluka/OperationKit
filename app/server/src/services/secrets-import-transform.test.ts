import { describe, it, expect } from 'vitest'
// obj-2353 / W3 — unit test for the PURE transform in the Doppler importer.
// The script itself is a .mjs (run via node/tsx); we import only its exported
// pure function, which never carries values and never touches Doppler/the DB.
import { dopplerJsonToImportList } from '../../../../scripts/secrets-import-from-doppler.mjs'

describe('dopplerJsonToImportList', () => {
  it('maps a doppler --json map to a sorted key-only import list', () => {
    const json = {
      OPENAI_API_KEY: { computed: 'sk-secret', raw: 'sk-secret' },
      ANTHROPIC_API_KEY: { computed: 'ant-secret', raw: 'ant-secret' },
    }
    expect(dopplerJsonToImportList(json)).toEqual([
      { key: 'ANTHROPIC_API_KEY' },
      { key: 'OPENAI_API_KEY' },
    ])
  })

  it('excludes Doppler pseudo/metadata vars (DOPPLER_*)', () => {
    const json = {
      REAL_KEY: { computed: 'v' },
      DOPPLER_CONFIG: { computed: 'prd' },
      DOPPLER_ENVIRONMENT: { computed: 'prd' },
      DOPPLER_PROJECT: { computed: 'example' },
    }
    expect(dopplerJsonToImportList(json)).toEqual([{ key: 'REAL_KEY' }])
  })

  it('carries no values out (key-only, safe to log)', () => {
    const json = { K: { computed: 'super-secret-value' } }
    const list = dopplerJsonToImportList(json)
    expect(JSON.stringify(list)).not.toContain('super-secret-value')
  })

  it('returns [] for empty / non-object input', () => {
    expect(dopplerJsonToImportList(null)).toEqual([])
    expect(dopplerJsonToImportList(undefined)).toEqual([])
    expect(dopplerJsonToImportList({})).toEqual([])
  })
})
