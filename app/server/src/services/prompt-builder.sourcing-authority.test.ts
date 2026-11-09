/**
 * obj 900192 — public-web sourcing is sanctioned work, and the prompts must say so.
 *
 * Regression anchor: card #900184 (Hastings OK commercial cleaning). The worker hit
 * a Cloudflare "verify you are human" interstitial on the Oklahoma Secretary of
 * State's PUBLIC entity search, refused on bot-check-bypass grounds, and refused
 * AGAIN after the owner told it to continue. These tests assert the three prompt
 * surfaces that could re-create that refusal — the worker prompt, the adversarial
 * reviewer, and the planner — now carry the standing rule, and that the real
 * security limits survived the softening.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-sourcing-authority-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

import { initDb } from '../db/index.js'
import { buildPrompt } from './prompt-builder.js'
import { buildPlannerPrompt } from './session-planner-prompt.js'
// Imported from its own module (not the session-manager re-export) so this file
// stays free of the node-pty native dependency.
import { buildReviewerPrompt } from './session-reviewer-prompt.js'
import { SOURCING_AUTHORITY, needsSourcingAuthority } from '../lib/sourcing-authority.js'
import type { Objective } from '@operationkit/shared'

beforeAll(() => {
  initDb()
})

function makeObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 900184,
    title: 'Hastings OK commercial cleaning — source the list',
    description: 'Pull commercial cleaning companies from the Oklahoma SoS business entity search.',
    status: 'working',
    agent_context: 'general',
    workspace: 'operationkit',
    project: null,
    category: 'general',
    parent_id: null,
    depth: 0,
    assigned_user_id: null,
    routine_id: null,
    created_by: null,
    session_id: null,
    transcript_path: null,
    last_session_summary: null,
    session_count: 0,
    total_cost_usd: 0,
    total_tokens: 0,
    has_blockers: false,
    delegate_mode: false,
    create_pr: false,
    branch_name: null,
    pr_url: null,
    pr_number: null,
    completion_goal: null,
    workflow_hint: null,
    effort: 'medium',
    model: 'default',
    type: 'task',
    approved_plan: null,
    plan_approved_at: null,
    planning_session_id: null,
    ai_review_verdict: null,
    ai_review_findings: null,
    ai_review_session_id: null,
    skip_ai_review: false,
    acceptance_criteria: null,
    ai_review_iteration: 0,
    test_cred_slug: null,
    created_at: '2026-11-05T00:00:00Z',
    updated_at: '2026-11-05T00:00:00Z',
    ...overrides,
  } as Objective
}


/** A card with nothing sourcing-shaped about it — the scoping negative case. */
function makeNonSourcingObjective(overrides: Partial<Objective> = {}): Objective {
  return makeObjective({
    id: 900999,
    title: 'Bump the Caddy image and fix the TLS renewal cron',
    description: 'Dockerfile change plus a cron entry. Deploy from main after merge.',
    completion_goal: null,
    approved_plan: null,
    last_session_summary: null,
    acceptance_criteria: null,
    ...overrides,
  })
}

