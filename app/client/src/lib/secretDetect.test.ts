import { describe, it, expect } from 'vitest'
import { detectSecrets, redactValue, toSecretName } from './secretDetect'

describe('detectSecrets (obj 719065)', () => {
  it('NAME=value uses the given name', () => {
    expect(detectSecrets('here you go APIFY_API_TOKEN=apify_api_Zx81kQ2mNv7Lp0Rt5Ws3')).toEqual([
      { value: 'apify_api_Zx81kQ2mNv7Lp0Rt5Ws3', suggestedName: 'APIFY_API_TOKEN' },
    ])
  })

  it('vendor shapes get a conventional name, or the single pending request', () => {
    const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx1234'
    expect(detectSecrets(`use ${key}`)[0]).toEqual({ value: key, suggestedName: 'ANTHROPIC_API_KEY' })
    expect(detectSecrets(`use ${key}`, ['CLAUDE_KEY'])[0].suggestedName).toBe('CLAUDE_KEY')
  })

  it('a single bare token is offered; unnamed unless exactly one request is pending', () => {
    const t = 'Q2hhbmdlTWUxMjM0NTY3ODkwYWJjZGVmZ2hpams'
    expect(detectSecrets(`token: ${t}`)).toEqual([{ value: t, suggestedName: '' }])
    expect(detectSecrets(t, ['APIFY_API_TOKEN'])).toEqual([{ value: t, suggestedName: 'APIFY_API_TOKEN' }])
  })

  it('ignores normal chat, SHAs, slugs, env references and already-redacted text', () => {
    expect(detectSecrets('please rebase onto main and rerun the tests')).toEqual([])
    expect(detectSecrets('commit 3f9a1c2b7d4e5f60718293a4b5c6d7e8f9012345 looks good')).toEqual([])
    expect(detectSecrets('branch cc/obj-719065-cc-improvement-add-secrets-from-chat-in')).toEqual([])
    expect(detectSecrets('use API_KEY=$APIFY_API_TOKEN')).toEqual([])
    expect(detectSecrets('saved as [REDACTED:APIFY_API_TOKEN]')).toEqual([])
  })

  it('redactValue replaces every occurrence; toSecretName normalises', () => {
    expect(redactValue('a XYZ b XYZ', 'XYZ', 'K')).toBe('a [REDACTED:K] b [REDACTED:K]')
    expect(toSecretName('apify api-token')).toBe('APIFY_API_TOKEN')
  })
})
