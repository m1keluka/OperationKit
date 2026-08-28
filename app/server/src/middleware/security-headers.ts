/**
 * Baseline HTTP security headers. Caddy sets the same values at the edge;
 * Express sets them too so localhost / preview / a mis-copied Caddyfile still
 * ship a respectable default.
 *
 * CSP is deliberately boring: this is a first-party SPA (hashed Vite scripts,
 * inline critical CSS in index.html, mermaid/xterm on the same origin).
 * 'unsafe-inline' on style-src is required for the app-shell skeleton and
 * React/Mantine style props. Scripts stay 'self' only.
 *
 * frame-src allows the design canvas to embed a live preview (Vercel etc.)
 * instead of proxying HTML. The design-frame proxy remains for older clients;
 * keep DESIGN_FRAME_CSP in sync with the `@design_frame` block in
 * config/caddy/Caddyfile.
 */
import type { Request, Response, NextFunction } from 'express'

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: https:",
  "worker-src 'self' blob:",
  "frame-src 'self' https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

export const DESIGN_FRAME_PATH = /^\/api\/objectives\/\d+\/design-frame$/

/** CSP for GET /api/objectives/:id/design-frame. Keep in sync with Caddyfile. */
export const DESIGN_FRAME_CSP = [
  "default-src 'self' https: data: blob:",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "connect-src https:",
  "frame-ancestors 'self'",
  "base-uri https: 'self'",
  "object-src 'none'",
].join('; ')

export function isDesignFramePath(pathname: string): boolean {
  return DESIGN_FRAME_PATH.test(pathname)
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (isDesignFramePath(req.path)) {
    // Framed by this origin; X-Frame-Options DENY would blank the canvas.
    res.setHeader('Content-Security-Policy', DESIGN_FRAME_CSP)
  } else {
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  }
  next()
}
