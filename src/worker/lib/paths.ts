/**
 * Path rules for everything the panel writes to a site's repository.
 *
 * The panel is a remote write entry point into someone's repo. The difference
 * between "edit a post" and "remote code execution" is one writable path:
 *
 *   - `package.json` carries install scripts. Writing it is `postinstall` on
 *     the next build.
 *   - `.github/workflows/*` runs with the repo's secrets in CI.
 *
 * So this module is an allowlist, not a denylist: only paths that a panel
 * feature actually needs are accepted, and everything else is refused by not
 * being on the list. A denylist would have to predict every dangerous path;
 * an allowlist only has to know what the panel does.
 */

/** The content kinds the panel edits, and where each lives by default. */
export type PathKind =
  | 'post'
  | 'page'
  | 'shelf'
  | 'data'
  | 'config'
  | 'image'
  | 'shelf-cover'
  | 'music-cover'
  | 'og-image'
  | 'og-source'
  | 'workflow'

export interface SitePaths {
  posts: string
  pages: string
  shelf: string
  data: string
  config: string
  public: string
}

export const DEFAULT_PATHS: SitePaths = {
  posts: 'src/content/posts',
  pages: 'src/content/pages',
  shelf: 'src/content/shelf',
  data: 'src/data',
  config: 'src/config.ts',
  public: 'public',
}

/** Characters that must never reach a Git tree path. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001F\u007F\\]/

/** Segments Windows and Git treat specially. */
const RESERVED_SEGMENTS = new Set([
  '.', '..', '.git', '.github', 'node_modules', '.astro', 'dist',
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

export class PathError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PathError'
    this.code = code
  }
}

/**
 * Normalise a caller-supplied path into `a/b/c.ext`, or throw.
 *
 * Percent-encoding is decoded once before inspection: `%2e%2e/` decodes to
 * `../`, and a check that runs before decoding misses it. Decoding twice is
 * also wrong — `%252e` would become `.` and reject a legitimate name — so one
 * pass, then the decoded value is what the rest of the check sees.
 */
export function normalizePath(input: string): string {
  if (typeof input !== 'string' || !input) {
    throw new PathError('PATH_EMPTY', '路径不能为空')
  }
  if (input.length > 512) {
    throw new PathError('PATH_TOO_LONG', '路径过长')
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(input)
  }
  catch {
    // A stray `%` is a malformed path, not an escape hatch.
    throw new PathError('PATH_ENCODING', '路径包含无效的百分号编码')
  }

  if (FORBIDDEN_CHARS.test(decoded)) {
    throw new PathError('PATH_CHARS', '路径包含非法字符')
  }
  if (decoded.startsWith('/') || decoded.startsWith('~')) {
    throw new PathError('PATH_ABSOLUTE', '路径必须是仓库内的相对路径')
  }
  if (!decoded.trim()) {
    throw new PathError('PATH_EMPTY', '路径不能为空')
  }
  // `a//b` and `a/./b` are the same file as `a/b`; normalise rather than reject,
  // so a caller assembling paths with joins cannot accidentally bypass a check.
  const segments = decoded.split('/').filter(segment => segment !== '' && segment !== '.')
  if (!segments.length) {
    throw new PathError('PATH_EMPTY', '路径不能为空')
  }
  for (const segment of segments) {
    if (segment === '..') {
      throw new PathError('PATH_TRAVERSAL', '路径不能包含 ..')
    }
    // Windows reserves the *stem*: `CON.md` is as unusable as `CON`, because
    // the device name is matched before the extension.
    const stem = segment.split('.')[0].toUpperCase()
    if (RESERVED_SEGMENTS.has(segment.toUpperCase()) || RESERVED_SEGMENTS.has(stem)) {
      throw new PathError('PATH_RESERVED', `路径不能包含保留名 ${segment}`)
    }
    // A trailing dot or space is silently stripped by Windows, which turns
    // `config.ts.` into `config.ts` on checkout but not in the tree.
    if (/[. ]$/.test(segment)) {
      throw new PathError('PATH_RESERVED', '路径段不能以点或空格结尾')
    }
  }

  return segments.join('/')
}

