/**
 * 页面与友链.
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

type PageKey = 'about' | 'now' | 'friends'

const PAGE_LABELS: Record<PageKey, string> = {
  about: '关于',
  now: '最近',
  friends: '友链',
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
        title="页面与友链"
        description="关于页、右栏「最近」、友链列表。改动会直接提交到仓库。"
      />

      <nav class="subtabs" aria-label="页面">
        {(Object.keys(PAGE_LABELS) as PageKey[]).map(key => (
          <button
            key={key}
            type="button"
            class="tab"
            aria-current={page === key ? 'page' : undefined}
            onClick={() => setPage(key)}
          >
            {PAGE_LABELS[key]}
          </button>
        ))}
      </nav>

      {error && <ErrorBox error={error} onRetry={() => { void load(page) }} />}
      {/* A skeleton, not a bare line: the head and the tabs above already hold
          their space, so only the editor area waits — and it waits in place. */}
      {!error && !data && <SkeletonRows rows={5} />}
      {data && !data.exists && (
        <Empty title={`还没有 ${PAGE_LABELS[page]} 页`}>
          <button
            type="button"
            class="btn btn--primary"
            onClick={async () => {
              try {
                await api.post(`/api/sites/${siteId}/pages/${page}`, {})
                await load(page)
                ctx.toast('ok', '页面已创建')
              }
              catch (caught) {
                ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
              }
            }}
          >
            创建页面
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
      toast('ok', '已保存')
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
          <span class="label">标题</span>
          <input class="input" value={title} onInput={event => setTitle((event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">描述</span>
          <input class="input" value={description} onInput={event => setDescription((event.target as HTMLInputElement).value)} />
        </label>
      </div>
      <label class="field">
        <span class="label">正文（Markdown）</span>
        <textarea
          class="textarea editor-textarea"
          rows={22}
          value={body}
          onInput={event => setBody((event.target as HTMLTextAreaElement).value)}
        />
        <span class="hint">{'文件开头的 <!-- --> 注释会原样保留在文件里。'}</span>
      </label>
      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
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
      toast('ok', '已保存')
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
        首页右栏的三行。在读、在看填豆瓣条目页；在听填音乐平台。
        <code class="mono">npm run covers</code> 能按名称补齐作者、年份和链接。
      </p>
      {rows.map((row, index) => (
        <fieldset key={row.kind} class="fieldset">
          <legend>{row.label}</legend>
          <div class="meta-grid">
            <label class="field">
              <span class="label">名称</span>
              <input class="input" value={row.title} onInput={event => update(index, { title: (event.target as HTMLInputElement).value })} />
            </label>
            <label class="field">
              <span class="label">{row.kind === 'music' ? '歌手' : '作者'}</span>
              <input class="input" value={row.creator} onInput={event => update(index, { creator: (event.target as HTMLInputElement).value })} />
            </label>
            <label class="field meta-grid__wide">
              <span class="label">链接</span>
              <input class="input mono" value={row.url} onInput={event => update(index, { url: (event.target as HTMLInputElement).value })} />
            </label>
            <label class="field">
              <span class="label">年份</span>
              <input class="input" value={row.year} onInput={event => update(index, { year: (event.target as HTMLInputElement).value })} />
            </label>
          </div>
        </fieldset>
      ))}
      {!rows.length && <Empty title="还没有「最近」条目">在文件里写第一段，或用 covers 补全。</Empty>}
      <div class="row">
        <button type="button" class="btn btn--primary" disabled={busy || !rows.length} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
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
      toast('ok', '已保存')
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
      title: `移除「${link.name}」？`,
      message: '会从这个文件里删掉这三行。',
      confirmLabel: '移除',
      danger: true,
    })
    if (!ok) return
    setLinks(current => current.filter((_, i) => i !== index))
  }

  return (
    <div class="stack">
      {parseError && (
        <div class="notice notice--warn" role="alert">
          <p>文件现在的格式有问题，面板读不全：{parseError}</p>
        </div>
      )}
      <div class="stack">
        {links.map((link, index) => (
          <div key={`${link.url}-${index}`} class="friend-row">
            <div class="friend-row__order">
              <button type="button" class="btn btn--ghost btn--sm" aria-label={`上移 ${link.name}`} onClick={() => move(index, -1)}>↑</button>
              <button type="button" class="btn btn--ghost btn--sm" aria-label={`下移 ${link.name}`} onClick={() => move(index, 1)}>↓</button>
            </div>
            <div class="friend-row__fields">
              <input
                class="input"
                aria-label="名称"
                placeholder="名称"
                value={link.name}
                onInput={event => update(index, { name: (event.target as HTMLInputElement).value })}
              />
              <input
                class="input mono"
                aria-label="网址"
                placeholder="https://example.com/"
                value={link.url}
                onInput={event => update(index, { url: (event.target as HTMLInputElement).value })}
              />
              <input
                class="input"
                aria-label="简介"
                placeholder="一段简短的介绍（可省略）"
                value={link.description}
                onInput={event => update(index, { description: (event.target as HTMLInputElement).value })}
              />
            </div>
            <button type="button" class="btn btn--sm btn--danger" onClick={() => void remove(index)}>移除</button>
          </div>
        ))}
      </div>

      <div class="row">
        <button
          type="button"
          class="btn"
          onClick={() => setLinks(current => [...current, { name: '', url: 'https://', description: '' }])}
        >
          添加一位
        </button>
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      {confirmElement}
    </div>
  )
}
