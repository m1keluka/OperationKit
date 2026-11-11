import { describe, it, expect } from 'vitest'
import { extractJsonArrayTag } from './state-poller.js'

// PR-gated harness loop: the reviewer (test-agent) emits machine-readable
// <criteria_results>/<screenshot_paths>/<artifact_paths> blocks. The poller parses
// them with extractJsonArrayTag, which must NEVER throw and always yield a JSON
// array string ('[]' on any malformed/absent input).
describe('extractJsonArrayTag — test-agent structured output parsing', () => {
  it('parses a well-formed <criteria_results> JSON array and re-serializes it', () => {
    const crit = [
      { id: 'login', criterion: 'User can log in', status: 'pass', severity: 'critical', repro: 'r', expected: 'e', actual: 'a' },
      { id: 'create', criterion: 'Create objective', status: 'fail', severity: 'major', repro: 'r2', expected: 'e2', actual: 'a2' },
    ]
    const transcript = `blah\n<criteria_results>${JSON.stringify(crit)}</criteria_results>\nmore`
    const out = extractJsonArrayTag(transcript, 'criteria_results')
    expect(JSON.parse(out)).toEqual(crit)
  })

  it('returns "[]" when the tag is absent', () => {
    expect(extractJsonArrayTag('no tags here', 'criteria_results')).toBe('[]')
  })

  it('returns "[]" on malformed JSON inside the tag (never throws)', () => {
    const transcript = '<criteria_results>{not valid json,,,</criteria_results>'
    expect(extractJsonArrayTag(transcript, 'criteria_results')).toBe('[]')
  })

  it('returns "[]" when the tag body is a JSON object, not an array', () => {
    const transcript = '<screenshot_paths>{"a":1}</screenshot_paths>'
    expect(extractJsonArrayTag(transcript, 'screenshot_paths')).toBe('[]')
  })

  it('parses screenshot/artifact path arrays', () => {
    const transcript = '<screenshot_paths>["/tmp/a.png","/tmp/b.png"]</screenshot_paths>'
    expect(JSON.parse(extractJsonArrayTag(transcript, 'screenshot_paths'))).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })
})
