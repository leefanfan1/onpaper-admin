/**
 * Site records: which repos the panel may edit, and whether they are healthy.
 */

import type { Hono } from 'hono'
import type { PanelEnv } from '../middleware'
import { audit, requireOwner } from '../middleware'
import {
  createSite,
  deleteSite,
  listSites,
  setSiteEnabled,
  storeSiteToken,
  updateSite,
} from '../sites'
import { getViewer, listTree } from '../lib/github'
import { DEFAULT_PATHS } from '../lib/paths'
import { authOf, handle, readJson, siteOf, targetOf, writeBudget } from './shared'

export function registerSiteRoutes(api: Hono<PanelEnv>): void {
  api.get('/sites', async (c) => {
    const sites = await listSites(c.env)
    return c.json({ sites })
  })

  api.post('/sites', requireOwner, async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const body = await readJson<{
        name: string
        owner: string
        repo: string
        branch?: string
        paths?: Record<string, string>
        patRef?: string
        publicUrl?: string
      }>(c)
      const site = await createSite(c.env, {
        name: body.name,
        owner: body.owner,
        repo: body.repo,
        branch: body.branch ?? 'main',
        paths: body.paths as never,
        patRef: body.patRef ?? '',
        publicUrl: body.publicUrl ?? '',
      })
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'site.create',
        target: `${site.owner}/${site.repo}`,
      })
      return c.json({ site }, 201)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** The default content paths, so the form can show what it is overriding. */
  api.get('/sites/defaults', (c) => c.json({ paths: DEFAULT_PATHS }))

  api.get('/sites/:siteId', async (c) => {
    try {
      const site = await siteOf(c)
      return c.json({ site })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.put('/sites/:siteId', requireOwner, async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const body = await readJson<{
        name: string
        owner: string
        repo: string
        branch?: string
        paths?: Record<string, string>
        patRef?: string
        publicUrl?: string
      }>(c)
      const updated = await updateSite(c.env, site.id, {
        name: body.name,
        owner: body.owner,
        repo: body.repo,
        branch: body.branch ?? site.branch,
        paths: body.paths as never,
        patRef: body.patRef ?? '',
        publicUrl: body.publicUrl ?? '',
      })
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'site.update',
        target: `${site.owner}/${site.repo}`,
      })
      return c.json({ site: updated })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.delete('/sites/:siteId', requireOwner, async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      await deleteSite(c.env, site.id)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'site.delete',
        target: `${site.owner}/${site.repo}`,
      })
      return c.json({ ok: true })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.post('/sites/:siteId/enabled', requireOwner, async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const body = await readJson<{ enabled: boolean }>(c)
      await setSiteEnabled(c.env, site.id, Boolean(body.enabled))
      return c.json({ ok: true })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /**
   * Connection check.
   *
   * Answers three questions a new site raises: can we reach the repo, does the
   * token have the scopes the panel needs, and is this actually an OnPaper
   * site (so the paths in the form mean what they say)?
   */
  api.post('/sites/:siteId/check', async (c) => {
    // Read-only, but it walks the whole repo tree and asks GitHub who the token
    // belongs to — three calls per press. Budgeted so holding the button down
    // cannot spend the hourly quota.
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const target = await targetOf(c, site)
      const tree = await listTree(target)
      const paths = new Set(tree.map(entry => entry.path))

      const has = (path: string) => paths.has(path)
      const structure = {
        config: has(site.paths.config),
        posts: tree.some(entry => entry.path.startsWith(`${site.paths.posts}/`)),
        pages: tree.some(entry => entry.path.startsWith(`${site.paths.pages}/`)),
        shelf: tree.some(entry => entry.path.startsWith(`${site.paths.shelf}/`)),
        public: tree.some(entry => entry.path.startsWith(`${site.paths.public}/`)),
        package: has('package.json'),
        taskWorkflow: has('.github/workflows/admin-task.yml'),
      }

      let viewer: { login: string, name: string } | null = null
      let tokenError = ''
      try {
        viewer = await getViewer(target)
      }
      catch (error) {
        tokenError = error instanceof Error ? error.message : String(error)
      }

      const looksLikeOnPaper = structure.config && structure.posts && structure.package
      return c.json({
        ok: true,
        repo: { owner: site.owner, repo: site.repo, branch: site.branch, files: tree.length },
        token: viewer ? { login: viewer.login, name: viewer.name } : { error: tokenError },
        structure,
        looksLikeOnPaper,
        paths: { ...DEFAULT_PATHS, ...site.paths },
      })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** Store a per-site token, encrypted at rest. */
  api.put('/sites/:siteId/token', requireOwner, async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const body = await readJson<{ token: string }>(c)
      await storeSiteToken(c.env, site.id, body.token ?? '')
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'site.token',
        target: `${site.owner}/${site.repo}`,
      })
      // Never echo the token back.
      return c.json({ ok: true })
    }
    catch (error) {
      return handle(c, error)
    }
  })
}