function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`)
}

/**
 * Whether a normalised path may be written, and as which kind.
 *
 * The `kind` is what the audit log records and what the caller uses to decide
 * how to validate content; the path is never reinterpreted after this.
 */
export function classifyPath(rawPath: string, paths: SitePaths = DEFAULT_PATHS): PathKind {
  const path = normalizePath(rawPath)

  // The one file outside a content directory: the site's single config entry.
  if (path === normalizePath(paths.config)) return 'config'

  if (isUnder(path, normalizePath(paths.posts)) && path.endsWith('.md')) return 'post'
  if (isUnder(path, normalizePath(paths.pages)) && path.endsWith('.md')) return 'page'
  if (isUnder(path, normalizePath(paths.shelf)) && path.endsWith('.md')) return 'shelf'
  if (isUnder(path, normalizePath(paths.data)) && path.endsWith('.json')) return 'data'

  const pub = normalizePath(paths.public)
  if (path === `${pub}/og.svg`) return 'og-source'
  // Media folders hold raster images only. SVG is deliberately excluded: it can
  // carry script, and these paths are served to readers on the public site.
  const isRaster = /\.(png|jpg|jpeg|webp|avif)$/i.test(path)
  if (isUnder(path, `${pub}/images`)) {
    if (!isRaster) throw new PathError('PATH_MEDIA', '图片目录只接受 png、jpg、webp、avif')
    return 'image'
  }
  if (isUnder(path, `${pub}/shelf`)) {
    if (!isRaster) throw new PathError('PATH_MEDIA', '封面目录只接受 png、jpg、webp、avif')
    return 'shelf-cover'
  }
  if (isUnder(path, `${pub}/music`)) {
    if (!isRaster) throw new PathError('PATH_MEDIA', '封面目录只接受 png、jpg、webp、avif')
    return 'music-cover'
  }
  if (isUnder(path, `${pub}/og`)) {
    if (!isRaster) throw new PathError('PATH_MEDIA', 'OG 目录只接受 png、jpg、webp、avif')
    return 'og-image'
  }

  throw new PathError('PATH_FORBIDDEN', `不允许写入 ${path}`)
}

/** The workflow the panel installs for its task channel — a privileged, exact write. */
export const TASK_WORKFLOW_PATH = '.github/workflows/admin-task.yml'

/**
 * Image extensions the media library accepts. SVG is absent on purpose:
 * an SVG can carry script, and the panel serves what it stores.
 */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'avif'] as const

/** Media folders the library offers, as paths relative to `public/`. */
export const MEDIA_FOLDERS = ['images', 'shelf', 'music', 'og'] as const

export type MediaFolder = (typeof MEDIA_FOLDERS)[number]

/** Where an uploaded file may land: `<folder>/<safe name>.<allowed ext>`. */
export function mediaPath(folder: string, filename: string, paths: SitePaths = DEFAULT_PATHS): string {
  if (!MEDIA_FOLDERS.includes(folder as MediaFolder)) {
    throw new PathError('MEDIA_FOLDER', `未知的媒体目录 ${folder}`)
  }
  const name = normalizePath(filename)
  if (name.includes('/')) {
    throw new PathError('MEDIA_NAME', '文件名不能包含目录')
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (!IMAGE_EXTENSIONS.includes(ext as (typeof IMAGE_EXTENSIONS)[number])) {
    throw new PathError('MEDIA_TYPE', '只接受 png、jpg、webp、avif 图片')
  }
  // A dotfile such as `.htaccess` has no stem; the panel would be writing a
  // config file into a media folder.
  if (!name.slice(0, -(ext.length + 1)).trim()) {
    throw new PathError('MEDIA_NAME', '文件名不能为空')
  }
  return normalizePath(`${paths.public}/${folder}/${name}`)
}

/** A slug is the file name of a post, and the post's URL. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value)
}

export function assertSlug(value: string): string {
  if (!isSlug(value)) {
    throw new PathError('SLUG', '网址只能用小写英文、数字和连字符，且以字母或数字开头')
  }
  return value
}
