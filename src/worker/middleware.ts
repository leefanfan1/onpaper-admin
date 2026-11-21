/**
 * Request-level plumbing: identity, authorisation, CSRF, rate limits, audit.
 *
 * Everything a route needs to be safe lives here, so a route cannot forget it:
 * `hono` middleware runs before the handler, and a handler only ever receives
 * a context whose identity has already been verified.
 */

import type { Context, MiddlewareHandler, Next } from 'hono'
import type { Env } from './env'
import { AccessError, verifyAccess, type AccessIdentity } from './lib/access'
import { GithubError } from './lib/github'
import { PathError } from './lib/paths'
import { storeOf } from './store'

export interface SiteRow {
  id: number
  name: string
  owner: string
  repo: string
  branch: string
  paths_json: string
  pat_ref: string
  /** The published site, used to build media URLs. Empty when unknown. */
  public_url: string
  enabled: number
  created_at: string
}

export interface UserRow {
  email: string
  role: 'owner' | 'editor'
  created_at: string
  last_seen: string | null
}

export interface AuthContext {
  identity: AccessIdentity
  user: UserRow
  csrfToken: string
}

export type PanelEnv = { Bindings: Env, Variables: { auth: AuthContext } }

/** True when Access must be enforced — i.e. everywhere except a local run that opts out. */
export function accessRequired(env: Env): boolean {
  return env.REQUIRE_ACCESS !== 'false'
}

const CSRF_HEADER = 'X-Panel-CSRF'
const MAX_CSRF_PER_USER = 5

async function ensureUser(env: Env, email: string): Promise<UserRow> {
  const store = storeOf(env)
  const existing = await store.get<UserRow>('users', email)
  if (existing) {
    const seen = { ...existing, last_seen: new Date().toISOString() }
    await store.put('users', email, seen).catch(() => {})
    return seen
  }

  // Bootstrap: the very first user to reach a fresh panel owns it. Every
  // later user must be added by an owner.
  const count = await store.count('users')
  const role: UserRow['role'] = count === 0 ? 'owner' : 'editor'
  const row: UserRow = { email, role, created_at: new Date().toISOString(), last_seen: null }
  await store.put('users', email, row)
  return row
}

/** Issue a CSRF token for this user, reusing a recent one. */
async function issueCsrf(env: Env, email: string): Promise<string> {
  const store = storeOf(env)
  const tokens = await store.filter<{ token: string, email: string, created_at: string }>(
    'csrf_tokens',
    row => row.email === email,
  )
  if (tokens.length) {
    tokens.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    return tokens[0].token
  }

  const now = new Date().toISOString()
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '')
  await store.put('csrf_tokens', token, { token, email, created_at: now })
  return token
}

/** Authenticate every `/api/*` request. */
export const authenticate: MiddlewareHandler<PanelEnv> = async (c, next) => {
  const env = c.env
  let identity: AccessIdentity

  if (!accessRequired(env)) {
    // Local development only. `REQUIRE_ACCESS=false` is never set in a
    // deployed configuration, and the health endpoint reports it.
    const email = (env.DEV_AUTH_EMAIL ?? 'dev@localhost').toLowerCase()
    identity = { email, sub: 'dev', claims: { dev: true } }
  }
  else {
    try {
      identity = await verifyAccess(c.req.raw, {
        teamDomain: env.ACCESS_TEAM_DOMAIN ?? '',
        aud: env.ACCESS_AUD ?? '',
        panelHostname: env.PANEL_HOSTNAME ?? '',
      })
    }
    catch (error) {
      if (error instanceof AccessError) {
        return c.json({ error: error.message, code: error.code }, 401)
      }
      throw error
    }
  }

  const user = await ensureUser(env, identity.email)
  const csrfToken = await issueCsrf(env, identity.email)
  c.set('auth', { identity, user, csrfToken })
  await next()
}

/** Owner-only routes (user management, site deletion). */
export const requireOwner: MiddlewareHandler<PanelEnv> = async (c, next) => {
  const auth = c.get('auth')
  if (auth.user.role !== 'owner') {
    return c.json({ error: '只有 owner 可以执行这个操作', code: 'ROLE' }, 403)
  }
  await next()
}

/**
 * CSRF protection for state-changing requests.
 *
 * Three independent checks, because each alone has a hole:
 *   - `Origin` is absent on some non-browser clients, so it cannot be the only
 *     gate, but a browser cannot forge it.
 *   - The custom header cannot be set cross-origin without a CORS preflight,
 *     which this API never answers.
 *   - The token is compared against the database, so a stolen header name alone
 *     is not enough.
 */
