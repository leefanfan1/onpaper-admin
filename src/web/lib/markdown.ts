/**
 * Markdown → a preview document.
 *
 * The preview has to show what the site shows, because a preview that prints
 * `::music{url="…"}` as a paragraph looks like the post is broken when the
 * published page draws a card. So it handles the theme's whole vocabulary:
 * directives (music cards, GitHub cards, embeds), Mermaid, and maths.
 *
 * Order matters and is the whole design:
 *
 *   1. Directives and maths are lifted out of the source into placeholders
 *      *before* Markdown runs, because Markdown would otherwise treat a
 *      directive's `{…}` and a formula's `_` / `^` as markup.
 *   2. Markdown renders the remainder.
 *   3. The result is sanitised.
 *   4. The lifted pieces are put back, already built from escaped values.
 *
 * The document runs in a sandboxed frame with `allow-scripts` and **no**
 * `allow-same-origin`, so a diagram script can draw but cannot reach the panel's
 * DOM, storage or session.
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { extractMermaid } from './mermaid-fence'
import { parseDirective, renderDirective } from './directives'

marked.setOptions({ gfm: true, breaks: false })

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'details',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'section',
  'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul', 'input', 'video', 'audio', 'source', 'svg', 'path', 'g', 'use', 'math', 'annotation',
  'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'annotation-xml',
]

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class', 'id', 'lang', 'dir', 'start', 'type', 'checked', 'disabled',
  'colspan', 'rowspan', 'viewBox', 'd', 'fill', 'stroke', 'width', 'height', 'xmlns', 'aria-hidden',
  'aria-label', 'role', 'loading', 'decoding', 'controls', 'muted', 'playsinline', 'data-*',
]

/** Escape text for insertion into HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A card or formula, lifted out of the source and put back after sanitising. */
interface Lifted {
  placeholder: string
  html: string
}

/** Replace `::directive{...}` lines with placeholders. */
function liftDirectives(source: string): { text: string, lifted: Lifted[] } {
  const lifted: Lifted[] = []
  const text = source.split('\n').map((line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('::')) return line
    const card = parseDirective(trimmed)
    if (!card) return line
    const html = renderDirective(card)
    if (!html) return line
    // A directive is one line, so a bare token is unambiguous — Markdown leaves
    // a line that is only a word alone.
    const placeholder = `CARDPLACEHOLDER${lifted.length}ENDCARD`
    lifted.push({ placeholder, html })
    return placeholder
  }).join('\n')
  return { text, lifted }
}

/**
 * Render maths with KaTeX.
 *
 * Display maths (`$$…$$`) is handled first so its delimiters are not read as two
 * inline formulas. A formula KaTeX rejects is left as its source, which is what
 * the site does.
 */
function liftMath(source: string): { text: string, lifted: Lifted[] } {
  const lifted: Lifted[] = []

  const stash = (html: string): string => {
    const placeholder = `MATHPLACEHOLDER${lifted.length}ENDMATH`
    lifted.push({ placeholder, html })
    return placeholder
  }

  let text = source.replace(/\$\$([\s\S]+?)\$\$/g, (_match, body: string) => {
    try {
      return stash(katex.renderToString(body.trim(), { displayMode: true, throwOnError: false }))
    }
    catch {
      return stash(`<pre class="math-failed">${escapeHtml(body)}</pre>`)
    }
  })

  // Inline: `$…$` not preceded by a backslash and not spanning a blank line.
  text = text.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (match, lead: string, body: string) => {
    try {
      return `${lead}${stash(katex.renderToString(body.trim(), { displayMode: false, throwOnError: false }))}`
    }
    catch {
      return match
    }
  })

  return { text, lifted }
}

/** Put lifted HTML back where its placeholder ended up. */
function restore(html: string, lifted: Lifted[]): string {
  return lifted.reduce((acc, piece) => {
    // Markdown may have wrapped a bare placeholder in a paragraph.
    const wrapped = `<p>${piece.placeholder}</p>`
    return acc.includes(wrapped)
      ? acc.split(wrapped).join(piece.html)
      : acc.split(piece.placeholder).join(piece.html)
  }, html)
}

