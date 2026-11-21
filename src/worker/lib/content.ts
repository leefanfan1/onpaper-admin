/**
 * The shelf (books / films / music) and the home page's 最近 list.
 *
 * These are ports of the theme's own rules, not re-inventions:
 *
 *   scripts/shelf-document.mjs   entriesOf / rewriteDocument
 *   scripts/shelf-fields.mjs     parseEntry / updateEntry, FIELD_ORDER
 *   scripts/now-document.mjs     nowEntriesOf / rewriteNow
 *   src/utils/friends.ts         parseFriends
 *
 * The panel and `npm run covers` write the same files, so they must agree on
 * what an entry is — otherwise a save from the panel would hand the script a
 * paragraph it does not recognise, or silently lose a field it does.
 */

export type ShelfKind = 'book' | 'film' | 'music'
export type NowKind = 'book' | 'film' | 'music'

/** The order a block's fields are written in, as each file's comment documents. */
export const FIELD_ORDER: Record<ShelfKind, string[]> = {
  book: ['书名', '作者', '年份', '豆瓣', '封面', '一句话'],
  film: ['片名', '导演', '年份', '豆瓣', '封面', '一句话'],
  music: ['名称', '歌手', '年份', '链接', '豆瓣', '封面', '一句话'],
}

const TITLE_KEYS: Record<ShelfKind, string[]> = {
  book: ['书名', 'title'],
  film: ['片名', '电影', 'title'],
  music: ['名称', '专辑', '歌曲', 'title'],
}

const CREATOR_KEYS: Record<ShelfKind, string[]> = {
  book: ['作者', 'author'],
  film: ['导演', '主演', 'director'],
  music: ['歌手', '作者', 'artist'],
}

const LINE_RE = /^(\s*([^：:]{1,8})\s*[：:]\s*)(.+?)(\s*)$/

export interface ShelfEntry {
  kind: ShelfKind
  title: string
  creator: string
  year: string
  note: string
  /** The Douban page (books and films) or the record's reference page. */
  douban: string
  /** A record's player address. */
  link: string
  /** A `封面：` line the author wrote. */
  cover: string
  /** Every field, in file order, so the form can show what it does not model. */
  fields: Record<string, string>
  /** The entry's line block, as it appears in the file. */
  lines: string[]
  /** Line index of the first line in the split file. */
  start: number
}

/** The key a line declares, or '' when it is not a field line. */
export function keyOf(line: string): string {
  return line.match(LINE_RE)?.[2]?.trim() ?? ''
}

function fieldsOf(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of lines) {
    const match = line.match(LINE_RE)
    if (match) fields[match[2].trim()] = match[3].trim()
  }
  return fields
}

function firstOf(fields: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = fields[key]
    if (value) return value
  }
  return ''
}

/**
 * Whether a line sits inside an `<!-- -->` comment.
 *
 * The three shelf files open with a comment that contains a full example
 * entry — "turn every `键：值` paragraph into a record" would edit the
 * documentation as well as the list.
 */
function commentMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false)
  let inside = false
  for (let i = 0; i < lines.length; i++) {
    if (inside) {
      mask[i] = true
      if (lines[i].includes('-->')) inside = false
      continue
    }
    if (lines[i].includes('<!--')) {
      mask[i] = true
      if (!lines[i].includes('-->')) inside = true
    }
  }
  return mask
}