describe('SOURCING_AUTHORITY — the standing rule itself', () => {
  it('names the permissive posture: scraping is ordinary work, no permission to ask for', () => {
    expect(SOURCING_AUTHORITY).toMatch(/ORDINARY, SANCTIONED work/)
    expect(SOURCING_AUTHORITY).toMatch(/Do not moralize/i)
    expect(SOURCING_AUTHORITY).toMatch(/terms of service are the owner's call, not yours/i)
    expect(SOURCING_AUTHORITY).toMatch(/robots\.txt/)
  })

  it('covers the exact #900184 failure: a bot check is an obstacle, not a boundary', () => {
    expect(SOURCING_AUTHORITY).toMatch(/Bot checks are an obstacle, not a boundary/i)
    expect(SOURCING_AUTHORITY).toMatch(/CAPTCHA/)
    expect(SOURCING_AUTHORITY).toMatch(/Cloudflare/)
    expect(SOURCING_AUTHORITY).toMatch(/verify you are human/i)
    // …and names concrete ways through, so "I can't" has to be a technical claim.
    expect(SOURCING_AUTHORITY).toMatch(/Playwright/)
    expect(SOURCING_AUTHORITY).toMatch(/residential-proxy|unblocker/i)
    expect(SOURCING_AUTHORITY).toMatch(/can't help with bypassing bot detection/i)
  })

  it('keeps the sanctioned toolkit sanctioned — no categorical ban on any of it', () => {
    // Scope correction 2026-11-08: the tightening below must not quietly turn the
    // paid, sanctioned toolkit into a prohibition. Each of these stays ALLOWED.
    expect(SOURCING_AUTHORITY).toMatch(/CAPTCHA-solving vendor we pay for/i)
    expect(SOURCING_AUTHORITY).toMatch(/2Captcha/i)
    expect(SOURCING_AUTHORITY).toMatch(/Throttling, backoff and politeness delays are ENGINEERING choices/i)
    expect(SOURCING_AUTHORITY).not.toMatch(/never use (?:a )?(?:proxy|proxies|captcha)/i)
    expect(SOURCING_AUTHORITY).not.toMatch(/do not solve (?:a )?CAPTCHA/i)
  })

  it('forbids re-refusing after the owner has overruled (the #900184 second refusal)', () => {
    expect(SOURCING_AUTHORITY).toMatch(/Never refuse the same thing twice/i)
    expect(SOURCING_AUTHORITY).toMatch(/the owner said continue/i)
  })

  it('does NOT license defeating a paywall, login or subscription', () => {
    // Scope correction 2026-11-08: "soft paywall" was in the obstacles-to-bypass
    // list. Gated content is reachable only through an account or vendor the
    // owner actually holds, so the bypass framing is gone and the limit is explicit.
    expect(SOURCING_AUTHORITY).not.toMatch(/soft paywall/i)
    expect(SOURCING_AUTHORITY).toMatch(/Public page vs\. gated content/i)
    expect(SOURCING_AUTHORITY).toMatch(/behind a paywall, a login or a subscription is NOT in that set/i)
    expect(SOURCING_AUTHORITY).toMatch(/Do not try to defeat the paywall or the login itself/i)
  })

  it('KEEPS the real security limits — this is not a blanket "anything goes"', () => {
    expect(SOURCING_AUTHORITY).toMatch(/Still off-limits/i)
    expect(SOURCING_AUTHORITY).toMatch(/credentials/i)
    expect(SOURCING_AUTHORITY).toMatch(/Breaking into non-public systems/i)
    expect(SOURCING_AUTHORITY).toMatch(/denial of service/i)
    expect(SOURCING_AUTHORITY).toMatch(/malware/i)
    expect(SOURCING_AUTHORITY).toMatch(/Impersonating a real person/i)
  })

  it('adds private-data-behind-authorization and missing-approval to those limits', () => {
    expect(SOURCING_AUTHORITY).toMatch(/Personal or private data that sits behind an authorization boundary/i)
    expect(SOURCING_AUTHORITY).toMatch(/private profile, a permissioned dataset/i)
    expect(SOURCING_AUTHORITY).toMatch(/needs an approval you have not been given/i)
    expect(SOURCING_AUTHORITY).toMatch(/A missing approval is a blocker to raise once/i)
  })
})

describe('needsSourcingAuthority — the injection trigger', () => {
  it('fires on sourcing / scraping / research / enrichment work', () => {
    expect(needsSourcingAuthority({ title: 'Scrape the OK SoS entity search' })).toBe(true)
    expect(needsSourcingAuthority({ title: 'Source 500 commercial cleaning leads' })).toBe(true)
    expect(needsSourcingAuthority({ title: 'Enrich the Hastings list with emails' })).toBe(true)
    expect(needsSourcingAuthority({ title: 'Research competitor pricing' })).toBe(true)
    expect(needsSourcingAuthority({ title: 'Crawl the chamber of commerce directory' })).toBe(true)
    expect(needsSourcingAuthority({ description: 'Pull it with Apify and dedupe.' })).toBe(true)
  })

  it('fires when the card has hit a site obstacle (the owner-says-continue path)', () => {
    expect(needsSourcingAuthority({
      title: 'Hastings OK commercial cleaning',
      last_session_summary: 'Blocked by a Cloudflare "verify you are human" page.',
    })).toBe(true)
    expect(needsSourcingAuthority({ description: 'The site shows a CAPTCHA after 20 requests.' })).toBe(true)
    expect(needsSourcingAuthority({ description: 'robots.txt disallows /search.' })).toBe(true)
  })

  it('reads the goal, plan and acceptance criteria too, not just the title', () => {
    expect(needsSourcingAuthority({ completion_goal: 'A CSV of scraped permits.' })).toBe(true)
    expect(needsSourcingAuthority({ approved_plan: 'Step 1: crawl the registry.' })).toBe(true)
    expect(needsSourcingAuthority({
      acceptance_criteria: [{ id: 'c1', criterion: 'The enrichment run covers 90% of rows', type: 'data', method: 'api' }],
    })).toBe(true)
  })

  it('does NOT fire on an ordinary infra / code card', () => {
    expect(needsSourcingAuthority({
      title: 'Bump the Caddy image and fix the TLS renewal cron',
      description: 'Dockerfile change plus a cron entry. Deploy from main after merge.',
    })).toBe(false)
    expect(needsSourcingAuthority({ title: 'Fix the WebSocket reconnect loop' })).toBe(false)
    expect(needsSourcingAuthority({})).toBe(false)
  })
})

describe('buildPrompt — the rule is injected on sourcing cards only', () => {
  it('injects it on a sourcing card (plain task, no project, no PR)', () => {
    const prompt = buildPrompt(makeObjective())
    expect(prompt).toContain('## Public-web sourcing')
    expect(prompt).toContain(SOURCING_AUTHORITY)
  })

  it('injects it for a sourcing delegator session too', () => {
    expect(buildPrompt(makeObjective({ delegate_mode: true }))).toContain(SOURCING_AUTHORITY)
  })

  it('injects it for a sourcing PR/project session too', () => {
    const prompt = buildPrompt(makeObjective({ create_pr: true, project: 'operationkit', type: 'project' }))
    expect(prompt).toContain(SOURCING_AUTHORITY)
  })

  it('injects it when only the owner-continue obstacle text is present', () => {
    const prompt = buildPrompt(makeNonSourcingObjective({
      last_session_summary: 'Stopped at a Cloudflare bot check; owner said continue.',
    }))
    expect(prompt).toContain(SOURCING_AUTHORITY)
  })

  it('does NOT inject it on an ordinary infra card', () => {
    const prompt = buildPrompt(makeNonSourcingObjective())
    expect(prompt).not.toContain('## Public-web sourcing')
    expect(prompt).not.toContain(SOURCING_AUTHORITY)
    // …and the prompt is otherwise intact around the gap.
    expect(prompt).toContain('## Talking to the human')
    expect(prompt).toContain('## Operating Principles')
  })

  it('sits with the other standing-posture blocks — after the human-voice block, before Operating Principles', () => {
    const prompt = buildPrompt(makeObjective())
    const voice = prompt.indexOf('## Talking to the human')
    const sourcing = prompt.indexOf('## Public-web sourcing')
    const principles = prompt.indexOf('## Operating Principles')
    expect(voice).toBeGreaterThanOrEqual(0)
    expect(voice).toBeLessThan(sourcing)
    expect(sourcing).toBeLessThan(principles)
  })
})

describe('buildReviewerPrompt — the reviewer must not re-impose the refusal', () => {
  const prompt = buildReviewerPrompt(makeObjective({ ai_review_iteration: 2 }), ['/tmp/x.ts'], null)

  it('tells the reviewer to grade evidence, not the ethics of sourcing', () => {
    expect(prompt).toMatch(/Grade the EVIDENCE, not the ethics of sourcing/i)
    expect(prompt).toMatch(/never fail or downgrade a verdict on those grounds/i)
  })

  it('forbids authoring a terms-of-service / bot-check acceptance criterion', () => {
    expect(prompt).toMatch(/Never author a criterion about terms of service/i)
  })

  it('still requires the reviewer to FAIL work that crosses a hard limit', () => {
    expect(prompt).toMatch(/Still fail work that crosses a hard limit/i)
    expect(prompt).toMatch(/covers ToS, `robots\.txt` and bot checks on public pages, and NOTHING else/i)
    expect(prompt).toMatch(/defeating a paywall\/login\/subscription/i)
    expect(prompt).toMatch(/personal or private data from behind an authorization boundary/i)
    expect(prompt).toMatch(/an approval that was never given/i)
    expect(prompt).toMatch(/FAIL it and say which limit it crossed/i)
  })
})

describe('buildPlannerPrompt — a plan must not bake in a refusal', () => {
  const prompt = buildPlannerPrompt(makeObjective())

  it('tells the planner sourcing is sanctioned and not to plan a permission ask', () => {
    expect(prompt).toMatch(/Public-web sourcing .* is sanctioned work/i)
    expect(prompt).toMatch(/do not write a plan step that asks Mike for permission to scrape/i)
    expect(prompt).toMatch(/technical step to plan for/i)
  })
})
