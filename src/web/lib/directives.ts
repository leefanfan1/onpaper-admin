/**
 * The theme's Markdown directives, rendered for the preview.
 *
 * The site supports directives the panel has to show or the preview is
 * misleading: `::music` and `::music-card` become a four-platform music card,
 * `::github` a repository card, `::embed` an iframe. A preview that prints
 * `::music{url="…"}` as a paragraph looks like the post is broken, when the
 * published page shows a card.
 *
 * The rendering here is a *preview*, not the build: the site resolves `::music`
 * against `src/data/music-cache.json` at build time and fills in the real title,
 * artist and cover, which the panel does not have. So the card is drawn from the
 * attributes that are written, and the platform links are drawn from the URL —
 * which is enough to see the shape and to check the link, and is stated plainly
 * rather than pretending to be the final output.
 */

export interface DirectiveCard {
  kind: 'music' | 'music-card' | 'github' | 'embed'
  attrs: Record<string, string>
  /** The source text, for the fallback when nothing can be drawn. */
  source: string
}

/**
 * Parse `::name{key="value" key='value' key=value}`.
 *
 * Values may be quoted with either mark, and may contain the other mark and
 * braces — a Spotify URL contains `/`, an embed URL a `&`. The parse is
 * therefore character-by-character rather than a split on spaces.
 */
export function parseDirective(text: string): DirectiveCard | null {
  const match = text.match(/^::([a-z][a-z-]*)\s*(?:\{([\s\S]*)\})?\s*$/i)
  if (!match) return null
  const name = match[1].toLowerCase()
  if (!['music', 'music-card', 'github', 'embed'].includes(name)) return null

  const attrs: Record<string, string> = {}
  const body = match[2] ?? ''
  let index = 0

  while (index < body.length) {
    // Skip separators.
    while (index < body.length && /[\s,]/.test(body[index])) index++
    if (index >= body.length) break

    const keyMatch = /^([A-Za-z][\w-]*)\s*=\s*/.exec(body.slice(index))
    if (!keyMatch) break
    const key = keyMatch[1]
    index += keyMatch[0].length

    const quote = body[index]
    if (quote === '"' || quote === "'") {
      index++
      let value = ''
      while (index < body.length && body[index] !== quote) {
        if (body[index] === '\\' && index + 1 < body.length) { index++; value += body[index]; index++; continue }
        value += body[index]
        index++
      }
      index++
      attrs[key] = value
    }
    else {
      let value = ''
      while (index < body.length && !/[\s,]/.test(body[index])) { value += body[index]; index++ }
      attrs[key] = value
    }
  }

  return { kind: name as DirectiveCard['kind'], attrs, source: text }
}

/** Which platform a music URL belongs to, for the label and the icon. */
export function musicPlatform(url: string): { name: string, key: string } {
  if (/open\.spotify\.com/.test(url)) return { name: 'Spotify', key: 'spotify' }
  if (/music\.apple\.com/.test(url)) return { name: 'Apple Music', key: 'apple' }
  if (/music\.163\.com|y\.music\.126\.net/.test(url)) return { name: '网易云', key: 'netease' }
  if (/y\.qq\.com/.test(url)) return { name: 'QQ 音乐', key: 'qq' }
  return { name: '音乐', key: 'other' }
}

/** Escape text for insertion into HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Only http(s) URLs become links; anything else is shown as text. */
function safeHref(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  }
  catch {
    return null
  }
}

/** The four platform slots every music card has. */
const PLATFORMS = [
  { key: 'spotify', label: 'Spotify' },
  { key: 'apple', label: 'Apple Music' },
  { key: 'netease', label: '网易云' },
  { key: 'qq', label: 'QQ 音乐' },
]

