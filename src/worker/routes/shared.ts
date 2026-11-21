/**
 * Shared route helpers: resolving the site, running a GitHub call, and the
 * write-budget guard.
 */

import type { Context } from 'hono'
import type { PanelEnv } from '../middleware'
import { errorResponse, rateLimit, type AuthContext } from '../middleware'
import { getSite, SiteError, tokenFor, type Site } from '../sites'
import type { RepoTarget } from '../lib/github'

export type PanelContext = Context<PanelEnv>

export function authOf(c: PanelContext): AuthContext {
  return c.get('auth')
}

/** The site named by `:siteId`, or a 404. */
export async function siteOf(c: PanelContext): Promise<Site> {
  const raw = c.req.param('siteId')
  const id = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(id) || id <= 0) throw new SiteError('SITE_NOT_FOUND', '站点编号不合法')
  return await getSite(c.env, id)
}

export function targetFor(site: Site, token: string): RepoTarget {
  return { owner: site.owner, repo: site.repo, branch: site.branch, token }
}

export async function targetOf(c: PanelContext, site: Site): Promise<RepoTarget> {
  return targetFor(site, await tokenFor(c.env, site))
}

/**
 * A per-user budget for requests that cost GitHub calls.
 *
 * Named for writes because that is what it mostly guards, but it also covers
 * the read-shaped POSTs (the connection check, the save preview) that reach
 * GitHub on every press. The point is the same in all cases: one session must
 * not be able to exhaust the token's hourly quota, whether by a runaway client
 * or by someone holding a button down.
 */
export async function writeBudget(c: PanelContext, cost = 1): Promise<Response | null> {
  const auth = authOf(c)
  const result = await rateLimit(c.env, {
    key: `write:${auth.user.email}`,
    limit: 120,
    windowSeconds: 60,
  })
  if (!result.ok) {
    return c.json({ error: '操作太频繁，请稍后再试', code: 'RATE_LIMIT' }, 429)
  }
  void cost
  return null
}

export function handle(c: PanelContext, error: unknown): Response {
  return errorResponse(c, error)
}

/** Parse and validate a JSON body, with a size cap. */
export async function readJson<T>(c: PanelContext, maxBytes = 2_000_000): Promise<T> {
  const length = Number(c.req.header('Content-Length') ?? '0')
  if (length > maxBytes) {
    throw new SiteError('BODY_TOO_LARGE', '提交的内容过大')
  }
  try {
    return await c.req.json<T>()
  }
  catch {
    throw new SiteError('BODY_JSON', '请求体不是合法的 JSON')
  }
}

/** `?limit=` parsing with a sane ceiling. */
export function limitParam(c: PanelContext, fallback = 50, max = 200): number {
  const raw = c.req.query('limit')
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(value, max)
}