export function renderMarkdown(markdownText: string): string {
  const directives = liftDirectives(markdownText)
  const maths = liftMath(directives.text)
  const mermaid = extractMermaid(maths.text)

  const raw = marked.parse(mermaid.markdown, { async: false }) as string
  const clean = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'srcdoc', 'formaction'],
    ADD_ATTR: ['target'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  }) as string

  // Diagrams: the placeholder is a `<pre>` the sanitiser kept; put the source in
  // as text so Mermaid can read it.
  const withDiagrams = mermaid.diagrams.reduce((html, source, index) => {
    return html.replace(
      `<pre class="mermaid" data-diagram="${index}"></pre>`,
      `<pre class="mermaid" data-diagram="${index}">${escapeHtml(source)}</pre>`,
    )
  }, clean)

  const withCards = restore(withDiagrams, directives.lifted)
  const withMath = restore(withCards, maths.lifted)

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<style>${KATEX_CSS}${PREVIEW_CSS}${MERMAID_CSS}${CARD_CSS}</style></head>
<body>${withMath}
${mermaid.diagrams.length ? MERMAID_SCRIPT : ''}
</body></html>`
}

/** The stylesheet for the theme's prose, at reading size. */
const PREVIEW_CSS = `
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 20px 24px 48px;
    background: #f4f5f7;
    color: #182134;
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.8;
    -webkit-font-smoothing: antialiased;
    max-inline-size: 42rem;
  }
  h1, h2, h3, h4 {
    font-family: "Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif;
    font-weight: 600;
    line-height: 1.35;
    margin: 1.6em 0 0.6em;
    text-wrap: balance;
  }
  h1 { font-size: 1.6rem; margin-top: 0; }
  h2 { font-size: 1.3rem; }
  h3 { font-size: 1.1rem; }
  p { margin: 0.9em 0; }
  a { color: #2a47c9; text-underline-offset: 0.18em; }
  blockquote {
    margin: 1.2em 0;
    padding-inline-start: 1em;
    border-inline-start: 2px solid #d9dce3;
    color: #4a5368;
  }
  code {
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 0.88em;
    background: #eaecf0;
    padding: 0.15em 0.35em;
    border-radius: 3px;
  }
  pre { background: #eaecf0; padding: 12px 14px; border-radius: 3px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  hr { border: 0; border-block-start: 1px solid #d9dce3; margin: 2em 0; }
  img, video { max-inline-size: 100%; block-size: auto; }
  table { border-collapse: collapse; inline-size: 100%; margin: 1.2em 0; font-size: 0.94em; }
  th, td { border: 1px solid #d9dce3; padding: 6px 10px; text-align: start; }
  th { background: #eaecf0; font-weight: 600; }
  ul, ol { padding-inline-start: 1.4em; }
  li { margin: 0.3em 0; }
  /* Emphasis in this theme is a 着重号, not italics. */
  em {
    font-style: normal;
    -webkit-text-emphasis: dot;
    text-emphasis: dot;
    text-emphasis-position: under right;
  }
  mark { background: #dce3fb; }
  kbd {
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
    border: 1px solid #b9bfcb;
    border-radius: 3px;
    padding: 0.1em 0.35em;
  }
  .task-list-item { list-style: none; }
  @media (prefers-color-scheme: dark) {
    body { background: #10141c; color: #e3e6ed; }
    a { color: #93a6ff; }
    blockquote { border-color: rgba(227,230,237,0.16); color: #aab1c1; }
    code, pre, th { background: #1c2230; }
    th, td { border-color: rgba(227,230,237,0.16); }
    hr { border-color: rgba(227,230,237,0.16); }
  }
`

/** KaTeX's own layout rules, enough for a formula to sit correctly. */
const KATEX_CSS = `
  .katex { font-family: "Times New Roman", serif; font-size: 1.05em; }
  .katex-display { margin: 1.2em 0; overflow-x: auto; overflow-y: hidden; padding: 0.2em 0; }
  .katex .mfrac { display: inline-block; vertical-align: middle; text-align: center; }
  .katex .frac-line { border-block-end: 1px solid currentColor; display: block; }
  .katex sup, .katex sub { font-size: 0.7em; }
  .math-failed { color: #9b2c2c; background: #f6e3e3; }
`

/** The cards the theme's directives draw. */
const CARD_CSS = `
  .card {
    display: flex;
    gap: 14px;
    margin: 1.4em 0;
    padding: 12px;
    border: 1px solid #d9dce3;
    border-radius: 4px;
    background: #ffffff;
    text-decoration: none;
    color: inherit;
  }
  .card__cover {
    inline-size: 84px;
    block-size: 84px;
    flex: none;
    border-radius: 3px;
    object-fit: cover;
    background: #eaecf0;
    display: grid;
    place-items: center;
    font-size: 1.6rem;
    color: #626b7e;
  }
  .card__body { min-inline-size: 0; display: grid; gap: 4px; align-content: start; }
  .card__title { font-weight: 600; font-size: 1rem; }
  .card__meta { margin: 0; color: #4a5368; font-size: 0.85rem; }
  .card__lyric {
    margin: 2px 0 0;
    padding-inline-start: 8px;
    border-inline-start: 2px solid #d9dce3;
    color: #626b7e;
    font-size: 0.82rem;
    font-style: normal;
  }
  .card__platforms {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 4px;
    margin-block-start: 6px;
  }
  .card__platform {
    padding: 3px 6px;
    border: 1px solid #d9dce3;
    border-radius: 2px;
    font-size: 0.7rem;
    text-align: center;
    text-decoration: none;
    color: #2a47c9;
    white-space: nowrap;
  }
  .card__platform--off { color: #b9bfcb; border-style: dashed; }
  .card--github { flex-direction: column; gap: 6px; }
  .card__repo { font-family: ui-monospace, monospace; font-weight: 600; color: #2a47c9; }
  .card__desc { font-size: 0.88rem; color: #4a5368; }
  .card__stats { display: flex; gap: 14px; font-size: 0.8rem; color: #626b7e; }
  .card--embed { flex-direction: column; padding: 8px; }
  .card__embed {
    inline-size: 100%;
    aspect-ratio: 16 / 9;
    border: 0;
    border-radius: 3px;
    background: #10141c;
  }
  .card__caption { margin: 6px 4px 2px; font-size: 0.82rem; color: #626b7e; }
  .card__hint { margin: 4px 0 0; font-size: 0.78rem; color: #626b7e; }
  .card__source, .card--fallback {
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    background: #eaecf0;
    padding: 8px 10px;
    border-radius: 3px;
    overflow-x: auto;
  }
  .card--embed-failed { flex-direction: column; }
  @media (prefers-color-scheme: dark) {
    .card { background: #171c27; border-color: rgba(227,230,237,0.14); }
    .card__meta, .card__caption, .card__hint { color: #aab1c1; }
    .card__lyric { border-color: rgba(227,230,237,0.16); color: #8b93a6; }
    .card__platform { border-color: rgba(227,230,237,0.18); color: #93a6ff; }
    .card__platform--off { color: #4a5368; }
    .card__repo { color: #93a6ff; }
    .card__source, .card--fallback { background: #1c2230; }
  }
`

/** The script that draws the diagrams. */
const MERMAID_SCRIPT = `<script type="module" src="/mermaid-preview.js"></script>`

const MERMAID_CSS = `
  pre.mermaid {
    background: none;
    padding: 0;
    text-align: center;
    overflow-x: auto;
  }
  pre.mermaid svg { max-inline-size: 100%; block-size: auto; }
  pre.mermaid.mermaid--error {
    background: #f6e3e3;
    color: #9b2c2c;
    padding: 12px;
    text-align: start;
    white-space: pre-wrap;
  }
`
