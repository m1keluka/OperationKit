// Minimal Backblaze B2 b2_authorize_account mock for install/test/b2-setup-test.sh.
// Fake sample keys only. Records each request's Authorization header outcome
// (never the header itself) so the test can prove the key arrived intact.
import http from 'node:http'
const port = Number(process.env.PORT || 0)
const KEYS = {
  // keyId: { key, caps, bucket }
  '000000000000000000000001a': { key: 'fakekeyfakekeyfakekeyfakekey11', bucket: 'ok-test-bucket', caps: ['listBuckets', 'readBuckets', 'listFiles', 'readFiles', 'shareFiles', 'writeFiles', 'deleteFiles'] },
  '000000000000000000000002a': { key: 'fakekeyfakekeyfakekeyfakekey22', bucket: 'ok-test-bucket', caps: ['listBuckets', 'listFiles', 'readFiles', 'writeFiles'] },
}
const seen = []
http.createServer((req, res) => {
  if (req.url === '/__state') { res.end(JSON.stringify(seen)); return }
  if (req.url !== '/b2api/v2/b2_authorize_account') { res.writeHead(404); res.end('{}'); return }
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '')
  const [id, ...rest] = m ? Buffer.from(m[1], 'base64').toString().split(':') : ['']
  const k = KEYS[id]
  const ok = !!k && rest.join(':') === k.key
  seen.push({ id, ok })
  if (!ok) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"status":401,"code":"unauthorized"}'); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    accountId: 'fakeaccount', authorizationToken: 'MOCK-SESSION-TOKEN-NEVER-PRINT',
    apiUrl: 'https://api004.backblazeb2.com', s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
    allowed: { bucketId: 'b1', bucketName: k.bucket, capabilities: k.caps, namePrefix: null },
  }))
}).listen(port, '127.0.0.1')
