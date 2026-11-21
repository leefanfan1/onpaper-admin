/**
 * Pages and friend links.
 *
 * Three files, three editors. `about.md` and `now.md` are Markdown with a body;
 * `friends.md` is a list of name/URL/description triples that the site parses
 * positionally, so it is edited as a form rather than as text — reordering is a
 * drag or a pair of arrows, not a cut and paste.
 */

import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, isApiError } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { Empty, ErrorBox, useConfirm } from '../components/ui'
import { SkeletonRows } from '../components/feedback'
import { useT } from '../lib/i18n'

type PageKey = 'about' | 'now' | 'friends'

const PAGE_LABEL_KEYS: Record<PageKey, 'pages.about' | 'pages.now' | 'pages.friends'> = {
  about: 'pages.about',
  now: 'pages.now',
  friends: 'pages.friends',
}

interface PagePayload {
  key: PageKey
  exists: boolean
  path?: string
  sha?: string
  frontmatter?: Record<string, string>
  body?: string
  entries?: NowEntry[]
  links?: FriendLink[]
  parseError?: string
}

interface NowEntry {
  kind: 'book' | 'film' | 'music'
  label: string
  title: string
  creator: string
  url: string
  year: string
  douban: string
}

interface FriendLink {
  name: string
  url: string
  description: string
}

