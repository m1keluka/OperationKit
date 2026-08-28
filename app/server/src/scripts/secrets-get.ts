#!/usr/bin/env tsx
/**
 * Print one global secret to stdout. For host cron / docker exec after Doppler.
 *
 *   docker exec command-center tsx /app/server/src/scripts/secrets-get.ts GRANOLA_API_KEY
 *
 * Never logs the value. Exit 1 if missing. Does not print a trailing newline
 * so callers can use the output as a token.
 */
import { initDb } from '../db/index.js'
import { getSecretValue } from '../services/secrets-store.js'

const key = process.argv[2]?.trim()
if (!key) {
  console.error('usage: secrets-get KEY')
  process.exit(2)
}

initDb()
const value = getSecretValue({ scopeType: 'global' }, key)
if (value == null || value === '') process.exit(1)
process.stdout.write(value)
