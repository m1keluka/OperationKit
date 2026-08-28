// Supabase Storage helper for raw hook-video uploads (objective 891, personal content).
//
// Creds: process.env (compose or boot hydrate from the native secrets store).
// Uploads use SIGNED UPLOAD URLs: the server mints a one-path scoped token (service key never leaves
// the server); the browser PUTs the (possibly multi-GB) file straight to Supabase. Serving uses the
// public bucket URL (stable, shareable — AI video clippers fetch it directly).
import { getSecretValue } from './secrets-store.js'

export const HOOK_VIDEO_BUCKET = 'hook-videos'
export const ALLOWED_VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']
// Per-file cap surfaced to clients (bucket file_size_limit is null; the project's global cap governs server-side).
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB

let cached: { url: string; key: string } | null = null

function fromStore(key: string): string {
  try {
    return getSecretValue({ scopeType: 'global' }, key) || ''
  } catch {
    return ''
  }
}

// Resolve {url, serviceKey}. Prefers process.env; falls back to the native store.
export function getStorageConfig(): { url: string; key: string } {
  if (cached) return cached
  let url = process.env.SUPABASE_URL || fromStore('SUPABASE_URL')
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY || fromStore('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('Supabase storage not configured: missing URL or service key')
  cached = { url: url.replace(/\/+$/, ''), key }
  return cached
}

function headers(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` }
}

// Best-effort idempotent bucket creation. The bucket already exists in prod; this just makes the
// service self-healing if it's ever recreated on a fresh project. Swallows "already exists".
export async function ensureBucket(): Promise<void> {
  const { url, key } = getStorageConfig()
  const res = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...headers(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: HOOK_VIDEO_BUCKET,
      name: HOOK_VIDEO_BUCKET,
      public: true,
      allowed_mime_types: ALLOWED_VIDEO_MIME,
    }),
  })
  if (res.ok) return
  const body = await res.text()
  // 400/409 with a "already exists"/"Duplicate" message is fine.
  if (/exist|duplicate/i.test(body)) return
  throw new Error(`ensureBucket failed: ${res.status} ${body.slice(0, 200)}`)
}

export interface SignedUpload {
  objectPath: string
  putUrl: string // absolute URL the browser PUTs the file to (token embedded)
  publicUrl: string // stable shareable URL once uploaded
}

// Mint a signed upload URL scoped to exactly one object path.
export async function signUpload(objectPath: string): Promise<SignedUpload> {
  const { url, key } = getStorageConfig()
  const res = await fetch(
    `${url}/storage/v1/object/upload/sign/${HOOK_VIDEO_BUCKET}/${encodeURI(objectPath)}`,
    { method: 'POST', headers: { ...headers(key), 'Content-Type': 'application/json' }, body: '{}' },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`signUpload failed: ${res.status} ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { url: string }
  return {
    objectPath,
    putUrl: `${url}/storage/v1${data.url}`,
    publicUrl: publicUrl(objectPath),
  }
}

export function publicUrl(objectPath: string): string {
  const { url } = getStorageConfig()
  return `${url}/storage/v1/object/public/${HOOK_VIDEO_BUCKET}/${encodeURI(objectPath)}`
}

// Delete a stored object (used when removing a recorded video). Idempotent-ish: a missing object
// returns non-2xx, which we surface but the caller still strips the frontmatter entry.
export async function deleteObject(objectPath: string): Promise<boolean> {
  const { url, key } = getStorageConfig()
  const res = await fetch(`${url}/storage/v1/object/${HOOK_VIDEO_BUCKET}/${encodeURI(objectPath)}`, {
    method: 'DELETE',
    headers: headers(key),
  })
  return res.ok
}
