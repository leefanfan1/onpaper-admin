/**
 * 站点配置 — `src/config.ts` as a form.
 *
 * The form edits values; it does not rewrite the file. Each changed field
 * becomes one range replacement in the source, so the comments that explain
 * each colour token survive a save. That is the whole point of the acorn pass
 * on the server, and it is why this screen is a set of fields rather than a
 * textarea with the file in it (the raw editor exists too, on its own tab, for
 * anything the form does not model).
 *
 * The palette section is the one part with real design content: thirteen tokens
 * per mode, each shown with a swatch and a live contrast ratio against the paper
 * it sits on. A colour that fails 4.5:1 is marked before it is saved, not after
 * someone notices the site is hard to read.
 */

import { useEffect, useMemo, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, isApiError, type SiteConfigView } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { ErrorBox, useConfirm } from '../components/ui'
import { SkeletonRows } from '../components/feedback'

type Edit = { path: string[], value: string | number | boolean }

interface ConfigResponse {
  sha: string
  path: string
  config: SiteConfigView
  colorTokens: string[]
  raw: string
}

export function ConfigView({ ctx, siteId }: { ctx: AppContext, siteId: number }): ComponentChildren {
  const [data, setData] = useState<ConfigResponse | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [tab, setTab] = useState<'site' | 'nav' | 'theme' | 'features' | 'raw'>('site')

  const load = async () => {
    try {
      setData(await api.get<ConfigResponse>(`/api/sites/${siteId}/config`))
      setError(null)
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    }
  }

  useEffect(() => { void load() }, [siteId])

  // Head first: measured at 183px of jump when this page returned a loading
  // line instead. The tabs need data, so they wait with the body.
  return (
    <div class="stack">
      <PageHead
        title="站点配置"
        description="src/config.ts 的结构化编辑。保存时只替换值本身，注释和排版都不动。"
      />

      {error && <ErrorBox error={error} onRetry={() => { void load() }} />}
      {!data && !error && <SkeletonRows rows={6} />}

      {data && <nav class="subtabs" aria-label="配置分区">
        {([
          ['site', '站点信息'],
          ['nav', '导航与社交'],
          ['theme', '配色'],
          ['features', '功能开关'],
          ['raw', '源文件'],
        ] as const).map(([key, label]) => (
          <button key={key} type="button" class="tab" aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>}

      {data && tab === 'site' && <SiteSection data={data} siteId={siteId} onSaved={load} toast={ctx.toast} />}
      {data && tab === 'nav' && <NavSection data={data} siteId={siteId} onSaved={load} toast={ctx.toast} />}
      {data && tab === 'theme' && <ThemeSection data={data} siteId={siteId} onSaved={load} toast={ctx.toast} />}
      {data && tab === 'features' && <FeaturesSection data={data} siteId={siteId} onSaved={load} toast={ctx.toast} />}
      {data && tab === 'raw' && <RawSection data={data} siteId={siteId} onSaved={load} toast={ctx.toast} />}
    </div>
  )
}

async function saveEdits(
  siteId: number,
  sha: string,
  edits: Edit[],
  toast: AppContext['toast'],
): Promise<boolean> {
  try {
    await api.put(`/api/sites/${siteId}/config`, { sha, edits })
    toast('ok', '配置已保存')
    return true
  }
  catch (caught) {
    toast('danger', isApiError(caught) ? caught.message : String(caught))
    return false
  }
}

// ---------------------------------------------------------------------------

function SiteSection({
  data, siteId, onSaved, toast,
}: {
  data: ConfigResponse
  siteId: number
  onSaved: () => Promise<void>
  toast: AppContext['toast']
}): ComponentChildren {
  const [form, setForm] = useState({
    title: data.config.title,
    subtitle: data.config.subtitle,
    description: data.config.description,
    author: data.config.author,
    email: data.config.email,
    url: data.config.url,
    lang: data.config.lang,
    locale: data.config.locale,
    defaultLang: data.config.i18n.defaultLang,
    startYear: data.config.startYear,
    postsPerPage: data.config.postsPerPage,
    tocOpen: data.config.tocOpen,
    googleAnalyticsId: data.config.analytics.googleAnalyticsId,
  })
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm(current => ({ ...current, [key]: value }))

  const save = async () => {
    setBusy(true)
    const edits: Edit[] = []
    const originals = data.config
    const originalsFlat: Record<string, string | number | boolean> = {
      title: originals.title,
      subtitle: originals.subtitle,
      description: originals.description,
      author: originals.author,
      email: originals.email,
      url: originals.url,
      lang: originals.lang,
      locale: originals.locale,
      defaultLang: originals.i18n.defaultLang,
      startYear: originals.startYear,
      postsPerPage: originals.postsPerPage,
      tocOpen: originals.tocOpen,
    }
    for (const [key, value] of Object.entries(form)) {
      if (key === 'googleAnalyticsId') continue
      if (originalsFlat[key] === value) continue
      // `defaultLang` is nested: the theme keeps it under `i18n`.
      edits.push({ path: key === 'defaultLang' ? ['i18n', 'defaultLang'] : [key], value })
    }
    if (form.googleAnalyticsId !== originals.analytics.googleAnalyticsId) {
      edits.push({ path: ['analytics', 'googleAnalyticsId'], value: form.googleAnalyticsId })
    }
    try {
      if (edits.length && await saveEdits(siteId, data.sha, edits, toast)) await onSaved()
      else if (!edits.length) toast('info', '没有改动')
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <div class="stack">
      <div class="meta-grid">
        <label class="field">
          <span class="label">站名</span>
          <input class="input" value={form.title} onInput={event => set('title', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">副标题</span>
          <input class="input" value={form.subtitle} onInput={event => set('subtitle', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field meta-grid__wide">
          <span class="label">站点描述</span>
          <textarea class="textarea" rows={3} value={form.description} onInput={event => set('description', (event.target as HTMLTextAreaElement).value)} />
        </label>
        <label class="field">
          <span class="label">作者</span>
          <input class="input" value={form.author} onInput={event => set('author', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">邮箱</span>
          <input class="input" type="email" value={form.email} onInput={event => set('email', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field meta-grid__wide">
          <span class="label">站点 URL（必须是 https）</span>
          <input class="input mono" value={form.url} onInput={event => set('url', (event.target as HTMLInputElement).value)} />
          <span class="hint">sitemap、canonical、RSS 和分享图都用它。</span>
        </label>
        <label class="field">
          <span class="label">界面语言</span>
          {data.config.i18n && data.config.i18n.defaultLang ? (
            <>
              <select
                class="select"
                aria-label="界面语言"
                value={form.defaultLang}
                onChange={event => set('defaultLang', (event.target as HTMLSelectElement).value)}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
              <span class="hint">构建时决定界面语言，文章内容不受影响。改完要重新部署才会生效。</span>
            </>
          ) : (
            <span class="hint">
              这个站点的主题还没有语言字典（配置里没有 i18n），界面固定为中文。
              升级主题后这里会出现语言选择。
            </span>
          )}
        </label>
        <label class="field">
          <span class="label">文档语言（html lang）</span>
          <input class="input mono" value={form.lang} onInput={event => set('lang', (event.target as HTMLInputElement).value)} />
          <span class="hint">给浏览器和搜索引擎看的 BCP 47 标签，例如 zh-CN、en。</span>
        </label>
        <label class="field">
          <span class="label">locale</span>
          <input class="input mono" value={form.locale} onInput={event => set('locale', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">起始年份</span>
          <input class="input" type="number" value={form.startYear} onInput={event => set('startYear', Number((event.target as HTMLInputElement).value))} />
        </label>
        <label class="field">
          <span class="label">每页文章数</span>
          <input class="input" type="number" min={1} max={100} value={form.postsPerPage} onInput={event => set('postsPerPage', Number((event.target as HTMLInputElement).value))} />
        </label>
        <label class="field">
          <span class="label">GA 测量 ID</span>
          <input class="input mono" placeholder="G-XXXXXXXXXX（留空不加载）" value={form.googleAnalyticsId} onInput={event => set('googleAnalyticsId', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field meta-grid__check">
          <span class="label">
            <input type="checkbox" checked={form.tocOpen} onChange={event => set('tocOpen', (event.target as HTMLInputElement).checked)} />{' '}
            文章目录默认展开
          </span>
        </label>
      </div>
      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function NavSection({
  data, siteId, onSaved, toast,
}: {
  data: ConfigResponse
  siteId: number
  onSaved: () => Promise<void>
  toast: AppContext['toast']
}): ComponentChildren {
  const [nav, setNav] = useState(data.config.nav)
  const [socials, setSocials] = useState(data.config.socials)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await api.put(`/api/sites/${siteId}/config`, {
        sha: data.sha,
        arrays: [
          // A keyed item keeps its key: the label comes from the theme's
          // dictionary, and writing a literal one would pin the navigation to
          // whatever language it was saved in.
          { key: 'nav', items: nav.map(item => (item.key ? { key: item.key, href: item.href } : { label: item.label ?? '', href: item.href })) },
          {
            key: 'socials',
            items: socials.map(item => ({
              label: item.label,
              href: item.href,
              ...(item.external ? { external: true } : {}),
            })),
          },
        ],
      })
      toast('ok', '导航与社交链接已保存')
      await onSaved()
    }
    catch (caught) {
      toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <div class="stack">
      <section class="stack">
        <h2>导航</h2>
        <p class="hint">
          按顺序显示在书脊上。href 以 / 开头是站内路径。
          带 key 的项标签来自主题的语言字典，会跟着界面语言变；只有自己加的项才写标签。
        </p>
        {nav.map((item, index) => (
          <div key={index} class="nav-row">
            {item.key ? (
              // A dictionary key is not editable here — the label lives in the
              // theme's i18n files, and the point of the key is that it changes
              // with the interface language.
              <span class="nav-row__key mono" title="文案由主题的 i18n 字典提供">
                {item.key}
              </span>
            ) : (
              <input class="input" aria-label="标签" value={item.label ?? ''} onInput={event => {
                const value = (event.target as HTMLInputElement).value
                setNav(current => current.map((row, i) => (i === index ? { ...row, label: value } : row)))
              }} />
            )}
            <input class="input mono" aria-label="链接" value={item.href} onInput={event => {
              const value = (event.target as HTMLInputElement).value
              setNav(current => current.map((row, i) => (i === index ? { ...row, href: value } : row)))
            }} />
            <button type="button" class="btn btn--sm btn--ghost" aria-label="上移" onClick={() => setNav(current => {
              if (index === 0) return current
              const next = [...current]
              const moved = next[index - 1]
              next[index - 1] = next[index]
              next[index] = moved
              return next
            })}>↑</button>
            <button type="button" class="btn btn--sm btn--danger" aria-label="删除" onClick={() => setNav(current => current.filter((_, i) => i !== index))}>删除</button>
          </div>
        ))}
        <button type="button" class="btn btn--sm" onClick={() => setNav(current => [...current, { label: '', href: '/' }])}>添加自定义导航项</button>
      </section>

      <section class="stack">
        <h2>社交链接</h2>
        {socials.map((item, index) => (
          <div key={index} class="nav-row">
            <input class="input" aria-label="标签" value={item.label} onInput={event => {
              const value = (event.target as HTMLInputElement).value
              setSocials(current => current.map((row, i) => (i === index ? { ...row, label: value } : row)))
            }} />
            <input class="input mono" aria-label="链接" value={item.href} onInput={event => {
              const value = (event.target as HTMLInputElement).value
              setSocials(current => current.map((row, i) => (i === index ? { ...row, href: value } : row)))
            }} />
            <label class="row">
              <input type="checkbox" checked={Boolean(item.external)} onChange={event => {
                const checked = (event.target as HTMLInputElement).checked
                setSocials(current => current.map((row, i) => (i === index ? { ...row, ...(checked ? { external: true } : { external: undefined }) } : row)))
              }} />
              外链
            </label>
            <button type="button" class="btn btn--sm btn--danger" aria-label="删除" onClick={() => setSocials(current => current.filter((_, i) => i !== index))}>删除</button>
          </div>
        ))}
        <button type="button" class="btn btn--sm" onClick={() => setSocials(current => [...current, { label: '', href: '' }])}>添加社交链接</button>
      </section>

      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function ThemeSection({
  data, siteId, onSaved, toast,
}: {
  data: ConfigResponse
  siteId: number
  onSaved: () => Promise<void>
  toast: AppContext['toast']
}): ComponentChildren {
  const [mode, setMode] = useState(data.config.theme.defaultMode)
  const [light, setLight] = useState(data.config.theme.light)
  const [dark, setDark] = useState(data.config.theme.dark)
  const [busy, setBusy] = useState(false)

  const paperOf = (tokens: Record<string, string>) => tokens.paper ?? '#ffffff'

  const save = async () => {
    setBusy(true)
    try {
      const objects: Array<{ path: string[], values: Record<string, string | number | boolean> }> = [
        { path: ['theme', 'light'], values: light },
        { path: ['theme', 'dark'], values: dark },
      ]
      await api.put(`/api/sites/${siteId}/config`, {
        sha: data.sha,
        edits: mode !== data.config.theme.defaultMode ? [{ path: ['theme', 'defaultMode'], value: mode }] : [],
        objects,
      })
      toast('ok', '配色已保存')
      await onSaved()
    }
    catch (caught) {
      toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <div class="stack">
      <label class="field" style={{ maxWidth: '20rem' }}>
        <span class="label">默认配色</span>
        <select class="select" value={mode} onChange={event => setMode((event.target as HTMLSelectElement).value)}>
          <option value="auto">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </label>

      <div class="palettes">
        <PaletteEditor label="白天" tokens={light} paper={paperOf(light)} onChange={setLight} />
        <PaletteEditor label="夜里" tokens={dark} paper={paperOf(dark)} onChange={setDark} />
      </div>

      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

const TEXT_ON_PAPER = ['ink', 'inkSoft', 'inkFaint', 'accent', 'accentStrong']

function PaletteEditor({
  label,
  tokens,
  paper,
  onChange,
}: {
  label: string
  tokens: Record<string, string>
  paper: string
  onChange: (next: Record<string, string>) => void
}): ComponentChildren {
  return (
    <fieldset class="fieldset">
      <legend>{label}</legend>
      <div class="palette-grid">
        {Object.entries(tokens).map(([key, value]) => {
          const needsContrast = TEXT_ON_PAPER.includes(key)
          const ratio = needsContrast ? contrast(value, paper) : null
          const fails = ratio !== null && ratio < 4.5
          return (
            <div key={key} class="palette-row">
              <input
                type="color"
                class="palette-row__picker"
                aria-label={`${key} 颜色`}
                value={toHex(value)}
                onInput={event => onChange({ ...tokens, [key]: (event.target as HTMLInputElement).value })}
              />
              <span class="palette-row__name mono">{key}</span>
              <input
                class="input mono palette-row__value"
                aria-label={`${key} 色值`}
                value={value}
                onInput={event => onChange({ ...tokens, [key]: (event.target as HTMLInputElement).value })}
              />
              {ratio !== null && (
                <span class={`palette-row__ratio ${fails ? 'palette-row__ratio--fail' : ''}`} title="与 page 背景的对比度">
                  {ratio.toFixed(1)}:1{fails ? ' 偏低' : ''}
                </span>
              )}
              {ratio === null && <span class="palette-row__ratio muted">—</span>}
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}

function toHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
  }
  // rgba()/hsl() cannot drive a colour input; fall back to a neutral rather than
  // silently changing the value the author typed.
  return '#888888'
}

/**
 * WCAG contrast ratio between two colours.
 *
 * Only handles hex and rgb() — the two forms the theme's tokens use — and
 * returns 0 for anything else, which the UI shows as "—" rather than as a
 * passing score it did not measure.
 */
function contrast(foreground: string, background: string): number {
  const parse = (value: string): [number, number, number] | null => {
    const hex = value.trim()
    if (/^#[0-9a-f]{3}$/i.test(hex)) {
      return [
        Number.parseInt(hex[1] + hex[1], 16),
        Number.parseInt(hex[2] + hex[2], 16),
        Number.parseInt(hex[3] + hex[3], 16),
      ]
    }
    if (/^#[0-9a-f]{6}$/i.test(hex)) {
      return [
        Number.parseInt(hex.slice(1, 3), 16),
        Number.parseInt(hex.slice(3, 5), 16),
        Number.parseInt(hex.slice(5, 7), 16),
      ]
    }
    const rgb = hex.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i)
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    return null
  }

  const relative = (channel: number): number => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }

  const luminance = ([r, g, b]: [number, number, number]): number =>
    0.2126 * relative(r) + 0.7152 * relative(g) + 0.0722 * relative(b)

  const front = parse(foreground)
  const back = parse(background)
  if (!front || !back) return 0
  const a = luminance(front)
  const b = luminance(back)
  const light = Math.max(a, b)
  const dark = Math.min(a, b)
  return (light + 0.05) / (dark + 0.05)
}

// ---------------------------------------------------------------------------

function FeaturesSection({
  data, siteId, onSaved, toast,
}: {
  data: ConfigResponse
  siteId: number
  onSaved: () => Promise<void>
  toast: AppContext['toast']
}): ComponentChildren {
  const [features, setFeatures] = useState(data.config.features)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await api.put(`/api/sites/${siteId}/config`, {
        sha: data.sha,
        objects: [{ path: ['features'], values: features }],
      })
      toast('ok', '功能开关已保存')
      await onSaved()
    }
    catch (caught) {
      toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <div class="stack">
      <div class="stack">
        {Object.entries(features).map(([key, value]) => (
          <label key={key} class="toggle">
            <input
              type="checkbox"
              checked={value}
              onChange={event => setFeatures(current => ({ ...current, [key]: (event.target as HTMLInputElement).checked }))}
            />
            <span>
              <span class="mono">{key}</span>
              <span class="hint">{FEATURE_HINTS[key] ?? ''}</span>
            </span>
          </label>
        ))}
      </div>
      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

const FEATURE_HINTS: Record<string, string> = {
  search: '构建期生成搜索索引，Ctrl/⌘+K 唤起',
  views: '文章阅读计数（需要 Pages 项目绑定 VIEWS_KV）',
  musicCards: '::music 卡片，跨平台解析',
  githubCards: '::github 仓库卡片',
  mediaEmbeds: 'Spotify / B 站 / YouTube / Vimeo 嵌入',
  math: 'KaTeX 数学公式',
  mermaid: 'Mermaid 图表',
}

// ---------------------------------------------------------------------------

function RawSection({
  data, siteId, onSaved, toast,
}: {
  data: ConfigResponse
  siteId: number
  onSaved: () => Promise<void>
  toast: AppContext['toast']
}): ComponentChildren {
  const [text, setText] = useState(data.raw)
  const [busy, setBusy] = useState(false)
  const [confirmElement, confirm] = useConfirm()

  useEffect(() => setText(data.raw), [data.sha])

  const save = async () => {
    const ok = await confirm({
      title: '直接写入 src/config.ts？',
      message: '这会用你编辑后的全文替换文件。保存前会检查它还能否解析出站点配置。',
      confirmLabel: '写入',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.put(`/api/sites/${siteId}/config/raw`, { sha: data.sha, content: text })
      toast('ok', '已写入')
      await onSaved()
    }
    catch (caught) {
      toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <div class="stack">
      <p class="hint">
        表单覆盖不到的字段在这里改。写入前服务端会解析一遍，解析不出来就拒绝保存。
      </p>
      <textarea
        class="textarea editor-textarea"
        rows={28}
        value={text}
        spellcheck={false}
        onInput={event => setText((event.target as HTMLTextAreaElement).value)}
        aria-label="src/config.ts 源文件"
      />
      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? '写入中…' : '写入文件'}
        </button>
      </div>
      {confirmElement}
    </div>
  )
}

export { contrast }
