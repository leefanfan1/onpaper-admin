/**
 * Shelf lists: books, films, music.
 *
 * Each file is one list of `键：值` paragraphs. The panel edits them one entry
 * at a time as a form, but writes them back through the theme's own field
 * order and paragraph rules — so `npm run covers` still recognises every entry
 * the panel touches, and the panel recognises everything it wrote.
 */

import type { Hono } from 'hono'
import type { PanelEnv } from '../middleware'
import { audit } from '../middleware'
import { getFile, putFile } from '../lib/github'
import { classifyPath, normalizePath } from '../lib/paths'
import {
  deleteShelfEntry,
  FIELD_ORDER,
  shelfEntriesOf,
  upsertShelfEntry,
  type ShelfKind,
} from '../lib/content'
import { cacheKey, invalidateSite } from '../lib/cache'
import { authOf, handle, readJson, siteOf, targetOf, writeBudget } from './shared'
import type { Site } from '../sites'

/** File name -> kind, matching the theme's own mapping. */
const FILES: Record<string, ShelfKind> = {
  books: 'book',
  films: 'film',
  music: 'music',
}
const CREATOR_KEY: Record<ShelfKind, string> = { book: '作者', film: '导演', music: '歌手' }

function assertKind(value: string): ShelfKind {
  const kind = FILES[value]
  if (!kind) throw new Error(`未知的书架 ${value}`)
  return kind
}

function shelfPath(site: Site, listName: string): string {
  assertKind(listName)
  const path = `${normalizePath(site.paths.shelf)}/${listName}.md`
  classifyPath(path, site.paths)
  return path
}

export interface ShelfView {
  list: string
  kind: ShelfKind
  path: string
  sha: string
  entries: Array<{
    title: string
    creator: string
    year: string
    note: string
    douban: string
    link: string
    cover: string
    /** A cover line the author wrote, versus one `covers` recorded. */
    handwrittenCover: boolean
  }>
  fieldOrder: string[]
  creatorKey: string
}

/** Read the cover cache so the panel can say which entries have images. */
async function readCoverCache(c: Parameters<typeof handle>[0], site: Site): Promise<Record<string, string>> {
  try {
    const target = await targetOf(c, site)
    const file = await getFile(target, `${normalizePath(site.paths.data)}/shelf-covers.json`)
    if (!('content' in file)) return {}
    return JSON.parse(file.content) as Record<string, string>
  }
  catch {
    return {}
  }
}

/**
 * Resolve a stored cover path against the published site.
 *
 * `shelf-covers.json` records `/shelf/xxx.jpg`: a path on the Site, not on the
 * panel. An absolute URL (one the author typed) is returned unchanged.
 */
