/**
 * Edit `src/config.ts` without rewriting it.
 *
 * The file is the theme's single configuration entry, and it is heavily
 * commented — the comment above `theme.light` explains what each colour token
 * means, and the one above `nav` explains where friends live instead. A
 * "parse to JSON, patch, stringify" round trip would delete all of that.
 *
 * So this does what a careful editor would: parse the TypeScript with acorn
 * (pure JS, runs in workerd), walk to the object literal a value lives in,
 * and replace only the source range of that value. Everything else — comments,
 * quote style, indentation, trailing commas, the `satisfies` clauses, the
 * `as ThemeMode` cast — is untouched, because it is never written.
 */

import { parse } from 'acorn'

type Node = {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

export class ConfigError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

/** Parse TS as JS plus the syntax this file actually uses. */
function parseModule(source: string): Node {
  return parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    // TypeScript's type annotations do not survive this parser, so the caller
    // only ever passes the *object literal* source, extracted below. Any
    // residual type syntax is reported as unparsable rather than guessed at.
    allowHashBang: false,
  }) as unknown as Node
}

/**
 * Find `export const siteConfig = { ... }` in the source.
 *
 * Rather than teach acorn TypeScript (a whole second parser), the object
 * literal is located by its balanced braces and parsed on its own. The
 * literal is plain JavaScript — the type annotation lives on the interfaces
 * above it, not inside it.
 */
export function findSiteConfigObject(source: string): { start: number, end: number, text: string } {
  const marker = /export\s+const\s+siteConfig\s*(?::[^=]+)?=\s*\{/
  const match = marker.exec(source)
  if (!match) {
    throw new ConfigError('CONFIG_SHAPE', '找不到 export const siteConfig = { ... }')
  }
  const open = match.index + match[0].length - 1
  const close = matchBrace(source, open)
  return { start: open, end: close + 1, text: source.slice(open, close + 1) }
}

/** The index of the `}` that closes the `{` at `open`, skipping strings and comments. */
function matchBrace(source: string, open: number): number {
  let depth = 0
  let i = open
  while (i < source.length) {
    const char = source[i]
    if (char === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl + 1
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      i = close === -1 ? source.length : close + 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      i = skipString(source, i)
      continue
    }
    if (char === '{' || char === '(' || char === '[') depth++
    else if (char === '}' || char === ')' || char === ']') {
      depth--
      if (depth === 0 && char === '}') return i
    }
    i++
  }
  throw new ConfigError('CONFIG_SHAPE', 'siteConfig 对象没有闭合')
}

function skipString(source: string, start: number): number {
  const quote = source[start]
  let i = start + 1
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue }
    if (source[i] === quote) return i + 1
    i++
  }
  throw new ConfigError('CONFIG_SHAPE', '字符串没有闭合')
}

/** Top-level key -> value node of an object literal. */
function objectMembers(node: Node): Map<string, Node> {
  const members = new Map<string, Node>()
  const properties = node.properties as Node[] | undefined
  if (!properties) return members
  for (const property of properties) {
    if (property.type !== 'Property') continue
    const key = property.key as Node
    const name = key.type === 'Identifier'
      ? (key.name as string)
      : key.type === 'Literal' ? String(key.value) : ''
    if (!name) continue
    members.set(name, property.value as Node)
  }
  return members
}

/** Follow `theme.light` — a path of plain object members. */
function memberAt(node: Node, path: string[]): Node | undefined {
  let current: Node | undefined = node
  for (const key of path) {
    if (!current || current.type !== 'ObjectExpression') return undefined
    current = objectMembers(current).get(key)
  }
  return current
}

export interface ConfigTextField {
  path: string[]
  value: string | number | boolean
  /** The value kind, so the writer knows how to render it. */
  kind: 'string' | 'number' | 'boolean'
}

/** Read a scalar at `path`, or undefined when the path is absent or not scalar. */
export function readConfigValue(source: string, path: string[]): string | number | boolean | undefined {
  const { root } = rootObject(source)
  const node = memberAt(root, path)
  if (!node) return undefined
  if (node.type === 'Literal') {
    const value = node.value as string | number | boolean
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : undefined
  }
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as Node[]
    if (quasis.length === 1) {
      const cooked = (quasis[0] as unknown as { value: { cooked: string } }).value.cooked
      return cooked
    }
  }
  return undefined
}

/**
 * The literal parses as an expression, but its members may carry casts or
 * `satisfies` clauses that acorn cannot read. Wrap it and let a failure be the
 * caller's answer — the panel then refuses the edit instead of corrupting the
 * file.
 */
