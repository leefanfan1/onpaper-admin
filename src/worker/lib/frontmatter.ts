/**
 * Post frontmatter — read and write the block src/content.config.ts validates.
 *
 * The site's schema is:
 *
 *   title: z.string()
 *   description: z.string().default('')
 *   published: z.coerce.date()
 *   updated: z.coerce.date().optional()
 *   tags: z.array(z.string()).default([])
 *   pin: z.number().int().min(0).max(99).default(0)
 *   draft: z.boolean().default(false)
 *
 * `scripts/new-post.mjs` writes that shape by hand, and its `yamlScalar` rules
 * are reproduced here so a post the panel creates is byte-for-byte the kind of
 * file `npm run new` would have written. Reading is deliberately lenient — the
 * author may have quotes, comments or block scalars — but writing is
 * conservative: only the keys above, only the value forms below.
 */

export interface PostFrontmatter {
  title: string
  description: string
  published: string
  updated?: string
  tags: string[]
  pin: number
  draft: boolean
  /**
   * The language this post is written in.
   *
   * A newer theme adds `lang: 'zh' | 'en'` to the schema, and the honest way to
   * handle it is to model it: left in `extra` the panel would preserve it but
   * could never show or set it, and an English post edited on a Chinese screen
   * would keep whatever it said. `undefined` means the file has no line, and
   * then nothing is written — an older theme would reject the key.
   */
  lang?: string
}

/** The placeholder tag `npm run new` writes when the author gives none. */
export const PLACEHOLDER_TAG = '_未分类'

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

export interface ParsedPost {
  frontmatter: PostFrontmatter
  body: string
  /** The raw frontmatter text between the two `---` lines. */
  raw: string
  /** Unknown keys, kept so a rewrite does not silently drop them. */
  extra: Record<string, string>
}

const DELIMITER_RE = /^---[ \t]*$/

/**
 * Split a post into frontmatter and body.
 *
 * A file that does not start with `---` is a body with no frontmatter — the
 * site's schema would reject it, but reading it that way lets the editor show
 * and repair it rather than refusing to open the file.
 */
export function splitFrontmatter(text: string): { raw: string, body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return { raw: '', body: text }
  }
  const lines = normalized.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (DELIMITER_RE.test(lines[i])) {
      return {
        raw: lines.slice(1, i).join('\n'),
        // The body starts right after the closing fence, including the blank
        // line the format puts there. Stripping it made an unchanged save
        // remove that line — one of the "why did this file change" diffs.
        body: lines.slice(i + 1).join('\n'),
      }
    }
  }
  throw new FrontmatterError('frontmatter 没有闭合的 --- 分隔线')
}

/** Strip one layer of matching quotes, and undo the escapes we write. */
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

/** `key: value` at the top level; indented lines belong to a block or list. */
const KEY_RE = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/

/**
 * Parse the frontmatter block.
 *
 * Handles the two shapes the theme's files use — scalars and a block list for
 * `tags` — plus `[a, b]` flow lists and quoted scalars, which an author who
 * edits by hand may write. A block scalar (`|` or `>`) is kept as its lines
 * joined by newlines rather than run through a YAML parser, because the panel
 * only ever writes scalars.
 */
export function parseFrontmatter(raw: string): { values: Record<string, string>, extra: Record<string, string>, tags: string[] } {
  const lines = raw.split('\n')
  const values: Record<string, string> = {}
  const extra: Record<string, string> = {}
  let tags: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = line.match(KEY_RE)
    if (!match) continue
    const key = match[1]
    const rest = match[2]

    // A block list: subsequent `- item` lines belong to this key.
    if (!rest.trim()) {
      const items: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const item = lines[j].match(/^\s*-\s+(.*)$/)
        if (!item) break
        items.push(unquote(item[1]))
        j++
      }
      if (items.length) {
        if (key === 'tags') tags = items
        else extra[key] = items.join('\n')
        i = j - 1
        continue
      }
      // A block scalar: `|` or `>` on the key line.
      if (/^[|>][+-]?\s*$/.test(rest)) {
        const collected: string[] = []
        let j = i + 1
        while (j < lines.length && (/^\s{1,}/.test(lines[j]) || !lines[j].trim())) {
          collected.push(lines[j].replace(/^\s{2}/, ''))
          j++
        }
        while (collected.length && !collected.at(-1)?.trim()) collected.pop()
        if (key === 'description') values[key] = collected.join(rest.startsWith('>') ? ' ' : '\n')
        else extra[key] = collected.join('\n')
        i = j - 1
        continue
      }
      values[key] = ''
      continue
    }

    // A flow list: `tags: [a, b]`.
    if (rest.trim().startsWith('[') && rest.trim().endsWith(']')) {
      const inner = rest.trim().slice(1, -1)
      const items = splitFlowList(inner)
      if (key === 'tags') tags = items
      else extra[key] = inner
      continue
    }

    const value = unquote(rest)
    if (key === 'tags') {
      // `tags: 随笔` is not what the schema wants, but read it rather than lose it.
      if (value) tags = [value]
      continue
    }
    if (['title', 'description', 'published', 'updated', 'pin', 'draft', 'lang'].includes(key)) {
      values[key] = value
    }
    else {
      extra[key] = value
    }
  }

  return { values, extra, tags }
}

