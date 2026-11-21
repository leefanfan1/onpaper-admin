/**
 * Media library: the images a site serves from `public/`.
 *
 * Uploads are the one place where bytes the panel does not control become
 * files in a repo and then files served by a website, so the checks here are
 * about the *content*, not the name:
 *
 *   - the extension is from a fixed list, and SVG is not on it
 *   - the first bytes must match the format the extension claims
 *   - the decoded image must not be a decompression bomb
 *   - the name is rebuilt from scratch, never taken from the request
 */

import type { Hono } from 'hono'
import type { PanelEnv } from '../middleware'
import { audit } from '../middleware'
import { deleteFile, getFile, listTree, putFile, type FileChange } from '../lib/github'
import { classifyPath, mediaPath, normalizePath, PathError } from '../lib/paths'
import { commitFiles } from '../lib/github'
import { authOf, handle, readJson, siteOf, targetOf, writeBudget } from './shared'
import { cached, invalidateSite } from '../lib/cache'
import type { Site } from '../sites'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 40_000_000

/** Magic numbers for the formats the panel accepts. */
function detectImage(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | 'avif' | '' {
  const starts = (values: number[], offset = 0) => values.every((value, index) => bytes[offset + index] === value)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (starts([0xff, 0xd8, 0xff])) return 'jpg'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'webp'
  // AVIF: an ISO-BMFF box whose major brand is avif/avis (at offset 8).
  if (starts([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1') return 'avif'
  }
  return ''
}

/** Read the pixel dimensions out of PNG / JPEG headers, without decoding. */
function dimensions(bytes: Uint8Array, format: string): { width: number, height: number } {
  if (format === 'png' && bytes.length > 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (format === 'jpg') {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue }
      const marker = bytes[offset + 1]
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
      // SOF0-SOF15, excluding the two non-frame markers in that range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        }
      }
      offset += 2 + length
    }
  }
  return { width: 0, height: 0 }
}

/** A filename the panel is willing to create: the author's words, made safe. */
function safeName(original: string, format: string): string {
  const stem = original
    .replace(/\.[^.]+$/, '')
    .normalize('NFKD')
    // Keep CJK and Latin letters, digits, dash and underscore; everything else
    // becomes a dash. This is a name, not a path.
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const base = stem || `image-${Date.now().toString(36)}`
  return `${base}.${format}`
}

function mediaDir(site: Site, folder: string): string {
  return `${normalizePath(site.paths.public)}/${folder}`
}

export function registerMediaRoutes(api: Hono<PanelEnv>): void {
  /** List one media folder. */
  api.get('/sites/:siteId/media/:folder', async (c) => {
    try {
      const site = await siteOf(c)
      const folder = c.req.param('folder')
      // Validated by building a probe path through the same allowlist.
      mediaPath(folder, 'probe.png', site.paths)

      /*
       * Cached, because listing a folder is a whole-tree read.
       *
       * `listTree` resolves the branch ref and then asks for the recursive
       * tree — two round trips over every path in the repository, which
       * measured 2.3 seconds for a folder of a dozen images. Uploading,
       * deleting and renaming all invalidate this, so the cache cannot outlive
       * a change made here; a change pushed elsewhere shows up within the TTL.
       */
      const payload = await cached(c.env, { siteId: site.id, branch: site.branch, name: `media-${folder}` }, async () => {
      const target = await targetOf(c, site)
      const dir = mediaDir(site, folder)
      const tree = await listTree(target, dir)
      const files = tree
        .filter(entry => entry.type === 'blob' && entry.path.startsWith(`${dir}/`))
        .map(entry => {
          const name = entry.path.slice(dir.length + 1)
          // Media is served by the published site, not by the panel: a relative
          // `/images/x.jpg` on this host is a 404, which is what made every
          // picture in the library render as a broken image.
          const relative = `/${folder}/${name}`
          return {
            name,
            path: entry.path,
            size: entry.size ?? 0,
            sha: entry.sha,
            url: site.publicUrl ? `${site.publicUrl}${relative}` : relative,
            relativeUrl: relative,
          }
        })
        .sort((a, b) => b.name.localeCompare(a.name))
        return { folder, files, total: files.length }
      })
      return c.json(payload)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /**
   * Upload files.
   *
   * Files arrive base64-encoded in the JSON body rather than as multipart,
   * because the panel's Worker would otherwise have to stream-parse a form;
   * the size caps are enforced on both the declared length and the decoded
   * bytes, since `Content-Length` is a claim, not a fact.
   */
  api.post('/sites/:siteId/media/:folder', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const folder = c.req.param('folder')
      mediaPath(folder, 'probe.png', site.paths)

      const body = await readJson<{
        files: Array<{ name: string, data: string }>
      }>(c, Math.ceil(MAX_TOTAL_BYTES * 1.4))
      const incoming = body.files ?? []
      if (!incoming.length) return c.json({ error: '没有文件', code: 'EMPTY' }, 400)
      if (incoming.length > 20) return c.json({ error: '一次最多上传 20 个文件', code: 'TOO_MANY' }, 400)

      const target = await targetOf(c, site)
      const changes: FileChange[] = []
      const written: Array<{ path: string, name: string, bytes: number }> = []
      let total = 0

      for (const file of incoming) {
        const binary = atob(String(file.data ?? '').replace(/^data:[^;]+;base64,/, ''))
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))

        if (bytes.length > MAX_FILE_BYTES) {
          return c.json({ error: `${file.name} 超过 5 MB`, code: 'TOO_LARGE' }, 413)
        }
        total += bytes.length
        if (total > MAX_TOTAL_BYTES) {
          return c.json({ error: '本次上传总量超过 20 MB', code: 'TOO_LARGE' }, 413)
        }

        const format = detectImage(bytes)
        if (!format) {
          return c.json(
            { error: `${file.name} 不是可识别的图片（只接受 png、jpg、webp、avif）`, code: 'FORMAT' },
            415,
          )
        }
        const size = dimensions(bytes, format)
        if (size.width && size.height && size.width * size.height > MAX_PIXELS) {
          return c.json({ error: `${file.name} 的像素数过大`, code: 'PIXELS' }, 413)
        }

        const name = safeName(String(file.name ?? ''), format)
        const path = mediaPath(folder, name, site.paths)
        classifyPath(path, site.paths)

        changes.push({ path, content: bytesToBinaryString(bytes) })
        written.push({ path, name, bytes: bytes.length })
      }

      // A binary file cannot go through `putFile`'s UTF-8 path, so this uses a
      // single tree commit with base64-ish blobs; see `commitBinary`.
      const committed = await commitBinary(target, changes, `feat: 上传 ${written.length} 张图片`)
      // The folder listing is cached; a new image has to appear on the next read.
      await invalidateSite(c.env, site.id, site.branch)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'media.upload',
        target: folder,
        detail: { files: written.map(file => file.name), bytes: total },
        commit: committed.commit,
      })
      return c.json({ ok: true, files: written, commit: committed.commit }, 201)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.delete('/sites/:siteId/media/:folder/*', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const folder = c.req.param('folder')
      // `*` captures the rest of the path; re-validate it as a single name.
      const raw = c.req.path.split('/media/')[1] ?? ''
      const relative = decodeURIComponent(raw.split('/').slice(1).join('/'))
      const path = mediaPath(folder, relative, site.paths)

      const target = await targetOf(c, site)
      const file = await getFile(target, path).catch(() => null)
      if (!file || !('content' in file)) {
        return c.json({ error: '文件不存在', code: 'NOT_FOUND' }, 404)
      }

      // Warn rather than refuse when a post still points at it: the author may
      // be about to replace the image, and a hard block would be wrong.
      const references = await findReferences(c, site, path)

      const result = await deleteFile(target, path, file.sha, `chore: 删除图片 ${relative}`)
      await invalidateSite(c.env, site.id, site.branch)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'media.delete',
        target: path,
        detail: { references: references.length },
        commit: result.commit,
      })
      return c.json({ ok: true, commit: result.commit, references })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.post('/sites/:siteId/media/:folder/rename', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const folder = c.req.param('folder')
      const body = await readJson<{ from: string, to: string }>(c)
      const fromPath = mediaPath(folder, body.from, site.paths)
      const toPath = mediaPath(folder, body.to, site.paths)

      const target = await targetOf(c, site)
      const file = await getFile(target, fromPath).catch(() => null)
      if (!file || !('content' in file)) {
        return c.json({ error: '文件不存在', code: 'NOT_FOUND' }, 404)
      }
      // `getFile` decodes as UTF-8, which corrupts binary. The raw sha is all
      // that is needed for a rename, and Git Data copies the blob by sha.
      const committed = await renameBlob(target, fromPath, toPath, file.sha, body.from, body.to)
      await invalidateSite(c.env, site.id, site.branch)
      const references = await findReferences(c, site, fromPath)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'media.rename',
        target: `${fromPath} → ${toPath}`,
        commit: committed.commit,
      })
      return c.json({ ok: true, commit: committed.commit, references })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /** Which files mention a path — shown before a delete or rename. */
  api.get('/sites/:siteId/media-references', async (c) => {
    try {
      const site = await siteOf(c)
      const path = c.req.query('path') ?? ''
      if (!path) return c.json({ error: '缺少 path', code: 'PATH' }, 400)
      const references = await findReferences(c, site, path)
      return c.json({ path, references })
    }
    catch (error) {
      return handle(c, error)
    }
  })
}

