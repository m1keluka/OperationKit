/**
 * obj 718944 — naming + redaction of owner-pasted secrets (pure detector).
 */
import { describe, it, expect } from 'vitest'
import { detectPastedSecrets } from './chat-secret-capture.js'

// Built at runtime so the OSS publish gate's gitleaks scan has no literal to flag.
const APIFY = ['apify', 'api', 'Q7xK2mN9pL4vR8sT1wY6zB3c'].join('_')
const pending = (name: string) => [{ name, reason: 'r', requested_at: 't' }]

describe('detectPastedSecrets', () => {
  it('NAME=value is stored under that NAME and redacted', () => {
    const r = detectPastedSecrets(`Here you go: APIFY_API_TOKEN=${APIFY} — go ahead`)
    expect(r.found).toEqual([{ name: 'APIFY_API_TOKEN', value: APIFY, how: 'named' }])
    expect(r.text).toBe('Here you go: APIFY_API_TOKEN=[REDACTED:APIFY_API_TOKEN] — go ahead')
  })

  it('"NAME: value" and "NAME is value" also work', () => {
    expect(detectPastedSecrets(`APIFY_API_TOKEN: ${APIFY}`).found[0].name).toBe('APIFY_API_TOKEN')
    expect(detectPastedSecrets(`the APIFY_API_TOKEN is ${APIFY}`).found[0].name).toBe('APIFY_API_TOKEN')
  })

  it('a bare token goes to the ONE secret the card is waiting on', () => {
    const r = detectPastedSecrets(`use this ${APIFY} thanks`, pending('APIFY_API_TOKEN'))
    expect(r.found).toEqual([{ name: 'APIFY_API_TOKEN', value: APIFY, how: 'pending' }])
    expect(r.text).toBe('use this [REDACTED:APIFY_API_TOKEN] thanks')
  })

  it('a bare token is never guessed when the card is not waiting on exactly one secret', () => {
    expect(detectPastedSecrets(`use this ${APIFY}`).found).toEqual([])
    expect(detectPastedSecrets(`use this ${APIFY}`, [...pending('A_KEY'), ...pending('B_KEY')]).found).toEqual([])
  })

  it('vendor shapes get their conventional name, or the pending name', () => {
    const gh = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    expect(detectPastedSecrets(`token ${gh}`).found[0]).toMatchObject({ name: 'GITHUB_TOKEN', how: 'shape' })
    expect(detectPastedSecrets(`token ${gh}`, pending('GH_DEPLOY_TOKEN')).found[0].name).toBe('GH_DEPLOY_TOKEN')
  })

  it('ignores git SHAs, placeholders, env refs and non-secret names', () => {
    const sha = '3c5bec0a9d1e2f3b4c5d6e7f8091a2b3c4d5e6f7'
    expect(detectPastedSecrets(`see commit ${sha}`, pending('APIFY_API_TOKEN')).found).toEqual([])
    expect(detectPastedSecrets('APIFY_API_TOKEN=$APIFY_API_TOKEN').found).toEqual([])
    expect(detectPastedSecrets('APIFY_API_TOKEN={{secret:APIFY_API_TOKEN}}').found).toEqual([])
    expect(detectPastedSecrets('MAX_ROWS=12345678 PROJECT_NAME=long-trail-c3').found).toEqual([])
  })

  it('the same value pasted twice is captured once and redacted everywhere', () => {
    const r = detectPastedSecrets(`APIFY_API_TOKEN=${APIFY} (again: ${APIFY})`, pending('APIFY_API_TOKEN'))
    expect(r.found).toHaveLength(1)
    expect(r.text).not.toContain(APIFY)
  })
})