/**
 * The statement wrapper the literal is parsed inside.
 *
 * Its length matters: acorn reports every node position relative to the whole
 * wrapper, so a caller mapping a position back to the file must subtract
 * `WRAPPER_PREFIX.length`. Getting this wrong shifts every edit by 24
 * characters — which silently corrupts the file rather than failing, because a
 * shifted range is still a valid range.
 */
const WRAPPER_PREFIX = 'const __panel_config = '

function wrapLiteral(literal: string): string {
  return `${WRAPPER_PREFIX}${stripTypeSyntax(literal)}`
}

/**
 * Remove TypeScript's type-only syntax from an object literal, keeping every
 * other character at the same offset.
 *
 * The theme writes `] satisfies SocialLink[]` and `defaultMode: 'auto' as
 * ThemeMode` inside `siteConfig`. acorn parses JavaScript, not TypeScript, so a
 * literal containing them does not parse at all. The obvious fix — teach acorn
 * TypeScript — means a second parser; the narrow fix is to blank out the type
 * clauses.
 *
 * **Offsets must not move.** Every edit is applied as a character range taken
 * from the *original* source, so a removal here would shift them all. Each
 * stripped clause is therefore replaced with spaces of exactly its own length.
 */
function stripTypeSyntax(literal: string): string {
  const blank = (text: string): string => text.replace(/[^\n\r]/g, ' ')
  let out = ''
  let i = 0

  while (i < literal.length) {
    const char = literal[i]

    /*
     * Copy strings and comments through untouched.
     *
     * The keyword scan below is textual, so a value like
     * `description: 'as seen in the paper'` would otherwise have
     * `as seen in the paper` blanked out of the copy the parser reads. The
     * offsets stay right, but `readSiteConfig` would return a value with holes
     * in it, and the form would then offer to save those holes back.
     */
    if (char === '"' || char === "'" || char === '`') {
      const end = endOfString(literal, i)
      out += literal.slice(i, end)
      i = end
      continue
    }
    if (char === '/' && (literal[i + 1] === '/' || literal[i + 1] === '*')) {
      const end = endOfComment(literal, i)
      out += literal.slice(i, end)
      i = end
      continue
    }

    /*
     * `satisfies SomeType`, `as const`, `as Some.Type<Arg>`, `as X[]`, and
     * unions of those including string literal types. The theme writes
     * `defaultLang: 'zh' as 'zh' | 'en'` — a cast to a union of two string
     * literals — which the previous single-identifier pattern could not read,
     * so the whole file failed to parse and every config edit was refused.
     */
    const keyword = /\b(satisfies|as)\s+(?:'[^'\n]*'|"[^"\n]*"|[A-Za-z_$][\w$.]*)(?:\s*<[^<>]*>)?(?:\s*\[\s*\])*(?:\s*\|\s*(?:'[^'\n]*'|"[^"\n]*"|[A-Za-z_$][\w$.]*)(?:\s*<[^<>]*>)?(?:\s*\[\s*\])*)*/.exec(literal.slice(i))
    if (keyword && keyword.index === 0) {
      out += blank(keyword[0])
      i += keyword[0].length
      continue
    }
    // A non-null assertion `!` in value position is rare here; leave it.
    out += char
    i++
  }

  return out
}

/** The index just past the string literal starting at `start`. */
function endOfString(text: string, start: number): number {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    // A template literal may hold `${...}`, whose contents are code again; its
    // own closing brace does not end the literal, so only the backtick does.
    if (text[i] === quote) return i + 1
    i++
  }
  return text.length
}

/** The index just past the comment starting at `start`. */
function endOfComment(text: string, start: number): number {
  if (text[start + 1] === '/') {
    const end = text.indexOf('\n', start)
    return end === -1 ? text.length : end
  }
  const end = text.indexOf('*/', start + 2)
  return end === -1 ? text.length : end + 2
}