/** The entry paragraphs of a shelf file, skipping comments and headings. */
export function shelfEntriesOf(text: string, kind: ShelfKind): ShelfEntry[] {
  const lines = text.split(/\r\n|\n/)
  const comments = commentMask(lines)
  const found: ShelfEntry[] = []

  for (let i = 0; i < lines.length;) {
    if (comments[i] || !lines[i].trim()) { i++; continue }

    const start = i
    while (i < lines.length && !comments[i] && lines[i].trim()) i++
    const block = lines.slice(start, i)

    // A heading is a paragraph too; it names the file, not an entry.
    if (/^#{1,6}\s/.test(block[0])) continue
    const fields = fieldsOf(block)
    const title = firstOf(fields, TITLE_KEYS[kind])
    if (!title) continue

    found.push({
      kind,
      title,
      creator: firstOf(fields, CREATOR_KEYS[kind]),
      year: fields['年份'] ?? '',
      note: fields['一句话'] ?? '',
      douban: fields['豆瓣'] ?? '',
      link: fields['链接'] ?? '',
      cover: fields['封面'] ?? '',
      fields,
      lines: block,
      start,
    })
  }

  return found
}

/**
 * Build one entry's paragraph from form values.
 *
 * Fields are written in the documented order, and an empty value is not a
 * value — a field the author did not fill in is left out rather than written
 * as `作者：`. The line ending follows the file.
 */
export function serializeShelfEntry(entry: Partial<Record<string, string>>, kind: ShelfKind): string {
  const lines: string[] = []
  for (const key of FIELD_ORDER[kind]) {
    const value = String(entry[key] ?? '').trim()
    if (!value) continue
    lines.push(`${key}：${value}`)
  }
  // Any key outside the documented order keeps its place after the known ones,
  // so a field another tool wrote is not dropped.
  for (const [key, value] of Object.entries(entry)) {
    if (FIELD_ORDER[kind].includes(key)) continue
    const text = String(value ?? '').trim()
    if (!text) continue
    lines.push(`${key}：${text}`)
  }
  return lines.join('\n')
}

/**
 * Replace, insert or remove one entry in a shelf file.
 *
 * Operates on the entry's own line range so everything around it — the header
 * comment, the heading, other entries, their line endings — stays byte for
 * byte. When `original` is given, the entry is found by its current title;
 * without it the entry is appended.
 */
export function upsertShelfEntry(
  text: string,
  kind: ShelfKind,
  values: Partial<Record<string, string>>,
  original?: { title: string },
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r\n|\n/)
  const entries = shelfEntriesOf(text, kind)
  const block = serializeShelfEntry(values, kind).split('\n')

  // Find the entry this write is about: the one the caller named, or — when it
  // did not name one — the entry whose title matches. Without the second case,
  // adding a title that already existed appended a duplicate paragraph, so the
  // list showed the same work twice and `npm run covers` saw two entries with
  // one name.
  const titleKey = FIELD_ORDER[kind][0]
  const title = String(values[titleKey] ?? '').trim()
  const target = original
    ? entries.find(entry => entry.title === original.title)
    : entries.find(entry => entry.title === title)

  if (target) {
    /*
     * A key the caller did not mention keeps its stored value.
     *
     * The edit form deliberately has no cover field (the cover is `covers`'s
     * job), so it sends five keys and not 封面 — and rebuilding the paragraph
     * from only those five silently deleted a cover line the author had written
     * by hand. The rule that makes both cases work: a key that is absent means
     * "leave it", and an empty string means "remove it", which is how the form
     * already expresses a cleared field.
     */
    const merged: Record<string, string> = { ...target.fields }
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue
      merged[key] = String(value)
    }
    lines.splice(target.start, target.lines.length, ...serializeShelfEntry(merged, kind).split('\n'))
    return lines.join(eol)
  }

  // Append: after the last entry when there is one, otherwise after the last
  // non-empty line so an insertion lands inside the list and not in a comment.
  const last = entries.at(-1)
  if (last) {
    const end = last.start + last.lines.length
    lines.splice(end, 0, '', ...block)
    return lines.join(eol)
  }
  const rendered = lines.join(eol)
  return `${rendered}${rendered.endsWith(eol) ? eol : `${eol}${eol}`}${block.join(eol)}${eol}`
}

export function deleteShelfEntry(text: string, kind: ShelfKind, title: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r\n|\n/)
  const target = shelfEntriesOf(text, kind).find(entry => entry.title === title)
  if (!target) return text

  let start = target.start
  let end = start + target.lines.length
  // Take one surrounding blank line with it, so deleting does not leave a
  // double gap where the entry used to be.
  if (end < lines.length && !lines[end].trim()) end++
  else if (start > 0 && !lines[start - 1].trim()) start--

  lines.splice(start, end - start)
  return lines.join(eol)
}

// ---------------------------------------------------------------------------
// now.md — 「最近」: a label line and a credit line, not `键：值` fields.
// ---------------------------------------------------------------------------

const LABEL_KIND: Record<string, NowKind> = { 在读: 'book', 在看: 'film', 在听: 'music' }
const LINK_RE = /https?:\/\/\S+/
const REFERENCE_RE = /^\s*(年份|豆瓣|链接)\s*[：:]/
const LABEL_RE = /^([^：:]{1,4})\s*[：:]\s*(?:《(.+)》|(.+?))\s*$/

export interface NowEntry {
  kind: NowKind
  label: string
  title: string
  marked: boolean
  creator: string
  url: string
  year: string
  douban: string
  lines: string[]
  start: number
}

export function nowEntriesOf(text: string): NowEntry[] {
  const lines = text.split(/\r\n|\n/)
  const comments = commentMask(lines)
  const found: NowEntry[] = []

  for (let i = 0; i < lines.length;) {
    if (comments[i] || !lines[i].trim()) { i++; continue }
    const start = i
    while (i < lines.length && !comments[i] && lines[i].trim()) i++
    const block = lines.slice(start, i)

    const head = block[0].match(LABEL_RE)
    if (!head) continue
    const kind = LABEL_KIND[head[1].trim()]
    if (!kind) continue

    // The second line is the credit unless it is a reference line: an entry
    // holding only `年份：` predates the credit line, and reading that as the
    // creator would search Douban for an author named `年份：2012`.
    const second = block[1] ?? ''
    const credit = REFERENCE_RE.test(second) ? '' : second
    const year = block.map(line => line.match(/^\s*年份\s*[：:]\s*(.+?)\s*$/)?.[1]).find(Boolean) ?? ''
    const douban = block.map(line => line.match(/^\s*豆瓣\s*[：:]\s*(.+?)\s*$/)?.[1]).find(Boolean) ?? ''

    found.push({
      start,
      kind,
      label: head[1].trim(),
      title: (head[2] ?? head[3]).trim(),
      marked: head[2] !== undefined,
      creator: credit.replace(LINK_RE, '').trim(),
      url: credit.match(LINK_RE)?.[0] ?? '',
      year,
      douban,
      lines: block,
    })
  }

  return found
}

