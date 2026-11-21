/**
 * Fill the read cache for a site, once, before the person clicks.
 *
 * The panel opens on the post list, and the person clicks a tab a second
 * later. Loading a screen costs a GitHub round trip, and from a phone that is
 * one to three seconds of a skeleton. The Worker has the same GitHub latency
 * but a far better connection to it and can run every screen at once, so the
 * panel asks once here and every tab is already answered when it is opened.
 *
 * **This does not re-implement any screen.** Each path below is dispatched as
 * an ordinary request back into the same Hono app, so the route that answers it
 * is the route the panel calls — with its own validation, its own cache key and
 * its own idea of what the payload is. A second copy of that logic living in
 * this file is exactly how the cache-key mismatch that served stale shelves got
 * in; there is one implementation, and this is a caller of it.
 *
 * Nothing here is required for correctness: a screen that fails to warm is
 * reported and simply loads the normal way when opened.
 */

import type { Hono } from 'hono'
import type { PanelEnv } from '../middleware'
import { cacheKey } from '../lib/cache'
import { handle, siteOf, writeBudget } from './shared'

/**
 * The screens worth warming, and the cache entry each one writes.
 *
 * `name` is the key the route itself uses; it is passed through to
 * `cacheKey()` rather than spelled out, so this file cannot invent a format of
 * its own. The post list is deliberately absent: it uses its own older key
 * shape (`index:posts:`), and it is the screen the panel opens on, so it is
 * already warm by the time this runs.
 */
const SCREENS: Array<{ path: string, name: string }> = [
  { path: 'pages', name: 'pages' },
  { path: 'pages/about', name: 'page-about' },
  { path: 'shelf', name: 'shelf' },
  { path: 'config', name: 'config' },
  { path: 'commits', name: 'commits' },
  { path: 'media/images', name: 'media-images' },
]

export function registerWarmRoutes(api: Hono<PanelEnv>): void {
  /**
   * POST /sites/:id/warm — dispatch every screen's GET at once.
   *
   * Answers with what was warmed and what failed, so the panel can report it
   * (and so a persistent failure stays visible instead of looking like a slow
   * screen forever).
   */
  api.post('/sites/:siteId/warm', async (c) => {
    /*
     * Budgeted, like the reads it performs: one call is six screen loads and a
     * dozen GitHub requests. Without a budget, a client that retried on failure
     * would spend the token's hourly quota warming caches nobody opened.
     */
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const url = new URL(c.req.url)
      const headers = new Headers(c.req.raw.headers)
      // The sub-requests are same-origin by construction; saying so keeps the
      // CSRF middleware's Origin check honest if it ever runs on a GET.
      headers.set('Origin', url.origin)

      const results = await Promise.allSettled(SCREENS.map(async (screen) => {
        // `api` is the app mounted at `/api`, so its own routes carry no
        // prefix — the path here is the route's, not the public URL's.
        const target = new URL(`${url.origin}/sites/${site.id}/${screen.path}`)
        const response = await api.request(target.toString(), { method: 'GET', headers }, c.env)
        if (!response.ok) throw new Error(`${screen.path}: ${response.status}`)
        // The body is not needed; the route wrote its own cache entry on the
        // way out. Reading it to completion keeps the response object from
        // being garbage-collected mid-flight.
        await response.arrayBuffer()
        return screen
      }))

      const warmed: string[] = []
      const failed: string[] = []
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') warmed.push(SCREENS[index].name)
        else failed.push(SCREENS[index].path)
      })

      /*
       * Two screens share the `pages` key: the list and the editor open the
       * same page data. Reporting both would be noise, so the answer collapses
       * to which keys ended up written.
       */
      const keys = [...new Set(warmed)].map(name => cacheKey(site.id, site.branch, name))
      return c.json({ warmed: [...new Set(warmed)], failed, keys })
    }
    catch (error) {
      return handle(c, error)
    }
  })
}
