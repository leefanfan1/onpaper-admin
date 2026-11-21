/**
 * Read a `.md` file the author is importing.
 *
 * This is the browser-side reader, and it is deliberately forgiving: the file
 * may have been written by another editor, exported from a different blog, or
 * hand-typed. A strict parser would refuse it and leave the author with nothing,
 * so a file with unreadable front matter still loads — the body arrives in the
 * editor and the missing fields are the author's to fill.
 *
 * The *server* is where the strict rules live: it re-parses what it is given
 * with the same rules the site's schema applies, and refuses a value that would
 * break the build. Being lenient here does not loosen that.
 */

export interface ImportedPost {
  frontmatter: {
    title: string
    description: string
    published: string
    updated?: string
    tags: string[]
    pin: number
    draft: boolean
    /** The post's own language, when the uploaded file declares one. */
    lang?: string
  }
  body: string
  slug: string
  /** A message for the author when something had to be guessed. */
  warning?: string
}

/** A slug from a file name, the same rules `npm run new` uses. */
export function slugFromFilename(filename: string): string {
  return filename
    .replace(/\.(md|markdown|mdx)$/i, '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function unquote(value: string): string {
  const text = value.trim()
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  return text
}

function humanize(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Parse a file into the editor's fields.
 *
 * Handles the two front matter shapes an author is likely to arrive with: a
 * `key: value` block with a `- item` list, and the same with flow lists. A file
 * with no front matter at all is treated as a body, with the title guessed from
 * the file name — which is what someone dropping a plain `.md` in expects.
 */
export function parseFrontmatterFile(text: string, filename: string): ImportedPost {
  const normalized = text.replace(/\r\n/g, '\n')
  const slug = slugFromFilename(filename) || 'untitled'

  const fallbackTitle = humanize(slug) || filename.replace(/\.\w+$/, '')

  if (!normalized.startsWith('---\n')) {
    return {
      frontmatter: {
        title: fallbackTitle,
        description: '',
        published: '',
        tags: [],
        pin: 0,
        draft: false,
      },
      body: normalized,
      slug,
      warning: '这个文件没有 front matter，标题取自文件名，发布日期需要用今天。',
    }
  }

  const close = normalized.indexOf('\n---', 4)
  if (close === -1) {
    return {
      frontmatter: {
        title: fallbackTitle,
        description: '',
        published: '',
        tags: [],
        pin: 0,
        draft: false,
      },
      body: normalized,
      slug,
      warning: 'front matter 没有闭合的 ---，已按正文载入。',
    }
  }

  const raw = normalized.slice(4, close)
  const body = normalized.slice(close + 4).replace(/^\n+/, '')

  const values: Record<string, string> = {}
  const tags: string[] = []
  let extraTags = ''

  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    const rest = match[2]

    if (!rest.trim()) {
      // A block list: the following `- item` lines belong to this key.
      const items: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const item = lines[j].match(/^\s*-\s+(.*)$/)
        if (!item) break
        items.push(unquote(item[1]))
        j++
      }
      if (items.length) {
        if (key === 'tags') tags.push(...items)
        else values[key] = items.join('\n')
        i = j - 1
        continue
      }
      values[key] = ''
      continue
    }

    if (rest.trim().startsWith('[') && rest.trim().endsWith(']')) {
      const inner = rest.trim().slice(1, -1)
      const items = inner.split(',').map(unquote).filter(Boolean)
      if (key === 'tags') tags.push(...items)
      else values[key] = items.join(', ')
      continue
    }

    if (key === 'tags') {
      extraTags = unquote(rest)
      continue
    }
    values[key] = unquote(rest)
  }

  // `tags: a, b` on one line, or `tags: a` — both appear in the wild.
  if (extraTags) tags.push(...extraTags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))

  const pin = Number.parseInt(values.pin ?? '0', 10)
  const warnings: string[] = []
  if (!values.title) warnings.push('缺少 title')
  if (!values.published) warnings.push('缺少 published')

  return {
    frontmatter: {
      title: values.title || fallbackTitle,
      description: values.description ?? '',
      // The schema coerces a date; an empty one must be filled before creating.
      published: values.published ?? '',
      ...(values.updated ? { updated: values.updated } : {}),
      tags: tags.filter(tag => tag.trim() !== ''),
      pin: Number.isFinite(pin) ? pin : 0,
      draft: /^(true|yes|on)$/i.test(values.draft ?? ''),
      ...(values.lang ? { lang: values.lang.trim().toLowerCase() } : {}),
    },
    body,
    slug,
    ...(warnings.length
      ? { warning: `${warnings.join('、')}，已用默认值填入，创建前请确认。` }
      : {}),
  }
}