/**
 * Write one 「最近」 entry.
 *
 * The shape is fixed by the file and by how the column renders it: the label
 * line carries the work's name in 《》 marks, the credit line carries the
 * creator and the address the row opens, and `年份` / `豆瓣` are reference
 * lines below. A record's credit line holds its player, so its Douban page
 * gets a line of its own.
 */
export function serializeNowEntry(entry: {
  label: string
  title: string
  creator: string
  url: string
  year: string
  douban: string
}, kind: NowKind): string[] {
  const credit = [entry.creator.trim(), entry.url.trim()].filter(Boolean).join(' ')
  const lines = [`${entry.label}：《${entry.title.trim()}》`]
  if (credit) lines.push(credit)
  if (entry.year.trim()) lines.push(`年份：${entry.year.trim()}`)
  if (kind === 'music' && entry.douban.trim()) lines.push(`豆瓣：${entry.douban.trim()}`)
  return lines
}

export function upsertNowEntry(
  text: string,
  kind: NowKind,
  values: { label: string, title: string, creator: string, url: string, year: string, douban: string },
  original?: { title: string },
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r\n|\n/)
  const block = serializeNowEntry(values, kind)
  const target = original
    ? nowEntriesOf(text).find(entry => entry.title === original.title)
    : nowEntriesOf(text).find(entry => entry.kind === kind)

  if (target) {
    lines.splice(target.start, target.lines.length, ...block)
    return lines.join(eol)
  }

  const all = nowEntriesOf(text)
  const last = all.at(-1)
  if (last) {
    lines.splice(last.start + last.lines.length, 0, '', ...block)
    return lines.join(eol)
  }
  const rendered = lines.join(eol)
  return `${rendered}${rendered.endsWith(eol) ? eol : `${eol}${eol}`}${block.join(eol)}${eol}`
}

export function deleteNowEntry(text: string, title: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r\n|\n/)
  const target = nowEntriesOf(text).find(entry => entry.title === title)
  if (!target) return text
  let start = target.start
  let end = start + target.lines.length
  if (end < lines.length && !lines[end].trim()) end++
  else if (start > 0 && !lines[start - 1].trim()) start--
  lines.splice(start, end - start)
  return lines.join(eol)
}

// ---------------------------------------------------------------------------
// friends.md — name, URL, optional description; blank line between entries.
// ---------------------------------------------------------------------------

export interface FriendLink {
  name: string
  url: string
  description: string
}

export class FriendsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FriendsError'
  }
}

/** Port of src/utils/friends.ts, so the panel rejects what the build rejects. */
export function parseFriends(content: string): FriendLink[] {
  const text = content
    .replace(/\r\n?/g, '\n')
    // The theme's own parser drops comments only, because it is handed the
    // rendered body. The panel reads the whole file, so the YAML front matter
    // has to come off first — otherwise its `---` fence is read as an entry
    // whose "name" is `---`, and the URL check fails on the second fence.
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').map(line => line.trim()).join('\n')
    .trim()
  if (!text) return []

  return text.split(/\n{2,}/).map((block, index) => {
    const [name, rawUrl, ...description] = block.split('\n')
    if (!name || !rawUrl) {
      throw new FriendsError(`第 ${index + 1} 条：请依次填写名称、完整网址和简介，简介可省略。`)
    }
    let url: URL
    try { url = new URL(rawUrl) }
    catch { throw new FriendsError(`${name} 的网址不完整，请填写完整网址，例如 https://example.com/。`) }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new FriendsError(`${name} 的网址仅支持 HTTP(S) 协议。`)
    }
    return { name, url: url.href, description: description.join(' ').trim() }
  })
}

/** Replace the whole friends list, keeping the file's front matter and comments. */
export function serializeFriends(content: string, links: FriendLink[]): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const normalized = content.replace(/\r\n/g, '\n')

  // Keep the YAML front matter and any leading comment block; replace only the
  // entries, which start after the last of them.
  const front = normalized.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? ''
  const rest = normalized.slice(front.length)
  const leadingComments = rest.match(/^(?:\s*<!--[\s\S]*?-->\s*)+/)?.[0] ?? ''

  /*
   * Everything before the first entry, exactly as the file had it.
   *
   * When there is a comment, the comment match already carries the blank line
   * that followed it. When there is none, that blank line lives at the start of
   * `rest` and has to be kept — leaving it out made an unchanged list lose a
   * line on every save.
   */
  const head = leadingComments
    ? `${front}${leadingComments}`
    : `${front}${rest.match(/^\n*/)?.[0] ?? ''}`

  const body = links
    .map(link => [link.name, link.url, ...(link.description ? [link.description] : [])].join('\n'))
    .join('\n\n')

  // `head` already ends where the first entry begins, so it is concatenated
  // as-is. The only normalisation is that an empty head does not lead with a
  // blank line.
  const rendered = `${head}${body}\n`
  return eol === '\r\n' ? rendered.replace(/\n/g, '\r\n') : rendered
}
