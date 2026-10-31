import { answerLlm } from '../doc-ingest/service.js'
import type { LlmCall } from '../doc-ingest/llm.js'

/**
 * The AI the wiki uses (obj 720117) — the same one document ingest uses, so a
 * client install has exactly one AI setting. Only extracted text is sent.
 */
let override: LlmCall | null = null

/** Tests swap the AI for a stub. */
export function setWikiLlmForTests(fn: LlmCall | null): void { override = fn }

export function wikiLlm(): LlmCall { return override ?? answerLlm() }

export type { LlmCall }
