/**
 * 书单 / 片单 / 歌单.
 *
 * Each list is a set of paragraphs of `键：值` lines. The form writes them back
 * through the theme's own field order, so an entry the panel edited is still an
 * entry `npm run covers` recognises — and one it wrote keeps its position in the
 * list rather than jumping to the end.
 *
 * The cover is shown when there is one, read from `shelf-covers.json` for
 * entries whose file does not name a cover themselves. "Missing" is a state the
 * list shows plainly, because it is the reason to run `covers`.
 */

import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, isApiError, type ShelfEntry, type ShelfList } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { Dialog, Empty, ErrorBox, Loading, useConfirm } from '../components/ui'
import { SkeletonRows } from '../components/feedback'

const LIST_LABELS: Record<string, string> = {
  books: '书单',
  films: '片单',
  music: '歌单',
}
const CREATOR_LABEL: Record<string, string> = {
  book: '作者',
  film: '导演',
  music: '歌手',
}
const TITLE_KEY: Record<string, string> = {
  book: '书名',
  film: '片名',
  music: '名称',
}

interface ListsResponse {
  lists: Array<ShelfList & { exists: boolean }>
  coverCache: Record<string, string>
}

export function ShelfView({ ctx, siteId }: { ctx: AppContext, siteId: number }): ComponentChildren {
  const [data, setData] = useState<ListsResponse | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [active, setActive] = useState<string>('books')
  const [editing, setEditing] = useState<{ list: string, entry: ShelfEntry | null } | null>(null)
  const [confirmElement, confirm] = useConfirm()
  const [taskBusy, setTaskBusy] = useState(false)

  const load = async () => {
    try {
      setData(await api.get<ListsResponse>(`/api/sites/${siteId}/shelf`))
      setError(null)
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    }
  }

  useEffect(() => { void load() }, [siteId])

  const current = data?.lists.find(list => list.list === active)

  const saveEntry = async (list: string, values: Record<string, string>, originalTitle?: string) => {
    try {
      await api.put(`/api/sites/${siteId}/shelf/${list}/entries`, {
        entry: values,
        ...(originalTitle ? { originalTitle } : {}),
      })
      ctx.toast('ok', originalTitle ? '已更新' : '已添加')
      setEditing(null)
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  const removeEntry = async (list: string, entry: ShelfEntry) => {
    const ok = await confirm({
      title: `删除《${entry.title}》？`,
      message: '会从清单里删掉这一段。封面要等下一次 npm run covers 才会一起清掉。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      const result = await api.delete<{ hint?: string }>(
        `/api/sites/${siteId}/shelf/${list}/entries/${encodeURIComponent(entry.title)}`,
      )
      ctx.toast('ok', result.hint ?? '已删除')
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  const runCovers = async (args = '') => {
    setTaskBusy(true)
    try {
      await api.post(`/api/sites/${siteId}/tasks`, { kind: 'covers', args })
      ctx.toast('ok', '已开始补全，去「任务」看进度')
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
    finally {
      setTaskBusy(false)
    }
  }

  if (error) return <ErrorBox error={error} onRetry={() => { void load() }} />

  /*
   * The head and the list tabs are always drawn; only the cards wait.
   *
   * Returning a bare loading line made this page start 183px higher and drop
   * when the data arrived — measured, not guessed. The head, the tab strip and
   * the row of counts now occupy their space from the first frame.
   */
  const missing = current?.entries.filter(entry => !entry.cover).length ?? 0

  return (
    <div class="stack">
      <PageHead
        title="书架"
        description="三份 Markdown，一份清单一个文件。补全字段和封面交给 npm run covers。"
        actions={
          <button
            type="button"
            class="btn"
            disabled={taskBusy || !data}
            onClick={() => void runCovers()}
          >
            补全封面
          </button>
        }
      />

      <nav class="subtabs" aria-label="书架">
        {Object.keys(LIST_LABELS).map(list => (
          <button
            key={list}
            type="button"
            class="tab"
            aria-current={active === list ? 'page' : undefined}
            onClick={() => setActive(list)}
          >
            {LIST_LABELS[list]}
            <span class="muted"> {data ? data.lists.find(item => item.list === list)?.entries.length ?? 0 : ''}</span>
          </button>
        ))}
      </nav>

      {!data && <SkeletonRows rows={5} />}

      {data && current && missing > 0 && (
        <div class="notice" role="status">
          <p>{missing} 条还没有封面。</p>
          <button type="button" class="btn btn--sm" disabled={taskBusy} onClick={() => void runCovers()}>
            跑一次 covers
          </button>
        </div>
      )}

      {/*
        Three states, spelled out rather than collapsed into one ternary.
        `data && !current?.entries.length ? A : B` evaluates B when data is null,
        and B dereferences `current` — a crash on the first frame, before any
        data has arrived.
      */}
      {!data ? null : !current || !current.entries.length ? (
        <Empty
          title={`${LIST_LABELS[active]}还是空的`}
          action={<button type="button" class="btn btn--primary" onClick={() => setEditing({ list: active, entry: null })}>添加一条</button>}
        >
          只写名称就够，covers 会去豆瓣补齐作者、年份和封面。
        </Empty>
      ) : (
        <div class="shelf-grid">
          {current.entries.map(entry => (
            <article key={entry.title} class="shelf-card">
              <div class="shelf-card__cover">
                {entry.cover
                  ? (
                    <img
                      src={entry.cover}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      width={120}
                      height={180}
                      /* A cover URL is built from the site's public address. When that
                         is unset — or the file is gone — the browser draws its broken
                         image icon, which reads as a bug. Falling back to the title
                         placeholder keeps the shelf looking intentional. */
                      onError={(event) => {
                        const img = event.currentTarget as HTMLImageElement
                        img.style.display = 'none'
                        const fallback = img.nextElementSibling as HTMLElement | null
                        if (fallback) fallback.hidden = false
                      }}
                    />
                  )
                  : null}
                <div class="shelf-card__placeholder" aria-hidden="true" hidden={Boolean(entry.cover)}>
                  {entry.title.slice(0, 1)}
                </div>
              </div>
              <div class="shelf-card__body">
                <h3 class="shelf-card__title">{entry.title}</h3>
                <p class="shelf-card__meta">
                  {[entry.creator, entry.year].filter(Boolean).join(' · ') || <span class="muted">缺作者与年份</span>}
                </p>
                {entry.note && <p class="shelf-card__note">{entry.note}</p>}
                <div class="row shelf-card__actions">
                  <button type="button" class="btn btn--sm" onClick={() => setEditing({ list: active, entry })}>编辑</button>
                  <button type="button" class="btn btn--sm btn--danger" onClick={() => void removeEntry(active, entry)}>删除</button>
                  {/* Shown whenever the entry is incomplete — not only when the
                      cover is missing. An entry with a cover but no creator or
                      year still needs `covers`, and the button used to be
                      hidden in exactly that case. */}
                  {(!entry.cover || !entry.creator || !entry.year) && (
                    <button
                      type="button"
                      class="btn btn--sm btn--ghost"
                      disabled={taskBusy}
                      title={`运行 covers，只补《${entry.title}》`}
                      onClick={() => void runCovers(entry.title)}
                    >
                      补全这条
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <div class="row">
        <button type="button" class="btn" onClick={() => setEditing({ list: active, entry: null })}>
          添加一条
        </button>
      </div>

      <EntryDialog
        open={editing !== null}
        kind={current?.kind ?? 'book'}
        list={editing?.list ?? active}
        entry={editing?.entry ?? null}
        onClose={() => setEditing(null)}
        onSave={saveEntry}
      />

      {confirmElement}
    </div>
  )
}

function EntryDialog({
  open,
  kind,
  list,
  entry,
  onClose,
  onSave,
}: {
  open: boolean
  kind: 'book' | 'film' | 'music'
  list: string
  entry: ShelfEntry | null
  onClose: () => void
  onSave: (list: string, values: Record<string, string>, originalTitle?: string) => Promise<void>
}): ComponentChildren {
  const titleKey = TITLE_KEY[kind]
  const creatorKey = CREATOR_LABEL[kind]
  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    setValues({
      [titleKey]: entry?.title ?? '',
      [creatorKey]: entry?.creator ?? '',
      '年份': entry?.year ?? '',
      ...(kind === 'music'
        ? { '链接': entry?.link ?? '', '豆瓣': entry?.douban ?? '' }
        : { '豆瓣': entry?.douban ?? '' }),
      '一句话': entry?.note ?? '',
    })
    // Rebuild the form whenever a different entry is opened.
  }, [open, entry?.title, kind, titleKey, creatorKey])

  const set = (key: string, value: string) => setValues(current => ({ ...current, [key]: value }))

  return (
    <Dialog
      open={open}
      title={entry ? `编辑《${entry.title}》` : `添加${kind === 'book' ? '书' : kind === 'film' ? '片' : '歌'}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>取消</button>
          <button
            type="button"
            class="btn btn--primary"
            onClick={() => void onSave(list, values, entry?.title)}
          >
            保存
          </button>
        </>
      }
    >
      <div class="meta-grid">
        <label class="field">
          <span class="label">{titleKey}（必填）</span>
          <input class="input" value={values[titleKey] ?? ''} onInput={event => set(titleKey, (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">{creatorKey}</span>
          <input class="input" value={values[creatorKey] ?? ''} onInput={event => set(creatorKey, (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">年份</span>
          <input class="input" value={values['年份'] ?? ''} onInput={event => set('年份', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span class="label">豆瓣</span>
          <input class="input mono" value={values['豆瓣'] ?? ''} onInput={event => set('豆瓣', (event.target as HTMLInputElement).value)} />
        </label>
        {kind === 'music' && (
          <label class="field meta-grid__wide">
            <span class="label">链接（音乐平台）</span>
            <input class="input mono" value={values['链接'] ?? ''} onInput={event => set('链接', (event.target as HTMLInputElement).value)} />
          </label>
        )}
        <label class="field meta-grid__wide">
          <span class="label">一句话</span>
          <input class="input" value={values['一句话'] ?? ''} onInput={event => set('一句话', (event.target as HTMLInputElement).value)} />
        </label>
      </div>
      <p class="hint">留空的字段不会写进文件，covers 之后再补。你写的值永远不会被脚本改写。</p>
    </Dialog>
  )
}
