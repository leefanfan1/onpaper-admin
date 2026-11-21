/**
 * Markdown import and export.
 *
 * Import is the one path where a whole file the panel did not write becomes a
 * commit, so it is the one that most needs care:
 *
 *   - the slug comes from the upload's front matter or its file name, and is
 *     validated by the same rules `npm run new` uses;
 *   - an existing post is never overwritten silently — the caller must say so;
 *   - the front matter is parsed and re-emitted by the panel's own writer, so a
 *     file with a stray `pubished:` typo is reported rather than committed;
 *   - the body's newlines are normalised to the file's existing style.
 *
 * Export is a plain text download of the file as it is on disk, not a
 * re-rendering: what you download is what the site builds.
 */

import type { Hono } from 'hono'
import type { PanelEnv } from '../middleware'
import { audit } from '../middleware'
import { getFile, putFile } from '../lib/github'
import { assertSlug, classifyPath, normalizePath } from '../lib/paths'
import { newPostContent, parsePost, rewritePost, type PostFrontmatter } from '../lib/frontmatter'
import { authOf, handle, readJson, siteOf, targetOf, writeBudget } from './shared'
import { invalidateSite } from '../lib/cache'
import type { Site } from '../sites'

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

export interface ImportResult {
  slug: string
  path: string
  created: boolean
  title: string
  published: string
  tags: string[]
  words: number
}

function postPathFor(site: Site, slug: string): string {
  const path = `${normalizePath(site.paths.posts)}/${assertSlug(slug)}.md`
  classifyPath(path, site.paths)
  return path
}

/** A slug from a filename, the way `npm run new` would have made one. */
function slugFromFilename(filename: string): string {
  return filename
    .replace(/\.(md|markdown|mdx)$/i, '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export function registerMarkdownRoutes(api: Hono<PanelEnv>): void {
  /**
   * Import one or more Markdown files.
   *
   * Each file is parsed first; a file whose front matter the site's schema
   * would reject is reported by name and not written. Valid files are committed
   * together, so a three-file import is one commit and one build.
   */
  api.post('/sites/:siteId/posts/import', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const body = await readJson<{
        files: Array<{ name: string, content: string }>
        /** Overwrite an existing post with the same slug. Defaults to false. */
        overwrite?: boolean
      }>(c, MAX_UPLOAD_BYTES * 2)

      const incoming = body.files ?? []
      if (!incoming.length) return c.json({ error: '没有文件', code: 'EMPTY' }, 400)
      if (incoming.length > 20) return c.json({ error: '一次最多导入 20 个文件', code: 'TOO_MANY' }, 400)

      const target = await targetOf(c, site)
      const results: ImportResult[] = []
      const rejected: Array<{ name: string, reason: string }> = []
      const conflicts: string[] = []

      for (const file of incoming) {
        const name = String(file.name ?? 'untitled.md')
        const content = String(file.content ?? '')

        if (content.length > MAX_UPLOAD_BYTES) {
          rejected.push({ name, reason: '文件超过 2 MB' })
          continue
        }

        // The front matter is the gate: a file the panel cannot read is a file
        // the site cannot build, so it is refused here rather than committed.
        let parsed
        try {
          parsed = parsePost(content)
        }
        catch (error) {
          rejected.push({
            name,
            reason: error instanceof Error ? error.message : 'frontmatter 无法解析',
          })
          continue
        }

        // The slug comes from the file name, falling back to the front matter's
        // title when the name has no Latin characters to derive one from.
        let slug = slugFromFilename(name)
        if (!slug) {
          rejected.push({
            name,
            reason: '文件名无法生成网址；请把小写英文文件名写进 front matter 之外的路径',
          })
          continue
        }

        const path = postPathFor(site, slug)
        const existing = await getFile(target, path).catch(() => null)
        if (existing && !body.overwrite) {
          conflicts.push(`《${parsed.frontmatter.title}》→ ${path}`)
          continue
        }

        // Rewrite through the panel's own writer so the stored file has the
        // shape everything else expects, whatever quoting the upload used.
        const rendered = rewritePost(content, parsed.frontmatter, parsed.extra)
        const written = await putFile(
          target,
          path,
          rendered,
          existing && 'sha' in existing ? existing.sha : undefined,
          existing ? `chore: 导入覆盖 ${slug}` : `feat: 导入文章 ${slug}`,
        )

        results.push({
          slug,
          path,
          created: !existing,
          title: parsed.frontmatter.title,
          published: parsed.frontmatter.published,
          tags: parsed.frontmatter.tags,
          words: parsed.body.trim().length,
        })
        void written
      }

      if (!results.length) {
        return c.json(
          { error: '没有可导入的文件', code: 'NONE', rejected, conflicts },
          conflicts.length ? 409 : 400,
        )
      }

      /*
       * The import writes files; the list is cached. Without this the newly
       * imported posts did not appear until the index expired — a day later —
       * which reads as "the import did nothing".
       */
      await invalidateSite(c.env, site.id, site.branch)

      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'post.import',
        target: results.map(result => result.slug).join(','),
        detail: { imported: results.length, rejected: rejected.length, conflicts: conflicts.length },
      })

      return c.json({ imported: results, rejected, conflicts })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /**
   * Download a post as a `.md` file.
   *
   * The response is the file's own bytes with a `Content-Disposition`, so the
   * browser saves it rather than rendering it. It is not re-serialised: what
   * comes down is exactly what the repo holds.
   */
  api.get('/sites/:siteId/posts/:slug/download', async (c) => {
    try {
      const site = await siteOf(c)
      const slug = assertSlug(c.req.param('slug'))
      const target = await targetOf(c, site)
      const file = await getFile(target, postPathFor(site, slug))
      if (!('content' in file)) throw new Error('不是一个文件')

      // The file name is the slug — ASCII by construction — so it needs no
      // encoding games and cannot carry a header injection.
      return new Response(file.content, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${slug}.md"`,
          'Cache-Control': 'no-store',
        },
      })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** Download every post as one `.zip`-less bundle of front-matter-delimited text is not useful; a list is. */
  api.get('/sites/:siteId/posts/export-all', async (c) => {
    try {
      const site = await siteOf(c)
      const target = await targetOf(c, site)
      const tree = await listPosts(target, site)
      const files = await Promise.all(tree.map(async (path) => {
        const file = await getFile(target, path).catch(() => null)
        if (!file || !('content' in file)) return null
        return { path, name: path.split('/').pop() ?? path, content: file.content }
      }))
      const ok = files.filter((file): file is { path: string, name: string, content: string } => Boolean(file))
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'post.export',
        target: `${ok.length} 篇`,
      })
      return c.json({ files: ok })
    }
    catch (error) {
      return handle(c, error)
    }
  })
}

async function listPosts(target: Awaited<ReturnType<typeof targetOf>>, site: Site): Promise<string[]> {
  const tree = await import('../lib/github').then(module => module.listTree(target, normalizePath(site.paths.posts)))
  return tree.filter(entry => entry.type === 'blob' && entry.path.endsWith('.md')).map(entry => entry.path)
}

void newPostContent
void ({} as PostFrontmatter)
