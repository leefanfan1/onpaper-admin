/**
 * Pages (about / now) and the friends list.
 *
 * `about.md` and `friends.md` are ordinary Markdown with front matter. `now.md`
 * is different: its body is three fixed entries (在听 / 在读 / 在看) in a shape
 * the site's own parser reads, so the panel edits it as structured values and
 * renders them back in the file's own format rather than as free text.
 */

import type { Hono } from 'hono'
import type { PanelEnv } from '../middleware'
import { audit } from '../middleware'
import { getFile, putFile } from '../lib/github'
import { classifyPath, normalizePath } from '../lib/paths'
import { parsePost, rewritePost, type PostFrontmatter } from '../lib/frontmatter'
import {
  deleteNowEntry,
  parseFriends,
  serializeFriends,
  nowEntriesOf,
  upsertNowEntry,
  type FriendLink,
  type NowKind,
} from '../lib/content'
import { cacheKey, invalidateSite } from '../lib/cache'
import { authOf, handle, readJson, siteOf, targetOf, writeBudget } from './shared'
import type { Site } from '../sites'

/** The pages the panel edits, and the fixed name each has in the file tree. */
const KNOWN_PAGES = {
  about: 'about.md',
  now: 'now.md',
  friends: 'friends.md',
} as const

type PageKey = keyof typeof KNOWN_PAGES

function pagePath(site: Site, key: PageKey): string {
  const path = `${normalizePath(site.paths.pages)}/${KNOWN_PAGES[key]}`
  classifyPath(path, site.paths)
  return path
}

function assertPageKey(value: string): PageKey {
  if (!Object.prototype.hasOwnProperty.call(KNOWN_PAGES, value)) {
    throw new Error(`未知的页面 ${value}`)
  }
  return value as PageKey
}

