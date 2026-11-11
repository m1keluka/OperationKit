import { describe, it, expect } from 'vitest'
import { extractGrokDeviceAuth, grokLoginSucceeded } from './grok-device-auth.js'

describe('extractGrokDeviceAuth', () => {
  it('pulls URL + user code from a typical device-auth pane', () => {
    const pane = `
Opening device login...
Visit https://auth.x.ai/device
and enter code: ABCD-1234
Waiting for authorization...
`
    expect(extractGrokDeviceAuth(pane)).toEqual({
      url: 'https://auth.x.ai/device',
      userCode: 'ABCD-1234',
    })
  })

  it('reads user_code from the URL query when present', () => {
    const pane = 'Open https://auth.x.ai/device?user_code=Wxyz-9999 to continue'
    expect(extractGrokDeviceAuth(pane)).toEqual({
      url: 'https://auth.x.ai/device?user_code=Wxyz-9999',
      userCode: 'WXYZ-9999',
    })
  })

  it('strips ANSI and trailing punctuation from the URL', () => {
    const pane = '\x1b[32mhttps://grok.com/device.\x1b[0m\nCode: QWER-TYUI'
    expect(extractGrokDeviceAuth(pane)).toEqual({
      url: 'https://grok.com/device',
      userCode: 'QWER-TYUI',
    })
  })

  it('parses the live grok 1.0.5 device pane (accounts.x.ai oauth2)', () => {
    const pane = `
To sign in, open this URL in your browser:

  https://accounts.x.ai/oauth2/device?user_code=YSR6-8TJD

  (Could not open browser automatically — open the URL above manually.)

Confirm this code in your browser:

  YSR6-8TJD

Waiting for authorization...
`
    expect(extractGrokDeviceAuth(pane)).toEqual({
      url: 'https://accounts.x.ai/oauth2/device?user_code=YSR6-8TJD',
      userCode: 'YSR6-8TJD',
    })
  })

  it('returns null when the pane has no URL yet', () => {
    expect(extractGrokDeviceAuth('Starting grok login...')).toBeNull()
  })
})

describe('grokLoginSucceeded', () => {
  it('detects a finished login', () => {
    expect(grokLoginSucceeded('Login successful. You are now logged in.')).toBe(true)
    expect(grokLoginSucceeded('Waiting for authorization...')).toBe(false)
  })
})