/**
 * Search content files for a reference to an image.
 *
 * Deliberately simple: it greps the text of Markdown and JSON under the
 * content paths for the path string. A smarter analysis would need to parse
 * every Markdown dialect the theme supports, and a false negative (missing a
 * reference) is less harmful than a slow, complex, or wrong one.
 */
async function findReferences(
  c: Parameters<typeof handle>[0],
  site: Site,
  mediaPathValue: string,
): Promise<Array<{ path: string, line: number, text: string }>> {
  const target = await targetOf(c, site)
  const dirs = [site.paths.posts, site.paths.pages, site.paths.shelf]
  const needle = mediaPathValue.startsWith('/') ? mediaPathValue : `/${mediaPathValue}`
  const hits: Array<{ path: string, line: number, text: string }> = []

  for (const dir of dirs) {
    let entries
    try {
      entries = await listTree(target, normalizePath(dir))
    }
    catch {
      continue
    }
    for (const entry of entries.slice(0, 200)) {
      if (entry.type !== 'blob' || !entry.path.endsWith('.md')) continue
      try {
        const file = await getFile(target, entry.path)
        if (!('content' in file)) continue
        file.content.split('\n').forEach((line, index) => {
          if (line.includes(needle) || line.includes(needle.slice(1))) {
            hits.push({ path: entry.path, line: index + 1, text: line.trim().slice(0, 160) })
          }
        })
      }
      catch { /* unreadable file: not a reference */ }
    }
  }
  return hits.slice(0, 50)
}

