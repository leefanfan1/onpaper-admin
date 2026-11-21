/**
 * The panel's HTTP API.
 *
 * Route modules stay thin: they parse, authorise, call a lib, and audit. All
 * the safety plumbing (identity, CSRF, rate limits, error translation) is
 * middleware, so a handler cannot forget it.
 */

import { Hono } from 'hono'
import type { PanelEnv } from './middleware'
import { audit, authenticate, errorResponse, rateLimit, requireCsrf } from './middleware'
import { registerSiteRoutes } from './routes/sites'
import { registerPostRoutes } from './routes/posts'
import { registerPageRoutes } from './routes/pages'
import { registerShelfRoutes } from './routes/shelf'
import { registerConfigRoutes } from './routes/config'
import { registerMediaRoutes } from './routes/media'
import { registerTaskRoutes } from './routes/tasks'
import { registerAdminRoutes } from './routes/admin'
import { registerMarkdownRoutes } from './routes/markdown'
import { registerWarmRoutes } from './routes/warm'
import { SiteError } from './sites'
import { TaskError } from './tasks'

export function createApi(): Hono<PanelEnv> {
  const api = new Hono<PanelEnv>()

  // Every API response is private and must not be cached by anything between
  // Cloudflare and the browser: it carries someone's content and identity.
  api.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store, max-age=0')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
  })

  api.use('*', authenticate)
  api.use('*', requireCsrf)

  api.get('/health', async (c) => {
    const env = c.env
    const accessOk = Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.PANEL_HOSTNAME)
    return c.json({
      ok: true,
      access: {
        required: env.REQUIRE_ACCESS !== 'false',
        configured: accessOk,
      },
      github: { configured: Boolean(env.GITHUB_PAT) },
      user: c.get('auth').user,
      csrf: c.get('auth').csrfToken,
    })
  })

  registerSiteRoutes(api)
  registerPostRoutes(api)
  registerPageRoutes(api)
  registerShelfRoutes(api)
  registerConfigRoutes(api)
  registerMediaRoutes(api)
  registerTaskRoutes(api)
  registerMarkdownRoutes(api)
  registerAdminRoutes(api)
  registerWarmRoutes(api)

  api.notFound((c) => c.json({ error: '接口不存在', code: 'NOT_FOUND' }, 404))

  api.onError((error, c) => {
    if (error instanceof SiteError || error instanceof TaskError) {
      return c.json({ error: error.message, code: error.code }, error.code === 'SITE_NOT_FOUND' ? 404 : 400)
    }
    return errorResponse(c, error)
  })

  return api
}

/** Shared helper: a per-user write budget, so one stolen session cannot burn the GitHub quota. */
export async function guardWrite(c: Parameters<typeof errorResponse>[0] & { env: PanelEnv['Bindings'], get: (key: 'auth') => { user: { email: string } } }): Promise<Response | null> {
  const auth = c.get('auth')
  const result = await rateLimit(c.env, {
    key: `write:${auth.user.email}`,
    limit: 120,
    windowSeconds: 60,
  })
  if (!result.ok) {
    return errorResponse(c, new Error('too many writes'))
  }
  return null
}
