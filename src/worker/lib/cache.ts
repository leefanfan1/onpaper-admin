/**
 * A read-through cache for the panel's GET endpoints.
 *
 * Every screen costs at least one GitHub round trip, and from a slow link that
 * is most of a second. The panel is used from the same place over and over —
 * open the shelf, open a post, come back to the shelf — so caching the response
 * body turns the second visit into a few milliseconds.
 *
 * Three rules keep it honest:
 *
 * 1. **Writes invalidate.** Every route that commits calls `invalidate` for its
 *    site, so a change made in the panel is visible on the next read.
 * 2. **The cache is per site and per branch.** Two sites editing the same repo
 *    on different branches must not see each other's data.
 * 3. **A stale entry is better than a slow page, but not better than a wrong
 *    one.** The TTL is short enough that an edit made elsewhere (a git push, an
 *    Actions run) shows up on its own within a minute or two, and the routes
 *    that show a diff always read the file live.
 */

import type { Env } from '../env'

/** How long a cached GET response lives, in seconds. */
const TTL = 120

export interface CacheKeyParts {
  siteId: number
  branch: string
  /** The route's own name, e.g. `shelf` or `pages`. */
  name: string
}

/**
 * The one cache-key format.
 *
 * Exported because the routes build the same key when they read and the
 * invalidator builds it when it deletes — and a mismatch between the two is
 * invisible: the write succeeds, the delete succeeds, and the stale entry stays.
 * That happened once already (`get:pages:1:main` written, `get:1:main:pages`
 * deleted), so the string lives in one place now.
 */
export function cacheKey(siteId: number, branch: string, name: string): string {
  return `get:${siteId}:${branch}:${name}`
}

function keyOf(parts: CacheKeyParts): string {
  return cacheKey(parts.siteId, parts.branch, parts.name)
}

/**
 * Read through the cache.
 *
 * `load` is only called on a miss. A cache read that fails (KV down, corrupt
 * JSON) falls through to `load` rather than failing the request: the cache is an
 * optimisation, never a dependency.
 */
export async function cached<T>(
  env: Env,
  parts: CacheKeyParts,
  load: () => Promise<T>,
): Promise<T> {
  const key = keyOf(parts)

  try {
    const hit = await env.CACHE.get(key, 'json') as T | null
    if (hit !== null) return hit
  }
  catch {
    // Fall through to a fresh load.
  }

  const value = await load()
  // A failed write must not fail the request — the page still renders, it is
  // just not cached.
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: TTL }).catch(() => {})
  return value
}

/**
 * Drop every cached GET for a site.
 *
 * Called after a commit. The KV namespace has no delete-by-prefix, so the list of
 * names is explicit — which is also a useful reminder of what the site's
 * invalidation covers. A name not on this list is a screen that can show stale
 * data for up to the TTL, so it belongs here when a route is added.
 */
const CACHED_NAMES = [
  'posts',
  'pages',
  'shelf',
  'config',
  'overview',
  'tasks',
  'tasks-meta',
  'commits',
  // One per media folder: the list is a whole-repo tree walk on GitHub's side,
  // which measured 2.3s, and a tab that lists pictures is opened repeatedly.
  'media-images',
  'media-shelf',
  'media-music',
  'media-og',
  // One per page: the editor asks for a single page, not the list.
  'page-about',
  'page-now',
  'page-friends',
] as const

export async function invalidateSite(env: Env, siteId: number, branch: string): Promise<void> {
  await Promise.all(CACHED_NAMES.map(name =>
    env.CACHE.delete(keyOf({ siteId, branch, name })).catch(() => {}),
  ))
  // The post index uses its own key shape (it predates this module).
  await env.CACHE.delete(`index:posts:${siteId}:${branch}`).catch(() => {})
}
