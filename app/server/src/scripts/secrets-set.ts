#!/usr/bin/env tsx
/**
 * Upsert one global secret. For host ops after Doppler.
 *
 *   docker exec command-center tsx /app/server/src/scripts/secrets-set.ts KEY_NAME
 *   # value on stdin (so it never lands on argv)
 */
import { initDb } from '../db/index.js'
import { setSecret } from '../services/secrets-store.js'
import fs from 'fs'

const key = process.argv[2]?.trim()
if (!key) {
  console.error('usage: secrets-set KEY  (value on stdin)')
  process.exit(2)
}

const value = fs.readFileSync(0, 'utf8').replace(/\n$/, '')
if (!value) {
  console.error('secrets-set: empty stdin')
  process.exit(2)
}

initDb()
setSecret({ scope: { scopeType: 'global' }, key, value, actorUserId: null })
console.error(`ok ${key}`)