function absoluteCover(site: Site, cover: string): string {
  if (!cover) return ''
  if (/^https?:\/\//i.test(cover)) return cover
  if (!site.publicUrl) return cover
  return `${site.publicUrl}${cover.startsWith('/') ? '' : '/'}${cover}`
}

export function registerShelfRoutes(api: Hono<PanelEnv>): void {
  api.get('/sites/:siteId/shelf', async (c) => {
    try {
      const site = await siteOf(c)
      const readCacheKey = cacheKey(site.id, site.branch, 'shelf')
      const hit = await c.env.CACHE.get(readCacheKey, 'json').catch(() => null)
      if (hit) return c.json(hit as Record<string, unknown>)

      const target = await targetOf(c, site)

      /*
       * Four files, one round trip each, started together.
       *
       * The cover cache used to be read before the lists began, which added a
       * whole GitHub round trip to every visit — the shelf took 1.7 seconds
       * where 0.5 is possible. The three list files and the cache do not depend
       * on each other, so they start at once; the entries are built after, in
       * JS, where the cover lookup needs the cache.
       */
      const [covers, rawLists] = await Promise.all([
        readCoverCache(c, site),
        Promise.all(Object.entries(FILES).map(async ([list, kind]) => {
          try {
            const file = await getFile(target, shelfPath(site, list))
            if (!('content' in file)) return { list, kind, content: null, path: '', sha: '' }
            return { list, kind, content: file.content, path: file.path, sha: file.sha }
          }
          catch {
            return { list, kind, content: null, path: '', sha: '' }
          }
        })),
      ])

      const lists = rawLists.map((raw) => {
        if (raw.content === null) {
          return { list: raw.list, kind: raw.kind, exists: false, entries: [] }
        }
        const entries = shelfEntriesOf(raw.content, raw.kind).map(entry => ({
          title: entry.title,
          creator: entry.creator,
          year: entry.year,
          note: entry.note,
          douban: entry.douban,
          link: entry.link,
          // The cache key is `<kind>:<title>`, and only when the file itself
          // does not name a cover.
          cover: absoluteCover(site, entry.cover || covers[`${raw.kind}:${entry.title}`] || ''),
          handwrittenCover: Boolean(entry.cover),
        }))
        return {
          list: raw.list,
          kind: raw.kind,
          exists: true,
          path: raw.path,
          sha: raw.sha,
          entries,
          fieldOrder: FIELD_ORDER[raw.kind],
          creatorKey: CREATOR_KEY[raw.kind],
        }
      })

      const payload = { lists, coverCache: covers }
      await c.env.CACHE.put(readCacheKey, JSON.stringify(payload), { expirationTtl: 120 }).catch(() => {})
      return c.json(payload)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.get('/sites/:siteId/shelf/:list', async (c) => {
    try {
      const site = await siteOf(c)
      const list = c.req.param('list')
      const kind = assertKind(list)
      const target = await targetOf(c, site)
      const file = await getFile(target, shelfPath(site, list))
      if (!('content' in file)) throw new Error('不是一个文件')
      const covers = await readCoverCache(c, site)
      const view: ShelfView = {
        list,
        kind,
        path: file.path,
        sha: file.sha,
        fieldOrder: FIELD_ORDER[kind],
        creatorKey: CREATOR_KEY[kind],
        entries: shelfEntriesOf(file.content, kind).map(entry => ({
          title: entry.title,
          creator: entry.creator,
          year: entry.year,
          note: entry.note,
          douban: entry.douban,
          link: entry.link,
          cover: absoluteCover(site, entry.cover || covers[`${kind}:${entry.title}`] || ''),
          handwrittenCover: Boolean(entry.cover),
        })),
      }
      return c.json({ shelf: view })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /**
   * Add or update one entry.
   *
   * `originalTitle` is how a rename is expressed: the panel finds the existing
   * paragraph by its old title and rewrites it in place, so the entry keeps its
   * position in the list rather than jumping to the end.
   */
  api.put('/sites/:siteId/shelf/:list/entries', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const list = c.req.param('list')
      const kind = assertKind(list)
      const body = await readJson<{
        sha?: string
        entry: Record<string, string>
        originalTitle?: string
      }>(c)

      const target = await targetOf(c, site)
      const path = shelfPath(site, list)
      const current = await getFile(target, path).catch(() => null)
      if (!current || !('content' in current)) {
        return c.json({ error: `找不到 ${path}`, code: 'SHELF_MISSING' }, 404)
      }
      if (body.sha && body.sha !== current.sha) {
        return c.json({ error: '清单在此期间被修改过，请刷新后再保存', code: 'CONFLICT' }, 409)
      }

      const entry = body.entry ?? {}
      const titleKey = FIELD_ORDER[kind][0]
      const title = String(entry[titleKey] ?? '').trim()
      if (!title) return c.json({ error: `${titleKey}不能为空`, code: 'TITLE' }, 400)

      const next = upsertShelfEntry(
        current.content,
        kind,
        entry,
        body.originalTitle ? { title: body.originalTitle } : undefined,
      )

      const result = await putFile(
        target,
        path,
        next,
        current.sha,
        `chore: ${body.originalTitle ? '更新' : '新增'}${list === 'books' ? '书' : list === 'films' ? '片' : '歌'}目《${title}》`,
      )
      await invalidateSite(c.env, site.id, site.branch)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: `shelf.${body.originalTitle ? 'update' : 'create'}`,
        target: `${list}:${title}`,
        commit: result.commit,
      })
      return c.json({ ok: true, sha: result.sha, commit: result.commit })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.delete('/sites/:siteId/shelf/:list/entries/:title', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const list = c.req.param('list')
      const kind = assertKind(list)
      const title = decodeURIComponent(c.req.param('title'))
      const target = await targetOf(c, site)
      const path = shelfPath(site, list)
      const current = await getFile(target, path).catch(() => null)
      if (!current || !('content' in current)) {
        return c.json({ error: `找不到 ${path}`, code: 'SHELF_MISSING' }, 404)
      }

      const next = deleteShelfEntry(current.content, kind, title)
      if (next === current.content) {
        return c.json({ error: '清单里没有这一条', code: 'NOT_FOUND' }, 404)
      }

      const result = await putFile(target, path, next, current.sha, `chore: 删除条目《${title}》`)
      await invalidateSite(c.env, site.id, site.branch)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'shelf.delete',
        target: `${list}:${title}`,
        commit: result.commit,
      })
      return c.json({
        ok: true,
        sha: result.sha,
        commit: result.commit,
        // The cover is not removed here: `npm run covers` owns that, and it
        // only deletes files it generated, and only when every list read
        // cleanly.
        hint: '封面要等下一次 npm run covers 才会一起清掉',
      })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** Read the raw file — the escape hatch for anything the form does not model. */
  api.get('/sites/:siteId/shelf/:list/raw', async (c) => {
    try {
      const site = await siteOf(c)
      const list = c.req.param('list')
      assertKind(list)
      const target = await targetOf(c, site)
      const file = await getFile(target, shelfPath(site, list))
      if (!('content' in file)) throw new Error('不是一个文件')
      return c.json({ path: file.path, sha: file.sha, content: file.content })
    }
    catch (error) {
      return handle(c, error)
    }
  })
}