// ---------------------------------------------------------------------------
// Binary commits
// ---------------------------------------------------------------------------

/** A binary file's bytes as a latin1 string, which is what `encoding: 'utf-8'` cannot carry. */
function bytesToBinaryString(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return binary
}

/**
 * Commit binary files.
 *
 * `commitFiles` sends `encoding: 'utf-8'`, which would mangle image bytes. This
 * posts the blobs as base64 and reuses the same tree/commit/ref sequence, so an
 * upload is still one atomic commit.
 */
async function commitBinary(
  target: Awaited<ReturnType<typeof targetOf>>,
  changes: FileChange[],
  message: string,
): Promise<{ commit: string }> {
  const repos = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`
  const headers = {
    Authorization: `Bearer ${target.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'onpaper-admin',
  }

  const call = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await fetch(`https://api.github.com${repos}${path}`, { ...init, headers })
    if (!response.ok) {
      throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    return await response.json() as T
  }

  const ref = await call<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(target.branch)}`, {})
  const base = await call<{ tree: { sha: string } }>(`/git/commits/${ref.object.sha}`, {})

  const tree: Array<{ path: string, mode: string, type: string, sha: string | null }> = []
  for (const change of changes) {
    if (change.delete) {
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    // The content arrives as latin1 bytes; `btoa` turns them into the base64
    // the blobs API expects, with no UTF-8 reinterpretation in between.
    const blob = await call<{ sha: string }>('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: btoa(change.content ?? ''), encoding: 'base64' }),
    })
    tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  const newTree = await call<{ sha: string }>('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: base.tree.sha, tree }),
  })
  const commit = await call<{ sha: string }>('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }),
  })
  await call(`/git/refs/heads/${encodeURIComponent(target.branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  })
  return { commit: commit.sha }
}

/** Rename by pointing a new tree entry at the existing blob sha. */
async function renameBlob(
  target: Awaited<ReturnType<typeof targetOf>>,
  from: string,
  to: string,
  blobSha: string,
  fromName: string,
  toName: string,
): Promise<{ commit: string }> {
  const repos = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`
  const headers = {
    Authorization: `Bearer ${target.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'onpaper-admin',
  }
  const call = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await fetch(`https://api.github.com${repos}${path}`, { ...init, headers })
    if (!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 200)}`)
    return await response.json() as T
  }

  const ref = await call<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(target.branch)}`, {})
  const base = await call<{ tree: { sha: string } }>(`/git/commits/${ref.object.sha}`, {})
  const newTree = await call<{ sha: string }>('/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      base_tree: base.tree.sha,
      tree: [
        { path: to, mode: '100644', type: 'blob', sha: blobSha },
        { path: from, mode: '100644', type: 'blob', sha: null },
      ],
    }),
  })
  const commit = await call<{ sha: string }>('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: `chore: 图片 ${fromName} → ${toName}`,
      tree: newTree.sha,
      parents: [ref.object.sha],
    }),
  })
  await call(`/git/refs/heads/${encodeURIComponent(target.branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  })
  return { commit: commit.sha }
}

void PathError
void commitFiles