function renderMusic(card: DirectiveCard): string {
  const { attrs } = card
  const title = attrs.title ?? ''
  const artist = attrs.artist ?? ''
  const cover = attrs.cover && safeHref(attrs.cover)
  const lyric = attrs.lyric ?? ''

  // `::music` carries one URL and the build resolves the rest; `::music-card`
  // carries the fields directly. Both draw the same card.
  const links: Record<string, string> = {}
  for (const platform of PLATFORMS) {
    const value = attrs[platform.key]
    const href = value ? safeHref(value) : null
    if (href) links[platform.key] = href
  }
  if (attrs.url) {
    const href = safeHref(attrs.url)
    if (href) links[musicPlatform(attrs.url).key] = href
  }

  const slots = PLATFORMS.map(platform => {
    const href = links[platform.key]
    return href
      ? `<a class="card__platform" href="${escapeHtml(href)}" rel="noreferrer noopener" target="_blank">${platform.label}</a>`
      : `<span class="card__platform card__platform--off">${platform.label}</span>`
  }).join('')

  const coverHtml = cover
    ? `<img class="card__cover" src="${escapeHtml(cover)}" alt="" loading="lazy">`
    : `<div class="card__cover card__cover--none" aria-hidden="true">♪</div>`

  const hint = title
    ? ''
    : `<p class="card__hint">卡片内容由构建期从 music-cache.json 补全，这里只显示已写的字段。</p>`

  return `<figure class="card card--music">
    ${coverHtml}
    <div class="card__body">
      <figcaption class="card__title">${escapeHtml(title || '（标题由构建期补全）')}</figcaption>
      ${artist ? `<p class="card__meta">${escapeHtml(artist)}</p>` : ''}
      ${lyric ? `<blockquote class="card__lyric">${escapeHtml(lyric)}</blockquote>` : ''}
      <div class="card__platforms">${slots}</div>
      ${hint}
    </div>
  </figure>`
}

function renderGithub(card: DirectiveCard): string {
  const { attrs } = card
  let repo = attrs.repo ?? ''
  if (!repo && attrs.url) {
    const href = safeHref(attrs.url)
    const match = href?.match(/github\.com\/([^/]+)\/([^/?#]+)/)
    if (match) repo = `${match[1]}/${match[2]}`
  }
  if (!repo) return `<pre class="card--fallback">${escapeHtml(card.source)}</pre>`

  const href = `https://github.com/${repo}`
  return `<a class="card card--github" href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">
    <span class="card__repo">${escapeHtml(repo)}</span>
    ${attrs.description ? `<span class="card__desc">${escapeHtml(attrs.description)}</span>` : ''}
    <span class="card__stats">
      ${attrs.stars ? `<span>★ ${escapeHtml(attrs.stars)}</span>` : ''}
      ${attrs.forks ? `<span>⑂ ${escapeHtml(attrs.forks)}</span>` : ''}
      ${attrs.language ? `<span>${escapeHtml(attrs.language)}</span>` : ''}
    </span>
  </a>`
}

/** Embeds the site allows, and the iframe URL each maps to. */
function embedUrl(value: string): string | null {
  const href = safeHref(value)
  if (!href) return null
  const url = new URL(href)

  if (/youtube\.com$|youtu\.be$|youtube-nocookie\.com$/.test(url.hostname)) {
    const id = url.searchParams.get('v') ?? url.pathname.split('/').filter(Boolean).pop() ?? ''
    return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : null
  }
  if (/bilibili\.com$/.test(url.hostname)) {
    const match = url.pathname.match(/\/video\/([A-Za-z0-9]+)/)
    return match ? `https://player.bilibili.com/player.html?bvid=${match[1]}&autoplay=0` : null
  }
  if (/spotify\.com$/.test(url.hostname)) {
    const parts = url.pathname.split('/').filter(Boolean)
    return parts.length >= 2 ? `https://open.spotify.com/embed/${parts[0]}/${parts[1]}` : null
  }
  if (/vimeo\.com$/.test(url.hostname)) {
    const id = url.pathname.split('/').filter(Boolean).pop() ?? ''
    return /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null
  }
  return null
}

function renderEmbed(card: DirectiveCard): string {
  const src = embedUrl(card.attrs.url ?? '')
  const title = card.attrs.title ?? '嵌入内容'
  const caption = card.attrs.caption ?? ''

  if (!src) {
    return `<figure class="card card--embed card--embed-failed">
      <p class="card__hint">无法预览：只支持 YouTube、B 站、Spotify、Vimeo，或链接不完整。</p>
      <pre class="card__source">${escapeHtml(card.source)}</pre>
    </figure>`
  }

  return `<figure class="card card--embed">
    <iframe class="card__embed" src="${escapeHtml(src)}" title="${escapeHtml(title)}"
      loading="lazy" referrerpolicy="no-referrer" allowfullscreen
      sandbox="allow-scripts allow-same-origin allow-presentation"></iframe>
    ${caption ? `<figcaption class="card__caption">${escapeHtml(caption)}</figcaption>` : ''}
  </figure>`
}

/** Render one directive to HTML, or null to leave its text alone. */
export function renderDirective(card: DirectiveCard): string | null {
  switch (card.kind) {
    case 'music':
    case 'music-card': return renderMusic(card)
    case 'github': return renderGithub(card)
    case 'embed': return renderEmbed(card)
    default: return null
  }
}
