import { describe, it, expect } from 'vitest'
import {
  isBlockedPreviewHost,
  parsePreviewUrl,
  baseHrefFor,
  rewriteDesignHtml,
  stripPreviewScripts,
} from './design-frame.js'

describe('parsePreviewUrl', () => {
  it('accepts https public hosts', () => {
    expect(parsePreviewUrl('https://site-2026.vercel.app/process')?.hostname).toBe('site-2026.vercel.app')
  })
  it('rejects private and local hosts', () => {
    expect(parsePreviewUrl('https://127.0.0.1/')).toBeNull()
    expect(parsePreviewUrl('http://localhost:3000/')).toBeNull()
    expect(parsePreviewUrl('http://192.168.1.9/x')).toBeNull()
    expect(parsePreviewUrl('http://10.0.0.4/')).toBeNull()
  })
  it('rejects non-http schemes', () => {
    expect(parsePreviewUrl('file:///etc/passwd')).toBeNull()
    expect(parsePreviewUrl('javascript:alert(1)')).toBeNull()
  })
})

describe('isBlockedPreviewHost', () => {
  it('blocks link-local and loopback', () => {
    expect(isBlockedPreviewHost('169.254.1.1')).toBe(true)
    expect(isBlockedPreviewHost('localhost')).toBe(true)
  })
  it('allows public names', () => {
    expect(isBlockedPreviewHost('example.com')).toBe(false)
  })
})

describe('rewriteDesignHtml', () => {
  it('injects base href, strips CSP, and installs the bridge', () => {
    const html = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
      <title>x</title></head><body><h1>Hi</h1></body></html>`
    const out = rewriteDesignHtml(html, {
      sourceUrl: 'https://preview.example/app/page',
      parentOrigin: 'https://cc.example.com',
    })
    expect(out).toContain('<base href="https://preview.example/app/">')
    expect(out).not.toContain('Content-Security-Policy')
    expect(out).toContain('data-cc-design-bridge')
    expect(out).toContain('https://cc.example.com')
    expect(out).toContain('cc-design-pick')
  })
  it('strips the preview\'s own JS so Next cannot hydrate the proxy URL', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/_next/static/css/app.css">
      <link rel="preload" as="script" href="/_next/static/chunks/main.js">
      <link rel="modulepreload" href="/_next/static/chunks/app.js">
      <script src="/_next/static/chunks/main.js"></script>
      <script>self.__next_f.push([1,"boom"])</script>
      </head><body><h1>Skip the middleman</h1></body></html>`
    const out = rewriteDesignHtml(html, {
      sourceUrl: 'https://ws-landing-preview.vercel.app/',
      parentOrigin: 'https://cc.example.com',
    })
    expect(out).toContain('/_next/static/css/app.css')
    expect(out).toContain('Skip the middleman')
    expect(out).not.toContain('/_next/static/chunks/main.js')
    expect(out).not.toContain('__next_f')
    expect(out).not.toContain('modulepreload')
    expect(out).toContain('data-cc-design-bridge')
    expect((out.match(/<script/gi) || []).length).toBe(1)
  })
  it('still injects when head/body tags are missing', () => {
    const out = rewriteDesignHtml('<p>loose</p>', {
      sourceUrl: 'https://ex.com/x',
      parentOrigin: 'https://cc.example.com',
    })
    expect(out).toContain('<base href=')
    expect(out).toContain('data-cc-design-bridge')
  })
})

describe('stripPreviewScripts', () => {
  it('removes script tags and script preloads, keeps CSS', () => {
    const out = stripPreviewScripts(
      '<link rel="stylesheet" href="/a.css"><script src="/a.js"></script><link as="script" rel="preload" href="/b.js">',
    )
    expect(out).toContain('/a.css')
    expect(out).not.toContain('/a.js')
    expect(out).not.toContain('/b.js')
  })
})

describe('baseHrefFor', () => {
  it('keeps directory of the source URL', () => {
    expect(baseHrefFor('https://ex.com/a/b/c.html')).toBe('https://ex.com/a/b/')
    expect(baseHrefFor('https://ex.com/a/b/')).toBe('https://ex.com/a/b/')
  })
})