function splitFlowList(inner: string): string[] {
  const items: string[] = []
  let current = ''
  let quote = ''
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === ',') { if (current.trim()) items.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim()) items.push(current.trim())
  return items
}

/**
 * The post's validated frontmatter.
 *
 * `published` keeps whatever the author wrote as a string: the schema coerces
 * it with `z.coerce.date()`, and rewriting `2026-11-07` into a full timestamp
 * would change the file for no reason.
 */
export function parsePost(text: string): ParsedPost {
  const { raw, body } = splitFrontmatter(text)
  const { values, extra, tags } = parseFrontmatter(raw)

  const title = values.title?.trim() ?? ''
  if (!title) throw new FrontmatterError('缺少 title')
  const published = values.published?.trim() ?? ''
  if (!published) throw new FrontmatterError('缺少 published')

  const pinRaw = values.pin?.trim() ?? ''
  const pin = pinRaw ? Number.parseInt(pinRaw, 10) : 0
  if (!Number.isFinite(pin) || pin < 0 || pin > 99) {
    throw new FrontmatterError('pin 必须是 0 到 99 的整数')
  }

  return {
    frontmatter: {
      title,
      description: values.description ?? '',
      published,
      ...(values.updated ? { updated: values.updated } : {}),
      tags: tags.filter(tag => tag.trim() !== ''),
      pin,
      draft: /^(true|yes|on)$/i.test(values.draft ?? ''),
      ...(values.lang ? { lang: values.lang } : {}),
    },
    // The editor shows the body without the blank line the format puts after
    // the fence. The raw line is preserved by `rewritePost`, which reads the
    // file itself — so this trimming cannot lose it.
    body: body.replace(/^\n+/, ''),
    raw,
    // `lang` is modelled now, so it must not also travel in `extra` — the
    // rewrite would otherwise write the key twice.
    extra: Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'lang')),
  }
}

/** The scalar quoting rules from scripts/new-post.mjs, reproduced exactly. */
/**
 * Quote a value only when YAML would read it as something other than the text.
 *
 * The earlier rule was a narrow allow-list (`\w`, CJK, a few punctuation
 * marks), so ordinary Chinese prose containing `！`, `—`, `：` or `·` came back
 * quoted — a change the author never made. The list of characters that actually
 * need quoting in YAML is short: a leading indicator, a colon-space, a ` #`,
 * or a value that would parse as another type.
 */
export function yamlScalar(value: string): string {
  const text = String(value ?? '').trim()
  if (!text) return "''"

  // A bare value that YAML would coerce to a boolean, null or number.
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(text)) return `"${text}"`
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) return `"${text}"`
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return `"${text}"`

  // Structural characters: these only matter in certain positions, and being
  // conservative about the positions keeps prose unquoted.
  const needsQuotes =
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(text)      // a leading indicator
    || /:\s/.test(text)                        // a colon that could start a map
    || /\s#/.test(text)                        // an inline comment
    || /:$/.test(text)                         // a trailing colon
    || /[\n\r\t]/.test(text)                   // a line break or tab

  if (!needsQuotes) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Emit the block style `npm run new` uses, so both paths produce one shape. */
export function serializeFrontmatter(fm: PostFrontmatter, extra: Record<string, string> = {}): string {
  const tags = fm.tags.length ? fm.tags : [PLACEHOLDER_TAG]
  const lines = [
    '---',
    `title: ${yamlScalar(fm.title)}`,
    `description: ${yamlScalar(fm.description)}`,
    `published: ${fm.published}`,
  ]
  if (fm.updated) lines.push(`updated: ${fm.updated}`)
  lines.push('tags:', ...tags.map(tag => `  - ${yamlScalar(tag)}`), `pin: ${fm.pin}`)
  if (fm.draft) lines.push('draft: true')

  // Keys the panel does not model, in their original order, so an author's own
  // field survives a save through the form.
  for (const [key, value] of Object.entries(extra)) {
    if (value.includes('\n')) {
      lines.push(`${key}: |`, ...value.split('\n').map(line => `  ${line}`))
    }
    else {
      lines.push(`${key}: ${yamlScalar(value)}`)
    }
  }

  lines.push('---', '')
  return lines.join('\n')
}

