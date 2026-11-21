/**
 * Posts: list, read, create, update, delete, rename.
 *
 * Every write is a GitHub commit, so the repo's history is the audit trail of
 * the content itself. Reads are live (with a short KV index cache) rather than
 * a shadow copy, because a shadow copy is a second truth that drifts.
 */

import type { Hono } from 'hono'
import type { PanelEnv } from '../middleware'
import { audit } from '../middleware'
import {
  commitFiles,
  deleteFile,
  getFile,
  listCommits,
  listTree,
  readDirectory,
  putFile,
  type FileChange,
} from '../lib/github'
import { assertSlug, classifyPath, normalizePath } from '../lib/paths'
import {
  countWords,
  newPostContent,
  parsePost,
  readingMinutes,
  rewritePost,
  type PostFrontmatter,
} from '../lib/frontmatter'
import { lineDiff } from '../lib/diff'
import { authOf, handle, limitParam, readJson, siteOf, targetOf, writeBudget } from './shared'
import type { Site } from '../sites'

export interface PostSummary {
  slug: string
  path: string
  title: string
  description: string
  published: string
  updated?: string
  tags: string[]
  pin: number
  draft: boolean
  /** The post's own language, or '' when the file has no `lang` line. */
  lang: string
  words: number
  minutes: number
  sha: string
}

// The index is invalidated on every write, so a long TTL only affects edits made
// outside the panel (where a day is close enough).
const INDEX_TTL = 86400

function indexPath(site: Site): string {
  return `index:posts:${site.id}:${site.branch}`
}

/**
 * The post index.
 *
 * A cold read costs one request per post; after that it is free for a minute.
 * The cache is invalidated explicitly on every write, so the worst case is a
 * minute-long staleness on an edit made from another device — and a save from
 * this panel always re-reads the real file for its sha, so a stale index can
 * never cause an overwrite.
 */
async function buildIndex(c: Parameters<typeof handle>[0], site: Site): Promise<PostSummary[]> {
  const cacheKey = indexPath(site)
  const cached = await c.env.CACHE.get(cacheKey, 'json').catch(() => null) as PostSummary[] | null
  if (cached) return cached

  const target = await targetOf(c, site)

  /*
   * One request, not one per post.
   *
   * The REST Contents API returns a single file per call, so the list cost
   * thirteen round trips and took six seconds on a slow link — which is what
   * made the panel feel broken rather than slow. GraphQL returns the text of
   * every blob in the directory in a single response.
   */
  let files: Array<{ path: string, text: string, sha: string }>
  try {
    const entries = await readDirectory(target, normalizePath(site.paths.posts))
    files = entries
      .filter(entry => entry.name.endsWith('.md'))
      .map(entry => ({ path: entry.path, text: entry.text, sha: entry.sha }))
  }
  catch (error) {
    // GraphQL unavailable or refused: fall back to the REST walk, which is
    // slower but uses a different endpoint and permission surface.
    const tree = await listTree(target, normalizePath(site.paths.posts))
    const paths = tree.filter(entry => entry.type === 'blob' && entry.path.endsWith('.md'))
    files = (await Promise.all(paths.map(async (entry) => {
      const file = await getFile(target, entry.path).catch(() => null)
      if (!file || !('content' in file)) return null
      return { path: entry.path, text: file.content, sha: file.sha }
    }))).filter((file): file is { path: string, text: string, sha: string } => file !== null)
    void error
  }

  const summaries: PostSummary[] = []
  for (const file of files) {
    try {
      const parsed = parsePost(file.text)
      const words = countWords(parsed.body)
      summaries.push({
        slug: file.path.split('/').pop()!.replace(/\.md$/, ''),
        path: file.path,
        title: parsed.frontmatter.title,
        description: parsed.frontmatter.description,
        published: parsed.frontmatter.published,
        ...(parsed.frontmatter.updated ? { updated: parsed.frontmatter.updated } : {}),
        tags: parsed.frontmatter.tags,
        pin: parsed.frontmatter.pin,
        draft: parsed.frontmatter.draft,
        lang: parsed.frontmatter.lang ?? '',
        words,
        minutes: readingMinutes(words),
        sha: file.sha,
      })
    }
    catch {
      // One unreadable post must not blank the whole list; it is shown as a
      // file the panel cannot parse.
      summaries.push({
        slug: file.path.split('/').pop()!.replace(/\.md$/, ''),
        path: file.path,
        title: `（无法解析）${file.path.split('/').pop()}`,
        description: '',
        published: '',
        tags: [],
        pin: 0,
        draft: false,
        lang: '',
        words: 0,
        minutes: 0,
        sha: file.sha,
      })
    }
  }

  summaries.sort((a, b) => {
    if (a.pin !== b.pin) return b.pin - a.pin
    return (b.published ?? '').localeCompare(a.published ?? '')
  })

  await c.env.CACHE.put(cacheKey, JSON.stringify(summaries), { expirationTtl: INDEX_TTL }).catch(() => {})
  return summaries
}

