/**
 * The Worker entry point.
 *
 * The Worker sees every request: `/api/*` is handed to the Hono app, and
 * everything else is served from the static asset bundle. Routing assets
 * through here is deliberate — the security headers (CSP, `frame-ancestors`)
 * are set below, and an asset served straight from the edge would ship without
 * them.
 */

import { Hono } from 'hono'
import { createApi } from './api'
import type { Env } from './env'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // The Hono app declares routes without the `/api` prefix (`/health`,
      // `/sites/...`), so the prefix is stripped here and re-added by the mount
      // below. Doing it in one place keeps the route table readable.
      const api = createApi()
      const mounted = new Hono<{ Bindings: Env }>()
      mounted.route('/api', api)
      return await mounted.fetch(request, env, ctx)
    }

    // Everything else is a static asset; the SPA fallback is configured in
    // wrangler.jsonc so a deep link to /posts/foo loads the shell.
    const asset = await env.ASSETS.fetch(request)
    return hardenAssetResponse(asset)
  },
} satisfies ExportedHandler<Env>

/**
 * Add the headers the static asset layer cannot express.
 *
 * The panel renders user content (a post preview, a config value) and holds an
 * Access session, so it gets a stricter policy than the public site: no inline
 * script, no external origins at all, and no framing.
 */
function hardenAssetResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      // The panel's own code only. An inline script would mean an XSS in the
      // panel has somewhere to run; this removes that place.
      "script-src 'self'",
      "script-src-attr 'none'",
      // CodeMirror injects its styles at runtime, which is the one allowance
      // the editor needs.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'none'",
      "worker-src 'self'",
      "manifest-src 'self'",
      'upgrade-insecure-requests',
    ].join('; '),
  )
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