/** A new post, matching what `npm run new <slug>` writes. */
export function newPostContent(slug: string, options: Partial<PostFrontmatter> = {}, today = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`
  const humanized = slug
    .split('-')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

  const frontmatter = serializeFrontmatter({
    title: options.title?.trim() || humanized,
    description: options.description ?? '',
    published: options.published ?? date,
    ...(options.updated ? { updated: options.updated } : {}),
    tags: options.tags ?? [],
    pin: options.pin ?? 0,
    draft: options.draft ?? false,
  })

  return `${frontmatter}\n在这里开始写正文。\n`
}

/** Merge new frontmatter into a file, preserving the body and line endings. */
/**
 * Save a post by editing the front matter it already has.
 *
 * The earlier version rebuilt the whole block from the panel's model. That is
 * the version that, on a real post, added quotes around a Chinese title, moved
 * `description` above `published`, dropped `draft: false`, turned `toc: true`
 * into `toc: "true"`, and lost a line of the body. Every one of those is a write
 * a person did not ask for.
 *
 * So this does what a careful edit does instead: keep every original line, and
 * rewrite only the values that differ. A key the panel models is replaced in
 * place; a key it does not model — `toc`, `abbrlink`, anything the author added
 * — is never touched, because it is never read into the model. A key that is
 * absent is inserted in the theme's documented order.
 */
/**
 * Rebuild a post from its front matter and a body.
 *
 * `body` is the editor's text, which the panel trims of the blank line the
 * format puts after the fence — so writing it back means restoring that blank
 * line, and preserving whether the file ended with a newline. Both matter: the
 * first because a file without it does not match what `npm run new` writes, the
 * second because dropping it shows up as a deleted line on every save.
 *
 * An earlier version ignored the `body` argument entirely and wrote the file's
 * original body back, which meant the editor's changes were silently discarded.
 */
export function rewritePost(original: string, fm: PostFrontmatter, extra: Record<string, string> = {}, body?: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const { raw, body: originalBody } = splitFrontmatter(original)
  void extra

  const lines = raw === '' ? [] : raw.split('\n')
  const rendered = applyToLines(lines, fm)

  // The body to write: the caller's when given, otherwise the file's own.
  const source = body === undefined ? originalBody : body.replace(/^\n+/, '')

  // The file's trailing-newline habit is a property of the file, not of the
  // edit: a file that ended with a newline keeps ending with one.
  const hadTrailingNewline = /\n$/.test(originalBody)
  const trailing = hadTrailingNewline && !/\n$/.test(source) ? '\n' : ''

  /*
   * The gap between the closing fence and the first line.

   * Files in the wild have either `---\n正文` or `---\n\n正文` — the theme's
   * `npm run new` writes the blank line, hand-edited files often do not — and
   * re-emitting one shape over the other showed up as a deleted line on every
   * save of half the posts.
   *
   * `splitFrontmatter` gives the body starting after the closing `---` line's
   * own newline, so a body of "\n正文" has one blank line. The fence is joined
   * without a trailing newline, so that newline is added here: `+1`.
   */
  const originalGap = (originalBody.match(/^\n*/)?.[0] ?? '').length
  const gap = source === '' ? '' : '\n'.repeat(originalGap + 1)
  const renderedText = ['---', ...rendered, '---'].join('\n')
    + gap
    + source
    + trailing

  return eol === '\r\n' ? renderedText.replace(/\n/g, '\r\n') : renderedText
}

/** The front matter keys the panel edits, in the theme's own order. */
const MODELED: Array<{ key: keyof PostFrontmatter | 'tags', render: (fm: PostFrontmatter) => string[] }> = [
  { key: 'title', render: fm => [`title: ${yamlScalar(fm.title)}`] },
  { key: 'description', render: fm => [`description: ${yamlScalar(fm.description)}`] },
  { key: 'published', render: fm => [`published: ${fm.published}`] },
  { key: 'updated', render: fm => (fm.updated ? [`updated: ${fm.updated}`] : []) },
  {
    key: 'tags',
    render: fm => {
      const tags = fm.tags.length ? fm.tags : [PLACEHOLDER_TAG]
      return ['tags:', ...tags.map(tag => `  - ${yamlScalar(tag)}`)]
    },
  },
  { key: 'pin', render: fm => [`pin: ${fm.pin}`] },
  // `draft: false` is a value, not an absence: a post that says so is
  // published, and flipping it back must write `false` rather than delete the
  // key (which would silently mean "false" but lose the author's line).
  { key: 'draft', render: fm => [`draft: ${fm.draft ? 'true' : 'false'}`] },
  // Ordered last, and never added to a file that does not already have it: the
  // key only exists in a newer theme's schema, and an older one would reject it.
  { key: 'lang' as keyof PostFrontmatter, render: fm => (fm.lang ? [`lang: ${fm.lang}`] : []) },
]

/**
 * Rewrite the modelled keys in an existing front matter block.
 *
 * The rule, in one sentence: a key the author wrote keeps its line unless its
 * value actually changed, and a key the author did not write is not added
 * unless the panel is setting it to something.
 *
 * That is stricter than "render the model" on purpose. On a real post, an
 * unchanged save used to add `description: ''` to a file that had none, delete
 * `draft: false` because false is the default, and drop `toc` / `abbrlink` /
 * `lang` because the model does not know them. Each of those is a write nobody
 * asked for, and together they are how a panel corrupts a site slowly.
 */
function applyToLines(lines: string[], fm: PostFrontmatter): string[] {
  const result = [...lines]

  for (const entry of MODELED) {
    const name = String(entry.key)
    const index = result.findIndex(line => keyOfLine(line) === name)

    if (index === -1) {
      // Absent from the file. Add it only when the value is meaningful: an
      // empty description, a pin of 0, or a draft flag that is false are the
      // defaults, and writing them adds a line the author never wrote.
      if (!isMeaningful(name, fm)) continue
      const at = insertionPoint(result, name)
      result.splice(at, 0, ...entry.render(fm))
      continue
    }

    let end = index + 1
    if (name === 'tags') {
      while (end < result.length && /^\s*-\s/.test(result[end])) end++
    }

    // Present. Leave it alone when the value did not change — including its
    // quoting, which is the author's.
    if (name !== 'tags' && sameValue(name, result[index], fm)) continue

    result.splice(index, end - index, ...entry.render(fm))
  }

  return result
}

/** Whether an absent key should be written at all. */
function isMeaningful(name: string, fm: PostFrontmatter): boolean {
  switch (name) {
    // Never add a `lang` line to a file that has none — see MODELED.
    case 'lang': return false
    case 'description': return fm.description.trim() !== ''
    case 'updated': return Boolean(fm.updated)
    case 'tags': return fm.tags.length > 0
    case 'pin': return fm.pin !== 0
    case 'draft': return fm.draft
    default: return true
  }
}

/**
 * Whether a present line already holds this value, quoting aside.
 *
 * `draft` is the one key whose false is a value rather than an absence: a post
 * that says `draft: false` means published, and the panel must not delete the
 * line just because false is also the default.
 */
function sameValue(name: string, line: string, fm: PostFrontmatter): boolean {
  const current = valueOfLine(line)
  const next = String(
    name === 'title' ? fm.title
      : name === 'description' ? fm.description
        : name === 'published' ? fm.published
          : name === 'updated' ? (fm.updated ?? '')
            : name === 'pin' ? fm.pin
              : name === 'lang' ? (fm.lang ?? '')
                : fm.draft ? 'true' : 'false',
  ).trim()
  // A boolean written as `yes`/`on` is the same value as `true`.
  if (name === 'draft') {
    const truthy = (value: string): boolean => /^(true|yes|on|1)$/i.test(value)
    return truthy(current) === truthy(next)
  }
  return current === next
}

/** The key a front matter line declares, or '' when it is not a `key: value`. */
function keyOfLine(line: string): string {
  const match = line.match(/^([A-Za-z_][\w-]*)\s*:/)
  return match ? match[1] : ''
}

/** A line's value with its quoting removed, for comparison only. */
function valueOfLine(line: string): string {
  const match = line.match(/^[A-Za-z_][\w-]*\s*:\s*(.*?)\s*$/)
  if (!match) return ''
  const raw = match[1]
  if (raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
    return raw.slice(1, -1)
  }
  return raw
}

/** Where a missing key goes: before the first modelled key that sorts after it. */
function insertionPoint(lines: string[], key: string): number {
  const order = ['title', 'description', 'published', 'updated', 'tags', 'pin', 'draft', 'lang']
  const rank = order.indexOf(key)
  for (let i = 0; i < lines.length; i++) {
    const existing = keyOfLine(lines[i])
    if (!existing) continue
    const existingRank = order.indexOf(existing)
    // An unmodelled key (`toc`, `abbrlink`) sorts last: the panel's keys stay
    // together and ahead of anything the author added.
    if (existingRank === -1 || existingRank > rank) return i
  }
  return lines.length
}

/** Word count, the way the site counts it: CJK characters plus Latin words. */
export function countWords(body: string): number {
  const stripped = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const cjk = stripped.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g)?.length ?? 0
  const latin = stripped
    .replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, ' ')
    .match(/[A-Za-z0-9][\w'’-]*/g)?.length ?? 0
  return cjk + latin
}

/** A rough reading time, at 300 CJK characters per minute. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 300))
}