function rootObject(source: string): { root: Node, literal: ReturnType<typeof findSiteConfigObject> } {
  const literal = findSiteConfigObject(source)
  try {
    const program = parseModule(wrapLiteral(literal.text)) as unknown as { body: Node[] }
    const declaration = program.body[0] as Node
    const declarations = declaration.declarations as Node[]
    const root = declarations[0].init as Node
    if (root.type !== 'ObjectExpression') throw new Error('not an object')
    return { root, literal }
  }
  catch (error) {
    throw new ConfigError(
      'CONFIG_PARSE',
      `无法解析 siteConfig：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Render a scalar the way the file writes them: single quotes for strings. */
export function renderScalar(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConfigError('CONFIG_VALUE', '数字必须是有限值')
    return String(value)
  }
  const text = String(value)
  if (/[\n\r]/.test(text)) {
    throw new ConfigError('CONFIG_VALUE', '值不能包含换行')
  }
  // The file is written with single quotes throughout; match it.
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`
}

export interface ConfigEdit {
  path: string[]
  value: string | number | boolean
}

/**
 * Apply scalar edits, returning the new file text.
 *
 * Each edit replaces exactly the characters of the old value. Edits are
 * applied from the end of the file backwards so earlier offsets stay valid.
 */
export function applyConfigEdits(source: string, edits: ConfigEdit[]): { text: string, applied: string[][] } {
  if (!edits.length) return { text: source, applied: [] }
  const { root, literal } = rootObject(source)
  const offset = literal.start - WRAPPER_PREFIX.length

  const changes: Array<{ start: number, end: number, text: string, path: string[] }> = []
  for (const edit of edits) {
    if (!edit.path.length) throw new ConfigError('CONFIG_PATH', '配置路径不能为空')
    const node = memberAt(root, edit.path)
    if (!node) {
      throw new ConfigError('CONFIG_MISSING', `配置项 ${edit.path.join('.')} 不存在`)
    }
    if (!['Literal', 'TemplateLiteral'].includes(node.type)) {
      throw new ConfigError(
        'CONFIG_COMPLEX',
        `${edit.path.join('.')} 不是简单值，面板不修改它`,
      )
    }
    if (typeof edit.value === 'string' && /[\n\r]/.test(edit.value)) {
      throw new ConfigError('CONFIG_VALUE', '值不能包含换行')
    }
    changes.push({
      start: offset + node.start,
      end: offset + node.end,
      text: renderScalar(edit.value),
      path: edit.path,
    })
  }

  // Report in the caller's order before sorting for application: the return
  // value describes what was asked for, not the internal edit sequence.
  const applied = changes.map(change => change.path)
  changes.sort((a, b) => b.start - a.start)
  let text = source
  for (const change of changes) {
    text = `${text.slice(0, change.start)}${change.text}${text.slice(change.end)}`
  }
  return { text, applied }
}

// ---------------------------------------------------------------------------
// Structured reads for the panel's config form.
// ---------------------------------------------------------------------------

/** A nav entry: `key` resolves through the theme's dictionary, `label` is literal. */
export interface NavItem { key?: string, label?: string, href: string }
export interface SocialItem { label: string, href: string, external?: boolean }
export interface ColorTokens { [key: string]: string }

export interface SiteConfigView {
  title: string
  subtitle: string
  description: string
  author: string
  email: string
  url: string
  lang: string
  locale: string
  /**
   * The interface language, fixed at build time by the theme's dictionary.
   *
   * Newer OnPaper has `i18n.defaultLang: 'zh' | 'en'`; an older config has no
   * `i18n` block at all, and then this is `''` — meaning "the theme predates
   * the dictionary", which the form shows rather than pretends is a choice.
   */
  i18n: { defaultLang: string }
  startYear: number
  postsPerPage: number
  tocOpen: boolean
  nav: NavItem[]
  socials: SocialItem[]
  analytics: { googleAnalyticsId: string }
  theme: { defaultMode: string, light: ColorTokens, dark: ColorTokens }
  fonts: { display: string, body: string, mono: string }
  features: Record<string, boolean>
}

function stringOf(node: Node | undefined): string {
  if (!node || node.type !== 'Literal') return ''
  return typeof node.value === 'string' ? node.value : ''
}

function numberOf(node: Node | undefined): number {
  if (!node || node.type !== 'Literal') return 0
  return typeof node.value === 'number' ? node.value : 0
}

function booleanOf(node: Node | undefined): boolean {
  return node?.type === 'Literal' && node.value === true
}

function arrayOf(node: Node | undefined): Node[] {
  if (!node || node.type !== 'ArrayExpression') return []
  return (node.elements as Array<Node | null>).filter((item): item is Node => Boolean(item))
}

/** The whole config, in the shape the panel's form binds to. */
export function readSiteConfig(source: string): SiteConfigView {
  const { root } = rootObject(source)
  const get = (key: string) => objectMembers(root).get(key)

  /*
   * A nav item carries either a dictionary `key` (newer theme: the label
   * follows the interface language) or a literal `label` (older theme, or a
   * custom entry the author wrote). Both are kept as they are — reading only
   * `label` made an unchanged save rewrite every keyed item as a literal, which
   * froze the navigation into one language.
   */
  const nav = arrayOf(get('nav')).map((item) => {
    const members = objectMembers(item)
    const key = stringOf(members.get('key'))
    const label = stringOf(members.get('label'))
    return {
      ...(key ? { key } : {}),
      ...(label ? { label } : {}),
      href: stringOf(members.get('href')),
    }
  })
  const socials = arrayOf(get('socials')).map(item => {
    const members = objectMembers(item)
    const external = members.get('external')
    return {
      label: stringOf(members.get('label')),
      href: stringOf(members.get('href')),
      ...(external && booleanOf(external) ? { external: true } : {}),
    }
  })

  const analytics = get('analytics')
  const i18nNode = get('i18n')
  const theme = get('theme')
  const fonts = get('fonts')
  const features = get('features')

  const colors = (node: Node | undefined): ColorTokens => {
    const tokens: ColorTokens = {}
    if (node?.type !== 'ObjectExpression') return tokens
    for (const [key, value] of objectMembers(node)) {
      const text = stringOf(value)
      if (text) tokens[key] = text
    }
    return tokens
  }

  const featureFlags: Record<string, boolean> = {}
  if (features?.type === 'ObjectExpression') {
    for (const [key, value] of objectMembers(features)) {
      if (value.type === 'Literal' && typeof value.value === 'boolean') {
        featureFlags[key] = value.value
      }
    }
  }

  return {
    title: stringOf(get('title')),
    subtitle: stringOf(get('subtitle')),
    description: stringOf(get('description')),
    author: stringOf(get('author')),
    email: stringOf(get('email')),
    url: stringOf(get('url')),
    lang: stringOf(get('lang')),
    locale: stringOf(get('locale')),
    i18n: { defaultLang: stringOf(i18nNode && objectMembers(i18nNode).get('defaultLang')) },
    startYear: numberOf(get('startYear')),
    postsPerPage: numberOf(get('postsPerPage')),
    tocOpen: booleanOf(get('tocOpen')),
    nav,
    socials,
    analytics: { googleAnalyticsId: stringOf(analytics && objectMembers(analytics).get('googleAnalyticsId')) },
    theme: {
      defaultMode: stringOf(theme && objectMembers(theme).get('defaultMode')),
      light: colors(theme && objectMembers(theme).get('light')),
      dark: colors(theme && objectMembers(theme).get('dark')),
    },
    fonts: {
      display: stringOf(fonts && objectMembers(fonts).get('display')),
      body: stringOf(fonts && objectMembers(fonts).get('body')),
      mono: stringOf(fonts && objectMembers(fonts).get('mono')),
    },
    features: featureFlags,
  }
}

/**
 * Replace an array member (`nav`, `socials`) wholesale.
 *
 * Arrays are a different problem from scalars: adding an item means emitting a
 * new object literal, and the original's formatting (one item per line, or
 * several) is not worth preserving through a structural change. The array is
 * re-emitted in the file's own style — two-space indent, single quotes — while
 * everything outside its brackets is untouched.
 */
export function replaceConfigArray(
  source: string,
  key: string,
  items: Array<Record<string, string | boolean>>,
): string {
  const { root, literal } = rootObject(source)
  const offset = literal.start - WRAPPER_PREFIX.length
  const node = objectMembers(root).get(key)
  if (!node || node.type !== 'ArrayExpression') {
    throw new ConfigError('CONFIG_MISSING', `配置项 ${key} 不是一个数组`)
  }

  const rendered = items.length
    ? `[\n${items.map(item => {
      const entries = Object.entries(item)
        .filter(([, value]) => value !== '' && value !== undefined)
        .map(([name, value]) => `${name}: ${
          typeof value === 'boolean' ? (value ? 'true' : 'false') : renderScalar(String(value))
        }`)
      return `    { ${entries.join(', ')} },`
    }).join('\n')}\n  ]`
    : '[]'

  const start = offset + node.start
  const end = offset + node.end
  return `${source.slice(0, start)}${rendered}${source.slice(end)}`
}

/** Replace a whole nested object of scalars (`theme.light`, `features`). */
export function replaceConfigObject(
  source: string,
  path: string[],
  values: Record<string, string | number | boolean>,
): string {
  const { root, literal } = rootObject(source)
  const offset = literal.start - WRAPPER_PREFIX.length
  const node = memberAt(root, path)
  if (!node || node.type !== 'ObjectExpression') {
    throw new ConfigError('CONFIG_MISSING', `配置项 ${path.join('.')} 不存在`)
  }
  const rendered = `{\n${Object.entries(values).map(([key, value]) => `      ${key}: ${renderScalar(value)},`).join('\n')}\n    }`
  const start = offset + node.start
  const end = offset + node.end
  return `${source.slice(0, start)}${rendered}${source.slice(end)}`
}

/** Which colour token names the theme defines, read from the file. */
export function colorTokenNames(source: string): string[] {
  const { root } = rootObject(source)
  const theme = objectMembers(root).get('theme')
  const light = theme && objectMembers(theme).get('light')
  return light?.type === 'ObjectExpression' ? [...objectMembers(light).keys()] : []
}
