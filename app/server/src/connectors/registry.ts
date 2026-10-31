/**
 * Connector registry (obj 720115). Loads every file in `connectors/defs/` once
 * and keeps them in memory. There is no list to edit: a new file in `defs/`
 * that default-exports a ConnectorDefinition is picked up on the next start.
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ConnectorDefinition } from './types.js'

const DEFS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'defs')
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/

let loading: Promise<ConnectorDefinition[]> | null = null

function isDefinition(v: unknown): v is ConnectorDefinition {
  const d = v as ConnectorDefinition | null
  return !!d && typeof d.id === 'string' && ID.test(d.id) && typeof d.name === 'string'
    && typeof d.status === 'function' && typeof d.disconnect === 'function' && !!d.connect
}

async function load(dir: string): Promise<ConnectorDefinition[]> {
  const files = readdirSync(dir)
    .filter(f => /\.(ts|js|mjs)$/.test(f) && !/\.(test|spec)\.|\.d\.ts$/.test(f))
    .sort()
  const seen = new Set<string>()
  const defs: ConnectorDefinition[] = []
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f)).href)
    const def = mod.default
    if (!isDefinition(def)) {
      console.warn(`[connectors] ${f} does not default-export a connector — skipped`)
      continue
    }
    if (seen.has(def.id)) {
      console.warn(`[connectors] duplicate connector id "${def.id}" in ${f} — skipped`)
      continue
    }
    seen.add(def.id)
    defs.push(def)
  }
  return defs.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name))
}

export function listConnectors(): Promise<ConnectorDefinition[]> {
  if (!loading) loading = load(DEFS_DIR)
  return loading
}

export async function getConnector(id: string): Promise<ConnectorDefinition | undefined> {
  return (await listConnectors()).find(d => d.id === id)
}

/** Test seam: load from another directory, or reset to the real one. */
export function __loadConnectorsFrom(dir: string | null): Promise<ConnectorDefinition[]> {
  loading = load(dir ?? DEFS_DIR)
  return loading
}