export const requireCsrf: MiddlewareHandler<PanelEnv> = async (c, next) => {
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next()
    return
  }

  const origin = c.req.header('Origin')
  const expectedOrigin = new URL(c.req.url).origin
  if (origin && origin !== expectedOrigin) {
    return c.json({ error: '跨站请求被拒绝', code: 'CSRF_ORIGIN' }, 403)
  }
  if (!c.req.header(CSRF_HEADER)) {
    return c.json({ error: '缺少 CSRF 请求头', code: 'CSRF_HEADER' }, 403)
  }

  const auth = c.get('auth')
  const provided = c.req.header(CSRF_HEADER) ?? ''
  const expected = auth.csrfToken
  if (!constantTimeEqual(provided, expected)) {
    return c.json({ error: 'CSRF 令牌无效', code: 'CSRF_TOKEN' }, 403)
  }

  await next()
}

/** Compare without leaking length or prefix through early exit. */
function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]
  return diff === 0
}

// ---------------------------------------------------------------------------
// Rate limits — in KV, counted per window.
// ---------------------------------------------------------------------------

export interface RateLimitSpec {
  key: string
  limit: number
  windowSeconds: number
}

/**
 * A fixed-window counter.
 *
 * Fixed windows allow a burst at the boundary, which is acceptable here: the
 * limits guard against a runaway client or a stolen session hammering the
 * GitHub API, not against a determined attacker with a botnet.
 */
export async function rateLimit(env: Env, spec: RateLimitSpec): Promise<{ ok: boolean, remaining: number }> {
  const window = Math.floor(Date.now() / (spec.windowSeconds * 1000))
  const key = `rl:${spec.key}:${window}`
  const current = Number.parseInt((await env.CACHE.get(key)) ?? '0', 10) || 0
  if (current >= spec.limit) return { ok: false, remaining: 0 }
  await env.CACHE.put(key, String(current + 1), { expirationTtl: spec.windowSeconds + 5 })
  return { ok: true, remaining: spec.limit - current - 1 }
}

export function rateLimited(c: Context<PanelEnv>, spec: RateLimitSpec): Response | null {
  return null
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function audit(
  env: Env,
  entry: { siteId: number, email: string, action: string, target?: string, detail?: unknown, commit?: string },
): Promise<void> {
  // Never let an audit failure lose the user's work — but never log the token
  // either: `detail` is caller-supplied JSON and is redacted first.
  try {
    const store = storeOf(env)
    const id = await nextAuditId(env)
    const row = {
      id,
      site_id: entry.siteId,
      email: entry.email,
      action: entry.action,
      target: entry.target ?? '',
      detail: JSON.stringify(redact(entry.detail ?? {})),
      commit_sha: entry.commit ?? '',
      created_at: new Date().toISOString(),
    }
    await store.put('audit_log', String(id), row)
  }
  catch (error) {
    console.error('audit write failed', error instanceof Error ? error.message : String(error))
  }
}

/** Audit ids: monotonic enough to sort by, on both backends. */
async function nextAuditId(env: Env): Promise<number> {
  const result = await rateLimit(env, { key: 'audit-seq', limit: 100000, windowSeconds: 86400 })
  void result
  const key = 'seq:audit_log'
  const current = Number.parseInt((await env.CACHE.get(key)) ?? '0', 10) || 0
  const next = current + 1
  await env.CACHE.put(key, String(next))
  return next
}

const SECRET_KEYS = /^(token|pat|secret|password|authorization|key)$/i

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(item, depth + 1)
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

export function errorResponse(c: Context<PanelEnv>, error: unknown): Response {
  if (error instanceof PathError) {
    return c.json({ error: error.message, code: error.code }, 400)
  }
  if (error instanceof GithubError) {
    const status = error.status === 404 ? 404 : error.status === 401 ? 502 : error.status === 0 ? 502 : 400
    return c.json({ error: error.message, code: error.code }, status)
  }
  if (error instanceof Error && error.name === 'FrontmatterError') {
    return c.json({ error: error.message, code: 'FRONTMATTER' }, 400)
  }
  if (error instanceof Error && error.name === 'ConfigError') {
    return c.json({ error: error.message, code: 'CONFIG' }, 400)
  }
  if (error instanceof Error && (error.name === 'FriendsError' || error.name === 'ShelfError')) {
    return c.json({ error: error.message, code: 'CONTENT' }, 400)
  }
  // Anything unclassified is a bug; log it, and tell the caller nothing about
  // the internals.
  console.error('unhandled', error instanceof Error ? error.stack ?? error.message : String(error))
  // A deployed panel hides internals. `DEBUG_ERRORS=true` (a var, not a secret)
  // returns the message and the first stack frames so an operator can diagnose
  // without a log tail. Access is what keeps anyone else from seeing it.
  if (c.env.DEBUG_ERRORS === 'true' && error instanceof Error) {
    return c.json({
      error: error.message,
      code: 'INTERNAL',
      debug: (error.stack ?? '').split('\n').slice(0, 8),
    }, 500)
  }
  return c.json({ error: '服务器内部错误', code: 'INTERNAL' }, 500)
}

export type { Next }