/** Split a page file into front matter fields and body without the post schema. */
function splitPage(text: string): { frontmatter: Record<string, string>, body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { frontmatter: {}, body: text }
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return { frontmatter: {}, body: text }
  const raw = normalized.slice(4, end)
  const frontmatter: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (match) frontmatter[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  const body = normalized.slice(end + 4).replace(/^\n/, '')
  return { frontmatter, body }
}

function joinPage(frontmatter: Record<string, string>, body: string, eol: string): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${/[:#]/.test(value) ? `'${value.replace(/'/g, "''")}'` : value}`)
  }
  lines.push('---', '')
  const rendered = `${lines.join('\n')}${body.replace(/^\n+/, '')}`
  return eol === '\r\n' ? rendered.replace(/\n/g, '\r\n') : rendered
}

/**
 * Read one page and shape it for the editor.
 *
 * Extracted so the GET route and the warm endpoint above both go through one
 * implementation: the cache entry they write has to be the payload the route
 * would have built, and two copies of this would eventually disagree.
 */
async function readOnePage(
  c: Parameters<typeof handle>[0],
  site: Site,
  key: PageKey,
): Promise<Record<string, unknown>> {
  const target = await targetOf(c, site)
  const file = await getFile(target, pagePath(site, key))
  if (!('content' in file)) throw new Error('不是一个文件')
  const split = splitPage(file.content)

  if (key === 'now') {
    const entries = nowEntriesOf(file.content).map(entry => ({
      kind: entry.kind,
      label: entry.label,
      title: entry.title,
      creator: entry.creator,
      url: entry.url,
      year: entry.year,
      douban: entry.douban,
    }))
    return {
      key, exists: true, path: file.path, sha: file.sha,
      frontmatter: split.frontmatter, body: split.body,
      entries,
    }
  }

  if (key === 'friends') {
    let links: FriendLink[] = []
    let error = ''
    try { links = parseFriends(file.content) }
    catch (parseError) { error = parseError instanceof Error ? parseError.message : String(parseError) }
    return {
      key, exists: true, path: file.path, sha: file.sha,
      frontmatter: split.frontmatter, body: split.body,
      links, parseError: error,
    }
  }

  return {
    key, exists: true, path: file.path, sha: file.sha,
    frontmatter: split.frontmatter, body: split.body,
  }
}

export function registerPageRoutes(api: Hono<PanelEnv>): void {
  /** All three pages in one call — the page editor's landing view. */
  api.get('/sites/:siteId/pages', async (c) => {
    try {
      const site = await siteOf(c)
      const readCacheKey = cacheKey(site.id, site.branch, 'pages')
      const hit = await c.env.CACHE.get(readCacheKey, 'json').catch(() => null)
      if (hit) return c.json(hit as Record<string, unknown>)

      const target = await targetOf(c, site)
      const pages = await Promise.all((Object.keys(KNOWN_PAGES) as PageKey[]).map(async (key) => {
        try {
          const file = await getFile(target, pagePath(site, key))
          if (!('content' in file)) return { key, exists: false }
          const split = splitPage(file.content)
          return {
            key,
            exists: true,
            path: file.path,
            sha: file.sha,
            frontmatter: split.frontmatter,
            body: split.body,
          }
        }
        catch {
          return { key, exists: false }
        }
      }))
      const payload = { pages }
      // A read of three files costs a second or more from a slow link; the
      // next visit reads this instead. Writes clear it via invalidatePages.
      await c.env.CACHE.put(readCacheKey, JSON.stringify(payload), { expirationTtl: 120 }).catch(() => {})
      return c.json(payload)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /*
   * One page, cached per page.
   *
   * The list route above has its own entry because it answers a different
   * question; this one is what the editor asks, and it asks every time a page
   * tab is opened. Without this the 关于 screen was the slowest in the panel at
   * four seconds, and warming the list did nothing for it.
   */
  api.get('/sites/:siteId/pages/:page', async (c) => {
    try {
      const site = await siteOf(c)
      const key = assertPageKey(c.req.param('page'))
      const readCacheKey = cacheKey(site.id, site.branch, `page-${key}`)
      const hit = await c.env.CACHE.get(readCacheKey, 'json').catch(() => null)
      if (hit) return c.json(hit as Record<string, unknown>)

      const payload = await readOnePage(c, site, key)
      await c.env.CACHE.put(readCacheKey, JSON.stringify(payload), { expirationTtl: 120 }).catch(() => {})
      return c.json(payload)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** Save a page's front matter and/or body. */
  api.put('/sites/:siteId/pages/:page', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const key = assertPageKey(c.req.param('page'))
      const body = await readJson<{
        sha: string
        frontmatter?: Record<string, string>
        body?: string
        entries?: Array<{ kind: NowKind, label: string, title: string, creator: string, url: string, year: string, douban: string, originalTitle?: string }>
        links?: FriendLink[]
        deleteEntry?: string
      }>(c)

      const target = await targetOf(c, site)
      const path = pagePath(site, key)
      const current = await getFile(target, path).catch(() => null)
      if (!current || !('content' in current)) {
        return c.json({ error: `找不到 ${path}`, code: 'PAGE_MISSING' }, 404)
      }
      if (body.sha && body.sha !== current.sha) {
        return c.json({ error: '页面在此期间被修改过，请刷新后再保存', code: 'CONFLICT' }, 409)
      }

      const eol = current.content.includes('\r\n') ? '\r\n' : '\n'
      let text = current.content
      let summary = ''

      if (key === 'friends' && Array.isArray(body.links)) {
        // Validate with the site's own rules before writing: an invalid URL
        // here breaks the build, and the panel should refuse it, not discover
        // it at deploy time.
        const serialized = serializeFriends(text, body.links.map(link => ({
          name: String(link.name ?? '').trim(),
          url: String(link.url ?? '').trim(),
          description: String(link.description ?? '').trim(),
        })))
        const check = serializeFriends(text, body.links)
        void check
        // Round-trip through the parser to prove the result is valid.
        parseFriends(serialized)
        text = serialized
        summary = `友链 ${body.links.length} 条`
      }
      else if (key === 'now' && Array.isArray(body.entries)) {
        for (const entry of body.entries) {
          text = upsertNowEntry(text, entry.kind, {
            label: entry.label,
            title: entry.title,
            creator: entry.creator,
            url: entry.url,
            year: entry.year,
            douban: entry.douban,
          }, entry.originalTitle ? { title: entry.originalTitle } : undefined)
        }
        if (body.deleteEntry) text = deleteNowEntry(text, body.deleteEntry)
        summary = `「最近」${body.entries.length} 条`
      }
      else {
        const currentSplit = splitPage(current.content)
        const frontmatter = body.frontmatter ?? currentSplit.frontmatter
        const pageBody = typeof body.body === 'string' ? body.body : currentSplit.body
        text = joinPage(frontmatter, pageBody, eol)
        summary = key
      }

      const result = await putFile(target, path, text, current.sha, `chore: 更新 ${KNOWN_PAGES[key]}`)
      await invalidateSite(c.env, site.id, site.branch)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: `page.save.${key}`,
        target: path,
        detail: { summary },
        commit: result.commit,
      })
      return c.json({ ok: true, sha: result.sha, commit: result.commit })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** Create a page that does not exist yet (the theme ships three; a fork may add its own). */
  api.post('/sites/:siteId/pages/:page', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const key = assertPageKey(c.req.param('page'))
      const body = await readJson<{ title?: string, description?: string }>(c)
      const target = await targetOf(c, site)
      const path = pagePath(site, key)

      const existing = await getFile(target, path).catch(() => null)
      if (existing) return c.json({ error: '页面已存在', code: 'PAGE_EXISTS' }, 409)

      const titles: Record<PageKey, string> = { about: '关于', now: '最近', friends: '友链' }
      const text = joinPage(
        { title: body.title ?? titles[key], description: body.description ?? '' },
        key === 'friends'
          ? '\n<!-- 每个友链依次写名称、网址、简介；友链之间空一行，简介可省略。 -->\n'
          : key === 'now'
            ? '\n<!-- 在听 / 在读 / 在看 各一段。 -->\n'
            : '\n',
        '\n',
      )
      const result = await putFile(target, path, text, undefined, `feat: 新建页面 ${KNOWN_PAGES[key]}`)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: `page.create.${key}`,
        target: path,
        commit: result.commit,
      })
      return c.json({ ok: true, sha: result.sha, commit: result.commit }, 201)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  void parsePost
  void rewritePost
  void ({} as PostFrontmatter)
}