export function PagesView({ ctx, siteId }: { ctx: AppContext, siteId: number }): ComponentChildren {
  const { t } = useT()
  const [page, setPage] = useState<PageKey>('about')
  const [data, setData] = useState<PagePayload | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async (key: PageKey) => {
    setData(null)
    setError(null)
    try {
      setData(await api.get<PagePayload>(`/api/sites/${siteId}/pages/${key}`))
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    }
  }

  useEffect(() => { void load(page) }, [siteId, page])

  return (
    <div class="stack">
      <PageHead
        title={t('pages.title')}
        description={t('pages.subtitle')}
      />

      <nav class="subtabs" aria-label={t('pages.aria')}>
        {(Object.keys(PAGE_LABEL_KEYS) as PageKey[]).map(key => (
          <button
            key={key}
            type="button"
            class="tab"
            aria-current={page === key ? 'page' : undefined}
            onClick={() => setPage(key)}
          >
            {t(PAGE_LABEL_KEYS[key])}
          </button>
        ))}
      </nav>

      {error && <ErrorBox error={error} onRetry={() => { void load(page) }} />}
      {/* A skeleton, not a bare line: the head and the tabs above already hold
          their space, so only the editor area waits — and it waits in place. */}
      {!error && !data && <SkeletonRows rows={5} />}
      {data && !data.exists && (
        <Empty title={t('pages.notYet', t(PAGE_LABEL_KEYS[page]))}>
          <button
            type="button"
            class="btn btn--primary"
            onClick={async () => {
              try {
                await api.post(`/api/sites/${siteId}/pages/${page}`, {})
                await load(page)
                ctx.toast('ok', t('pages.created'))
              }
              catch (caught) {
                ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
              }
            }}
          >
            {t('pages.create')}
          </button>
        </Empty>
      )}

      {data?.exists && page === 'friends' && (
        <FriendsEditor
          siteId={siteId}
          initial={data.links ?? []}
          parseError={data.parseError}
          onSaved={() => { void load('friends') }}
          toast={ctx.toast}
        />
      )}

      {data?.exists && page === 'now' && (
        <NowEditor
          siteId={siteId}
          entries={data.entries ?? []}
          onSaved={() => { void load('now') }}
          toast={ctx.toast}
        />
      )}

      {data?.exists && page === 'about' && (
        <MarkdownPage
          siteId={siteId}
          pageKey="about"
          data={data}
          onSaved={() => { void load('about') }}
          toast={ctx.toast}
          saving={saving}
          setSaving={setSaving}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function MarkdownPage({
  siteId,
  pageKey,
  data,
  onSaved,
  toast,
}: {
  siteId: number
  pageKey: PageKey
  data: PagePayload
  onSaved: () => void
  toast: AppContext['toast']
  saving: boolean
  setSaving: (value: boolean) => void
}): ComponentChildren {
  const { t } = useT()
  const [title, setTitle] = useState(data.frontmatter?.title ?? '')
  const [description, setDescription] = useState(data.frontmatter?.description ?? '')
  const [body, setBody] = useState(data.body ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setTitle(data.frontmatter?.title ?? '')
    setDescription(data.frontmatter?.description ?? '')
    setBody(data.body ?? '')
  }, [data.sha])

  const save = async () => {
    setBusy(true)
    try {
      await api.put(`/api/sites/${siteId}/pages/${pageKey}`, {
        sha: data.sha,
        frontmatter: { ...(data.frontmatter ?? {}), title, description },
        body,
      })
      toast('ok', t('common.saved'))
      onSaved()
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
      <div class="meta-grid">
        <label class="field">
          <span class="label">{t('pages.title')}</span>
          <input class="input" value={title} onInput={event => setTitle((event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">{t('pages.description')}</span>
          <input class="input" value={description} onInput={event => setDescription((event.target as HTMLInputElement).value)} />
        </label>
      </div>
      <label class="field">
        <span class="label">{t('pages.body')}</span>
        <textarea
          class="textarea editor-textarea"
          rows={22}
          value={body}
          onInput={event => setBody((event.target as HTMLTextAreaElement).value)}
        />
        <span class="hint">{t('pages.bodyHint')}</span>
      </label>
      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function NowEditor({
  siteId,
  entries,
  onSaved,
  toast,
}: {
  siteId: number
  entries: NowEntry[]
  onSaved: () => void
  toast: AppContext['toast']
}): ComponentChildren {
  const { t } = useT()
  const [rows, setRows] = useState<NowEntry[]>(entries)
  const [busy, setBusy] = useState(false)

  useEffect(() => setRows(entries), [JSON.stringify(entries)])

  const update = (index: number, patch: Partial<NowEntry>) => {
    setRows(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const save = async () => {
    setBusy(true)
    try {
      await api.put(`/api/sites/${siteId}/pages/now`, {
        entries: rows.map(row => ({ ...row, originalTitle: entries.find(entry => entry.kind === row.kind)?.title })),
      })
      toast('ok', t('common.saved'))
      onSaved()
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
        {t('pages.nowHelp')}
        <code class="mono">npm run covers</code>
      </p>
      {rows.map((row, index) => (
        <fieldset key={row.kind} class="fieldset">
          <legend>{row.label}</legend>
          <div class="meta-grid">
            <label class="field">
              <span class="label">{t('pages.name')}</span>
              <input class="input" value={row.title} onInput={event => update(index, { title: (event.target as HTMLInputElement).value })} />
            </label>
            <label class="field">
              <span class="label">{t('pages.creator')}</span>
              <input class="input" value={row.creator} onInput={event => update(index, { creator: (event.target as HTMLInputElement).value })} />
            </label>
            <label class="field meta-grid__wide">
              <span class="label">{t('pages.link')}</span>
              <input class="input mono" value={row.url} onInput={event => update(index, { url: (event.target as HTMLInputElement).value })} />
            </label>
            <label class="field">
              <span class="label">{t('pages.year')}</span>
              <input class="input" value={row.year} onInput={event => update(index, { year: (event.target as HTMLInputElement).value })} />
            </label>
          </div>
        </fieldset>
      ))}
      {!rows.length && <Empty title={t('pages.nowEmpty')}>{t('pages.nowEmptyHint')}</Empty>}
      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy || !rows.length} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function FriendsEditor({
  siteId,
  initial,
  parseError,
  onSaved,
  toast,
}: {
  siteId: number
  initial: FriendLink[]
  parseError?: string
  onSaved: () => void
  toast: AppContext['toast']
}): ComponentChildren {
  const { t } = useT()
  const [links, setLinks] = useState<FriendLink[]>(initial)
  const [busy, setBusy] = useState(false)
  const [confirmElement, confirm] = useConfirm()

  useEffect(() => setLinks(initial), [JSON.stringify(initial)])

  const update = (index: number, patch: Partial<FriendLink>) => {
    setLinks(current => current.map((link, i) => (i === index ? { ...link, ...patch } : link)))
  }

  const move = (index: number, delta: number) => {
    setLinks(current => {
      const next = [...current]
      const target = index + delta
      if (target < 0 || target >= next.length) return current
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const save = async () => {
    setBusy(true)
    try {
      await api.put(`/api/sites/${siteId}/pages/friends`, { links })
      toast('ok', t('common.saved'))
      onSaved()
    }
    catch (caught) {
      toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
    finally {
      setBusy(false)
    }
  }

  const remove = async (index: number) => {
    const link = links[index]
    const ok = await confirm({
      title: t('pages.removeTitle', link.name),
      message: t('pages.removeBody'),
      confirmLabel: t('common.remove'),
      danger: true,
    })
    if (!ok) return
    setLinks(current => current.filter((_, i) => i !== index))
  }

  return (
    <div class="stack">
      {parseError && (
        <div class="notice notice--warn" role="alert">
          <p>{t('pages.parseError', parseError)}</p>
        </div>
      )}
      <div class="stack">
        {links.map((link, index) => (
          <div key={`${link.url}-${index}`} class="friend-row">
            <div class="friend-row__order">
              <button type="button" class="btn btn--ghost btn--sm" aria-label={t('pages.moveUp', link.name)} onClick={() => move(index, -1)}>↑</button>
              <button type="button" class="btn btn--ghost btn--sm" aria-label={t('pages.moveDown', link.name)} onClick={() => move(index, 1)}>↓</button>
            </div>
            <div class="friend-row__fields">
              <input
                class="input"
                aria-label={t('pages.name')}
                placeholder={t('pages.name')}
                value={link.name}
                onInput={event => update(index, { name: (event.target as HTMLInputElement).value })}
              />
              <input
                class="input mono"
                aria-label={t('pages.url')}
                placeholder="https://example.com/"
                value={link.url}
                onInput={event => update(index, { url: (event.target as HTMLInputElement).value })}
              />
              <input
                class="input"
                aria-label={t('pages.note')}
                placeholder={t('pages.notePlaceholder')}
                value={link.description}
                onInput={event => update(index, { description: (event.target as HTMLInputElement).value })}
              />
            </div>
            <button type="button" class="btn btn--sm btn--danger" onClick={() => void remove(index)}>{t('common.remove')}</button>
          </div>
        ))}
      </div>

      <div class="row">
        <button
          type="button"
          class="btn"
          onClick={() => setLinks(current => [...current, { name: '', url: 'https://', description: '' }])}
        >
          {t('pages.addFriend')}
        </button>
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>

      {confirmElement}
    </div>
  )
}
