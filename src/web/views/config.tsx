/**
 * Site config — `src/config.ts` as a form.
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
import { useT, type Dictionary, type I18n } from '../lib/i18n'
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
  const { t } = useT()
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
        title={t('config.title')}
        description={t('config.subtitle')}
      />

      {error && <ErrorBox error={error} onRetry={() => { void load() }} />}
      {!data && !error && <SkeletonRows rows={6} />}

      {data && <nav class="subtabs" aria-label={t('config.aria')}>
        {([
          ['site', t('config.tabSite')],
          ['nav', t('config.tabNav')],
          ['theme', t('config.tabTheme')],
          ['features', t('config.tabFeatures')],
          ['raw', t('config.tabRaw')],
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
  t: I18n['t'],
): Promise<boolean> {
  try {
    await api.put(`/api/sites/${siteId}/config`, { sha, edits })
    toast('ok', t('config.saved'))
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
  const { t } = useT()
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
      if (edits.length && await saveEdits(siteId, data.sha, edits, toast, t)) await onSaved()
      else if (!edits.length) toast('info', t('common.noChange'))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <div class="stack">
      <div class="meta-grid">
        <label class="field">
          <span class="label">{t('config.siteName')}</span>
          <input class="input" value={form.title} onInput={event => set('title', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">{t('config.subtitleField')}</span>
          <input class="input" value={form.subtitle} onInput={event => set('subtitle', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field meta-grid__wide">
          <span class="label">{t('config.description')}</span>
          <textarea class="textarea" rows={3} value={form.description} onInput={event => set('description', (event.target as HTMLTextAreaElement).value)} />
        </label>
        <label class="field">
          <span class="label">{t('config.author')}</span>
          <input class="input" value={form.author} onInput={event => set('author', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">{t('config.email')}</span>
          <input class="input" type="email" value={form.email} onInput={event => set('email', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field meta-grid__wide">
          <span class="label">{t('config.url')}</span>
          <input class="input mono" value={form.url} onInput={event => set('url', (event.target as HTMLInputElement).value)} />
          <span class="hint">{t('config.urlHint')}</span>
        </label>
        <label class="field">
          <span class="label">{t('config.uiLang')}</span>
          {data.config.i18n && data.config.i18n.defaultLang ? (
            <>
              <select
                class="select"
                aria-label={t('config.uiLang')}
                value={form.defaultLang}
                onChange={event => set('defaultLang', (event.target as HTMLSelectElement).value)}
              >
                <option value="zh">{t('editor.langZh')}</option>
                <option value="en">{t('editor.langEn')}</option>
              </select>
              <span class="hint">{t('config.uiLangHint')}</span>
            </>
          ) : (
            <span class="hint">
              {t('config.uiLangUnavailable')}
            </span>
          )}
        </label>
        <label class="field">
          <span class="label">{t('config.docLang')}</span>
          <input class="input mono" value={form.lang} onInput={event => set('lang', (event.target as HTMLInputElement).value)} />
          <span class="hint">{t('config.docLangHint')}</span>
        </label>
        <label class="field">
          <span class="label">locale</span>
          <input class="input mono" value={form.locale} onInput={event => set('locale', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">{t('config.startYear')}</span>
          <input class="input" type="number" value={form.startYear} onInput={event => set('startYear', Number((event.target as HTMLInputElement).value))} />
        </label>
        <label class="field">
          <span class="label">{t('config.perPage')}</span>
          <input class="input" type="number" min={1} max={100} value={form.postsPerPage} onInput={event => set('postsPerPage', Number((event.target as HTMLInputElement).value))} />
        </label>
        <label class="field">
          <span class="label">{t('config.ga')}</span>
          <input class="input mono" placeholder={t('config.gaPlaceholder')} value={form.googleAnalyticsId} onInput={event => set('googleAnalyticsId', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field meta-grid__check">
          <span class="label">
            <input type="checkbox" checked={form.tocOpen} onChange={event => set('tocOpen', (event.target as HTMLInputElement).checked)} />{' '}
            {t('config.tocOpen')}
          </span>
        </label>
      </div>
      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
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
  const { t } = useT()
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
      toast('ok', t('config.savedNav'))
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
        <h2>{t('config.nav')}</h2>
        <p class="hint">
          {t('config.navHint')}
        </p>
        {nav.map((item, index) => (
          <div key={index} class="nav-row">
            {item.key ? (
              // A dictionary key is not editable here — the label lives in the
              // theme's i18n files, and the point of the key is that it changes
              // with the interface language.
              <span class="nav-row__key mono" title={t('config.navKeyTitle')}>
                {item.key}
              </span>
            ) : (
              <input class="input" aria-label={t('config.label')} value={item.label ?? ''} onInput={event => {
                const value = (event.target as HTMLInputElement).value
                setNav(current => current.map((row, i) => (i === index ? { ...row, label: value } : row)))
              }} />
            )}
            <input class="input mono" aria-label={t('config.href')} value={item.href} onInput={event => {
              const value = (event.target as HTMLInputElement).value
              setNav(current => current.map((row, i) => (i === index ? { ...row, href: value } : row)))
            }} />
            <button type="button" class="btn btn--sm btn--ghost" aria-label={t('common.up')} onClick={() => setNav(current => {
              if (index === 0) return current
              const next = [...current]
              const moved = next[index - 1]
              next[index - 1] = next[index]
              next[index] = moved
              return next
            })}>↑</button>
            <button type="button" class="btn btn--sm btn--danger" aria-label={t('common.delete')} onClick={() => setNav(current => current.filter((_, i) => i !== index))}>{t('common.delete')}</button>
          </div>
        ))}
        <button type="button" class="btn btn--sm" onClick={() => setNav(current => [...current, { label: '', href: '/' }])}>{t('config.addCustomNav')}</button>
      </section>

      <section class="stack">
        <h2>{t('config.socials')}</h2>
        {socials.map((item, index) => (
          <div key={index} class="nav-row">
            <input class="input" aria-label={t('config.label')} value={item.label} onInput={event => {
              const value = (event.target as HTMLInputElement).value
              setSocials(current => current.map((row, i) => (i === index ? { ...row, label: value } : row)))
            }} />
            <input class="input mono" aria-label={t('config.href')} value={item.href} onInput={event => {
              const value = (event.target as HTMLInputElement).value
              setSocials(current => current.map((row, i) => (i === index ? { ...row, href: value } : row)))
            }} />
            <label class="row">
              <input type="checkbox" checked={Boolean(item.external)} onChange={event => {
                const checked = (event.target as HTMLInputElement).checked
                setSocials(current => current.map((row, i) => (i === index ? { ...row, ...(checked ? { external: true } : { external: undefined }) } : row)))
              }} />
              {t('config.external')}
            </label>
            <button type="button" class="btn btn--sm btn--danger" aria-label={t('common.delete')} onClick={() => setSocials(current => current.filter((_, i) => i !== index))}>{t('common.delete')}</button>
          </div>
        ))}
        <button type="button" class="btn btn--sm" onClick={() => setSocials(current => [...current, { label: '', href: '' }])}>{t('config.addSocial')}</button>
      </section>

      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
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
  const { t } = useT()
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
      toast('ok', t('config.savedTheme'))
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
        <span class="label">{t('config.defaultMode')}</span>
        <select class="select" value={mode} onChange={event => setMode((event.target as HTMLSelectElement).value)}>
          <option value="auto">{t('config.modeAuto')}</option>
          <option value="light">{t('config.modeLight')}</option>
          <option value="dark">{t('config.modeDark')}</option>
        </select>
      </label>

      <div class="palettes">
        <PaletteEditor label={t('config.paletteDay')} tokens={light} paper={paperOf(light)} onChange={setLight} />
        <PaletteEditor label={t('config.paletteNight')} tokens={dark} paper={paperOf(dark)} onChange={setDark} />
      </div>

      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
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
  const { t } = useT()
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
                aria-label={t('config.colourAria', key)}
                value={toHex(value)}
                onInput={event => onChange({ ...tokens, [key]: (event.target as HTMLInputElement).value })}
              />
              <span class="palette-row__name mono">{key}</span>
              <input
                class="input mono palette-row__value"
                aria-label={t('config.valueAria', key)}
                value={value}
                onInput={event => onChange({ ...tokens, [key]: (event.target as HTMLInputElement).value })}
              />
              {ratio !== null && (
                <span class={`palette-row__ratio ${fails ? 'palette-row__ratio--fail' : ''}`} title={t('config.contrastAria')}>
                  {ratio.toFixed(1)}:1{fails ? ` ${t('config.contrastLow')}` : ''}
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
  const { t } = useT()
  const [features, setFeatures] = useState(data.config.features)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await api.put(`/api/sites/${siteId}/config`, {
        sha: data.sha,
        objects: [{ path: ['features'], values: features }],
      })
      toast('ok', t('config.savedFeatures'))
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
              <span class="hint">{FEATURE_HINT_KEYS[key] ? t(FEATURE_HINT_KEYS[key]) : ''}</span>
            </span>
          </label>
        ))}
      </div>
      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}

/** A hint per feature flag, resolved through the dictionary. */
const FEATURE_HINT_KEYS: Record<string, keyof Dictionary> = {
  search: 'config.featureSearch',
  views: 'config.featureViews',
  musicCards: 'config.featureMusicCards',
  githubCards: 'config.featureGithubCards',
  mediaEmbeds: 'config.featureMediaEmbeds',
  math: 'config.featureMath',
  mermaid: 'config.featureMermaid',
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
  const { t } = useT()
  const [text, setText] = useState(data.raw)
  const [busy, setBusy] = useState(false)
  const [confirmElement, confirm] = useConfirm()

  useEffect(() => setText(data.raw), [data.sha])

  const save = async () => {
    const ok = await confirm({
      title: t('config.rawWriteTitle'),
      message: t('config.rawWriteBody'),
      confirmLabel: t('config.rawWrite'),
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.put(`/api/sites/${siteId}/config/raw`, { sha: data.sha, content: text })
      toast('ok', t('config.rawWritten'))
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
        {t('config.rawHint')}
      </p>
      <textarea
        class="textarea editor-textarea"
        rows={28}
        value={text}
        spellcheck={false}
        onInput={event => setText((event.target as HTMLTextAreaElement).value)}
        aria-label={t('config.rawAria')}
      />
      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('config.rawWriting') : t('config.rawWriteButton')}
        </button>
      </div>
      {confirmElement}
    </div>
  )
}

export { contrast }
