/**
 * Users, audit log, overview, and the optional Cloudflare integration.
 */

import type { Hono } from 'hono'
import type { PanelEnv } from '../middleware'
import { audit, requireOwner } from '../middleware'
import { listCommits } from '../lib/github'
import { listSites } from '../sites'
import { TASK_KINDS } from '../tasks'
import { cacheKey } from '../lib/cache'
import { authOf, handle, limitParam, readJson, siteOf, targetOf, writeBudget } from './shared'
import { storeOf } from '../store'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function registerAdminRoutes(api: Hono<PanelEnv>): void {
  // --- Overview ----------------------------------------------------------

  /**
   * One call for the header strip: sites, open tasks, last commit.
   *
   * The UI polls this rather than each page, so "3 个站点 · 1 个任务进行中"
   * stays true across views without a request per widget.
   */
  api.get('/overview', async (c) => {
    try {
      const sites = await listSites(c.env)
      const store = storeOf(c.env)
      const tasks = await store.all<{ status: string, created_at: string }>('tasks')
      const openCount = tasks.filter(task => ['queued', 'in_progress'].includes(task.status)).length
      const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
      const failedCount = tasks.filter(task =>
        ['failure', 'unknown'].includes(task.status) && Date.parse(task.created_at) > weekAgo,
      ).length

      const lastRuns = await Promise.all(sites.slice(0, 5).map(async (site) => {
        try {
          const store = storeOf(c.env)
          const rows = (await store.filter<{ status: string, kind: string, created_at: string, site_id: number }>(
            'tasks',
            task => task.site_id === site.id,
          )).sort((a, b) => b.created_at.localeCompare(a.created_at))
          return { siteId: site.id, name: site.name, lastTask: rows[0] ?? null }
        }
        catch {
          return { siteId: site.id, name: site.name, lastTask: null }
        }
      }))

      return c.json({
        sites: sites.map(site => ({
          id: site.id,
          name: site.name,
          repo: `${site.owner}/${site.repo}`,
          branch: site.branch,
          enabled: site.enabled,
        })),
        tasks: { open: openCount, recentFailures: failedCount },
        lastRuns,
        kinds: Object.keys(TASK_KINDS),
      })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  // --- Users -------------------------------------------------------------

  api.get('/users', async (c) => {
    const rows = await storeOf(c.env).all<{
      email: string, role: string, created_at: string, last_seen: string | null
    }>('users')
    rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    return c.json({ users: rows, me: authOf(c).user })
  })

  api.post('/users', requireOwner, async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const body = await readJson<{ email: string, role?: 'owner' | 'editor' }>(c)
      const email = String(body.email ?? '').trim().toLowerCase()
      if (!EMAIL_RE.test(email)) return c.json({ error: '邮箱格式不对', code: 'EMAIL' }, 400)
      const role = body.role === 'owner' ? 'owner' : 'editor'
      const store = storeOf(c.env)
      const existing = await store.get<{ email: string, role: string, created_at: string }>('users', email)
      await store.put('users', email, {
        email,
        role,
        created_at: existing?.created_at ?? new Date().toISOString(),
        last_seen: null,
      })
      await audit(c.env, {
        siteId: 0,
        email: authOf(c).user.email,
        action: 'user.upsert',
        target: email,
        detail: { role },
      })
      return c.json({ ok: true }, 201)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.delete('/users/:email', requireOwner, async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const me = authOf(c).user
      const email = decodeURIComponent(c.req.param('email')).toLowerCase()
      if (email === me.email) {
        return c.json({ error: '不能删除自己', code: 'SELF' }, 400)
      }
      const store = storeOf(c.env)
      const users = await store.all<{ email: string, role: string }>('users')
      const target = users.find(user => user.email === email)
      const owners = users.filter(user => user.role === 'owner').length
      if (target?.role === 'owner' && owners <= 1) {
        return c.json({ error: '至少要留一个 owner', code: 'LAST_OWNER' }, 400)
      }
      await store.delete('users', email)
      const tokens = await store.filter<{ token: string, email: string }>(
        'csrf_tokens', row => row.email === email,
      )
      for (const token of tokens) await store.delete('csrf_tokens', token.token)
      await audit(c.env, {
        siteId: 0,
        email: me.email,
        action: 'user.delete',
        target: email,
      })
      return c.json({ ok: true })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  // --- Audit -------------------------------------------------------------

  api.get('/audit', async (c) => {
    try {
      const siteId = c.req.query('site')
      const limit = limitParam(c, 50, 200)
      const store = storeOf(c.env)
      const all = await store.all<{ id: number, site_id: number }>('audit_log')
      const rows = siteId ? all.filter(row => row.site_id === Number(siteId)) : all
      rows.sort((a, b) => b.id - a.id)
      return c.json({ entries: rows.slice(0, limit) })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  // --- Commit history ----------------------------------------------------

  api.get('/sites/:siteId/commits', async (c) => {
    try {
      const site = await siteOf(c)
      const readCacheKey = cacheKey(site.id, site.branch, 'commits')
      const hit = await c.env.CACHE.get(readCacheKey, 'json').catch(() => null)
      if (hit) return c.json(hit as Record<string, unknown>)

      const target = await targetOf(c, site)
      const commits = await listCommits(target, undefined, limitParam(c, 30, 100))
      // Commits are append-only: a two-minute cache cannot show the wrong
      // thing, only a slightly old list.
      await c.env.CACHE.put(readCacheKey, JSON.stringify({ commits }), { expirationTtl: 120 }).catch(() => {})
      return c.json({ commits })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  // --- Optional: view counts, Pages status -------------------------------

  /**
   * View counts, when a Cloudflare API token is configured.
   *
   * The site's own Function reads a KV key `views:<slug>`; this exposes the
   * same values for the panel, read-only apart from reset. Without the token
   * the endpoint says so rather than pretending there is nothing to show.
   */
  api.get('/views', async (c) => {
    const env = c.env
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
      return c.json({ configured: false, reason: '没有配置 CF_API_TOKEN / CF_ACCOUNT_ID' })
    }
    try {
      const namespaceName = c.req.query('namespace') ?? 'onpaper-views'
      const list = await cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces`)
      const namespaces = list as Array<{ id: string, title: string }>
      const found = namespaces.find(item => item.title === namespaceName)
      if (!found) {
        return c.json({ configured: true, namespace: namespaceName, error: '找不到这个 KV 命名空间' })
      }
      const keys = await cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${found.id}/keys?prefix=views:&limit=200`)
      const entries = Array.isArray(keys) ? keys as Array<{ name: string }> : []
      const values = await Promise.all(entries.slice(0, 100).map(async (entry) => {
        const value = await cloudflare(
          env,
          `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${found.id}/values/${encodeURIComponent(entry.name)}`,
          { raw: true },
        )
        return { slug: entry.name.replace(/^views:/, ''), views: Number.parseInt(String(value), 10) || 0 }
      }))
      values.sort((a, b) => b.views - a.views)
      return c.json({ configured: true, namespace: namespaceName, entries: values })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.post('/views/reset', requireOwner, async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    const env = c.env
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
      return c.json({ error: '没有配置 CF_API_TOKEN / CF_ACCOUNT_ID', code: 'NOT_CONFIGURED' }, 400)
    }
    try {
      const body = await readJson<{ namespace?: string, slug: string }>(c)
      const namespaceName = body.namespace ?? 'onpaper-views'
      const list = await cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces`)
      const found = (list as Array<{ id: string, title: string }>).find(item => item.title === namespaceName)
      if (!found) return c.json({ error: '找不到这个 KV 命名空间', code: 'NAMESPACE' }, 404)
      if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(body.slug ?? '')) {
        return c.json({ error: 'slug 不合法', code: 'SLUG' }, 400)
      }
      await cloudflare(
        env,
        `/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${found.id}/values/views%3A${body.slug}`,
        { method: 'DELETE' },
      )
      await audit(env, {
        siteId: 0,
        email: authOf(c).user.email,
        action: 'views.reset',
        target: body.slug,
      })
      return c.json({ ok: true })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** Deployment status, when a token with Pages read is configured. */
  api.get('/deployments', async (c) => {
    const env = c.env
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
      return c.json({ configured: false, reason: '没有配置 CF_API_TOKEN / CF_ACCOUNT_ID' })
    }
    try {
      const project = c.req.query('project') ?? ''
      if (!project) return c.json({ error: '缺少 project 参数', code: 'PROJECT' }, 400)
      const deployments = await cloudflare(
        env,
        `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${encodeURIComponent(project)}/deployments?per_page=10`,
      ) as { result?: Array<{ id: string, url: string, created_on: string, latest_stage: { name: string, status: string } }> }
      return c.json({
        configured: true,
        deployments: (deployments.result ?? []).map(item => ({
          id: item.id,
          url: item.url,
          createdAt: item.created_on,
          stage: item.latest_stage?.name ?? '',
          status: item.latest_stage?.status ?? '',
        })),
      })
    }
    catch (error) {
      return handle(c, error)
    }
  })
}

/** Call the Cloudflare API. Errors are translated, never echoed raw. */
async function cloudflare(
  env: PanelEnv['Bindings'],
  path: string,
  options: { method?: string, raw?: boolean } = {},
): Promise<unknown> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`Cloudflare API 返回 ${response.status}`)
  }
  if (options.raw) return await response.text()
  const body = await response.json() as { success: boolean, result: unknown, errors?: Array<{ message: string }> }
  if (!body.success) {
    throw new Error(body.errors?.[0]?.message ?? 'Cloudflare API 调用失败')
  }
  return body.result
}