async function invalidateIndex(c: Parameters<typeof handle>[0], site: Site): Promise<void> {
  await c.env.CACHE.delete(indexPath(site)).catch(() => {})
}

function postPath(site: Site, slug: string): string {
  const path = `${normalizePath(site.paths.posts)}/${assertSlug(slug)}.md`
  // The allowlist runs on the assembled path too — a custom `posts` path that
  // escapes the repo must be refused here, not only at site-creation time.
  classifyPath(path, site.paths)
  return path
}

export function registerPostRoutes(api: Hono<PanelEnv>): void {
  api.get('/sites/:siteId/posts', async (c) => {
    try {
      const site = await siteOf(c)
      const posts = await buildIndex(c, site)
      const tag = c.req.query('tag')
      const status = c.req.query('status')
      const q = (c.req.query('q') ?? '').trim().toLowerCase()

      const filtered = posts.filter((post) => {
        if (tag && !post.tags.includes(tag)) return false
        if (status === 'draft' && !post.draft) return false
        if (status === 'published' && post.draft) return false
        if (q) {
          const haystack = `${post.title} ${post.description} ${post.tags.join(' ')} ${post.slug}`.toLowerCase()
          if (!haystack.includes(q)) return false
        }
        return true
      }).slice(0, limitParam(c, 500, 1000))

      const tags = [...new Set(posts.flatMap(post => post.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
      return c.json({ posts: filtered, tags, total: posts.length })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.get('/sites/:siteId/posts/:slug', async (c) => {
    try {
      const site = await siteOf(c)
      const slug = assertSlug(c.req.param('slug'))
      const target = await targetOf(c, site)
      const file = await getFile(target, postPath(site, slug))
      if (!('content' in file)) throw new Error('不是一个文件')
      const parsed = parsePost(file.content)
      return c.json({
        slug,
        path: file.path,
        sha: file.sha,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        extra: parsed.extra,
        raw: file.content,
        words: countWords(parsed.body),
        minutes: readingMinutes(countWords(parsed.body)),
        url: `/posts/${slug}/`,
      })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.post('/sites/:siteId/posts', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const body = await readJson<{
        slug: string
        title?: string
        description?: string
        tags?: string[]
        pin?: number
        draft?: boolean
      }>(c)

      const slug = assertSlug(String(body.slug ?? '').trim().toLowerCase())
      const path = postPath(site, slug)
      const target = await targetOf(c, site)

      // Refuse a duplicate rather than overwrite: `npm run new` does the same,
      // and an accidental overwrite loses writing with no way back.
      const existing = await getFile(target, path).catch(() => null)
      if (existing) {
        return c.json({ error: `已存在 ${path}，换一个网址再试`, code: 'POST_EXISTS' }, 409)
      }

      const content = newPostContent(slug, {
        ...(body.title ? { title: body.title } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags.filter(Boolean) } : {}),
        ...(typeof body.pin === 'number' ? { pin: body.pin } : {}),
        ...(body.draft ? { draft: true } : {}),
      })

      const result = await putFile(target, path, content, undefined, `feat: 新建文章 ${slug}`)
      await invalidateIndex(c, site)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'post.create',
        target: path,
        commit: result.commit,
      })
      return c.json({ slug, path, sha: result.sha, commit: result.commit }, 201)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /**
   * Save a post.
   *
   * `sha` from the editor is required: it is what stops the panel from
   * clobbering a change someone else pushed while this tab was open. A missing
   * or stale sha is a conflict, and the UI's answer is "reload and merge".
   */
  /**
   * What a save would change — without changing it.
   *
   * `PUT /posts/:slug` is powerful: it rewrites a file in someone's repo. This
   * endpoint runs the identical render step and returns the resulting text plus
   * a line diff, so the UI can show exactly what will be committed before the
   * commit happens. It touches nothing.
   */
  api.post('/sites/:siteId/posts/:slug/preview', async (c) => {
    /*
     * Budgeted like a write even though it commits nothing: it reads the
     * current file from GitHub on every save attempt, and the editor calls it
     * each time the author presses save. Without a budget a stuck client could
     * spend the token's hourly quota on previews alone.
     */
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const slug = assertSlug(c.req.param('slug'))
      const body = await readJson<{
        frontmatter: PostFrontmatter
        body: string
        newSlug?: string
        extra?: Record<string, string>
      }>(c, 5_000_000)

      const target = await targetOf(c, site)
      const path = postPath(site, slug)
      const current = await getFile(target, path)
      if (!('content' in current)) throw new Error('不是一个文件')

      const fm: PostFrontmatter = {
        title: String(body.frontmatter?.title ?? '').trim(),
        description: String(body.frontmatter?.description ?? ''),
        published: String(body.frontmatter?.published ?? '').trim(),
        ...(body.frontmatter?.updated ? { updated: String(body.frontmatter.updated) } : {}),
        tags: Array.isArray(body.frontmatter?.tags) ? body.frontmatter.tags.map(String).filter(Boolean) : [],
        pin: Number(body.frontmatter?.pin ?? 0),
        draft: Boolean(body.frontmatter?.draft),
      }

      const newSlug = body.newSlug ? assertSlug(String(body.newSlug).trim().toLowerCase()) : slug
      const newPath = postPath(site, newSlug)
      // The real file is the base of the edit. Passing a synthesised empty
      // front matter here would drop every key the panel does not model — the
      // author's `toc`, `abbrlink`, and even `draft: false`.
      const rendered = rewritePost(current.content, fm, body.extra ?? {}, body.body)
      parsePost(rendered)

      return c.json({
        path: newPath,
        renamed: newPath !== path,
        before: current.content,
        after: rendered,
        diff: lineDiff(current.content, rendered),
      })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.put('/sites/:siteId/posts/:slug', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const slug = assertSlug(c.req.param('slug'))
      const body = await readJson<{
        sha: string
        frontmatter: PostFrontmatter
        body: string
        newSlug?: string
        extra?: Record<string, string>
      }>(c)

      if (!body.sha) return c.json({ error: '缺少 sha，请刷新后再保存', code: 'SHA_REQUIRED' }, 400)
      if (typeof body.body !== 'string') return c.json({ error: '缺少正文', code: 'BODY_REQUIRED' }, 400)

      const target = await targetOf(c, site)
      const oldPath = postPath(site, slug)

      // The file as it is on GitHub is the base of the edit — not the panel's
      // model. Without this the save rebuilt front matter from the form alone,
      // which silently removed every key the form does not show.
      const current = await getFile(target, oldPath)
      if (!('content' in current)) throw new Error('不是一个文件')
      if (current.sha !== body.sha) {
        return c.json({ error: '文章在此期间被修改过，请刷新后再保存', code: 'CONFLICT' }, 409)
      }
      const file = current

      const fm: PostFrontmatter = {
        title: String(body.frontmatter?.title ?? '').trim(),
        description: String(body.frontmatter?.description ?? ''),
        published: String(body.frontmatter?.published ?? '').trim(),
        ...(body.frontmatter?.updated ? { updated: String(body.frontmatter.updated) } : {}),
        tags: Array.isArray(body.frontmatter?.tags) ? body.frontmatter.tags.map(String).filter(Boolean) : [],
        pin: Number(body.frontmatter?.pin ?? 0),
        draft: Boolean(body.frontmatter?.draft),
      }
      if (!fm.title) return c.json({ error: '标题不能为空', code: 'TITLE' }, 400)
      if (!fm.published) return c.json({ error: '发布日期不能为空', code: 'PUBLISHED' }, 400)

      // Round-trip through the parser so a value the site's schema would reject
      // never reaches a commit.
      //
      // `file.content` — not a synthesised empty front matter — is the base:
      // the save must edit the file that is there, keeping every key the panel
      // does not model. And `body.body` is passed as the new body, which an
      // earlier version forgot, so edits to the prose were silently discarded.
      const rendered = rewritePost(file.content, fm, body.extra ?? {}, body.body)
      parsePost(rendered)

      const newSlug = body.newSlug ? assertSlug(String(body.newSlug).trim().toLowerCase()) : slug
      const newPath = postPath(site, newSlug)

      let result: { commit: string }
      let finalSha: string

      if (newPath !== oldPath) {
        // Rename: write the new file and delete the old one in a single commit,
        // so the site never has a build with both or neither.
        const changes: FileChange[] = [
          { path: newPath, content: rendered },
          { path: oldPath, delete: true },
        ]
        const committed = await commitFiles(target, changes, `refactor: ${slug} → ${newSlug}`)
        result = { commit: committed.commit }
        finalSha = (await getFile(target, newPath).catch(() => null) as { sha: string } | null)?.sha ?? ''
        await audit(c.env, {
          siteId: site.id,
          email: authOf(c).user.email,
          action: 'post.rename',
          target: `${oldPath} → ${newPath}`,
          commit: result.commit,
        })
      }
      else {
        const written = await putFile(target, oldPath, rendered, body.sha, `chore: 更新 ${slug}`)
        result = { commit: written.commit }
        finalSha = written.sha
      }

      await invalidateIndex(c, site)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'post.save',
        target: newPath,
        detail: { title: fm.title, draft: fm.draft, words: countWords(body.body) },
        commit: result.commit,
      })
      return c.json({ slug: newSlug, path: newPath, sha: finalSha, commit: result.commit })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.delete('/sites/:siteId/posts/:slug', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const slug = assertSlug(c.req.param('slug'))
      const target = await targetOf(c, site)
      const path = postPath(site, slug)
      const file = await getFile(target, path)
      if (!('content' in file)) throw new Error('不是一个文件')

      const before = c.req.query('sha')
      if (before && before !== file.sha) {
        return c.json({ error: '文章在此期间被修改过，请刷新后再删除', code: 'CONFLICT' }, 409)
      }

      const result = await deleteFile(target, path, file.sha, `chore: 删除文章 ${slug}`)
      await invalidateIndex(c, site)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'post.delete',
        target: path,
        commit: result.commit,
      })
      return c.json({ ok: true, commit: result.commit })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** Batch operations on several posts in one commit. */
  api.post('/sites/:siteId/posts/batch', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const body = await readJson<{
        slugs: string[]
        op: 'publish' | 'unpublish' | 'pin' | 'unpin' | 'addTag' | 'removeTag' | 'delete'
        tag?: string
        pin?: number
      }>(c)

      const slugs = (body.slugs ?? []).map(slug => assertSlug(String(slug)))
      if (!slugs.length) return c.json({ error: '没有选中文章', code: 'EMPTY' }, 400)
      if (slugs.length > 100) return c.json({ error: '一次最多处理 100 篇', code: 'TOO_MANY' }, 400)

      const target = await targetOf(c, site)
      const changes: FileChange[] = []

      for (const slug of slugs) {
        const path = postPath(site, slug)
        const file = await getFile(target, path).catch(() => null)
        if (!file || !('content' in file)) continue

        if (body.op === 'delete') {
          changes.push({ path, delete: true })
          continue
        }

        const parsed = parsePost(file.content)
        const fm = { ...parsed.frontmatter }
        switch (body.op) {
          case 'publish': fm.draft = false; break
          case 'unpublish': fm.draft = true; break
          case 'pin': fm.pin = Math.max(0, Math.min(99, Number(body.pin ?? 1))); break
          case 'unpin': fm.pin = 0; break
          case 'addTag': {
            const tag = String(body.tag ?? '').trim()
            if (tag && !fm.tags.includes(tag)) fm.tags = [...fm.tags, tag]
            break
          }
          case 'removeTag': {
            const tag = String(body.tag ?? '').trim()
            fm.tags = fm.tags.filter(item => item !== tag)
            break
          }
          default:
            return c.json({ error: '不支持的操作', code: 'OP' }, 400)
        }
        changes.push({ path, content: rewritePost(file.content, fm, parsed.extra) })
      }

      if (!changes.length) return c.json({ error: '没有找到要处理的文章', code: 'NOT_FOUND' }, 404)

      const committed = await commitFiles(target, changes, `chore: 批量 ${body.op}（${changes.length} 篇）`)
      await invalidateIndex(c, site)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: `post.batch.${body.op}`,
        target: slugs.join(','),
        detail: { tag: body.tag, pin: body.pin },
        commit: committed.commit,
      })
      return c.json({ ok: true, count: changes.length, commit: committed.commit })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** Commit history for the posts folder — a content-only view of the repo. */
  api.get('/sites/:siteId/posts-history', async (c) => {
    try {
      const site = await siteOf(c)
      const target = await targetOf(c, site)
      const commits = await listCommits(target, normalizePath(site.paths.posts), limitParam(c, 30, 100))
      return c.json({ commits })
    }
    catch (error) {
      return handle(c, error)
    }
  })
}

/**
 * A line diff, for showing a save before it happens.
 *
 * Deliberately a simple LCS over lines rather than a character-level diff: the
 * question the UI answers is "which lines of my post change", and a
 * line-granular answer is both cheaper and easier to read. A very long file is
 * capped, because an O(n·m) table on a 10k-line file would be worse than
 * uselessness — the caller is told the diff was truncated.
 */
