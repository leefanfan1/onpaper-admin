/**
 * The post list.
 *
 * A ledger, not a card grid: one row per post, a rule between them, the date in
 * the margin the way the site puts it there. The columns that matter for
 * editing are the ones that are visible — title, date, tags, word count — and
 * the row itself is the link into the editor.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, isApiError, type PostSummary } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { navigate } from '../lib/router'
import { Empty, ErrorBox, Loading, formatDate, useConfirm } from '../components/ui'
import { ActionButton, SkeletonRows } from '../components/feedback'

export function PostsView({ ctx, siteId }: { ctx: AppContext, siteId: number }): ComponentChildren {
  const [posts, setPosts] = useState<PostSummary[] | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [error, setError] = useState<Error | null>(null)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [status, setStatus] = useState<'all' | 'published' | 'draft'>('all')
  /*
   * The language filter, and whether any post declares one.
   *
   * `lang` only exists in a newer theme's schema, so a site built on an older
   * one has '' everywhere — and a filter offering two languages that match
   * nothing is worse than no filter. It appears only when the site uses it.
   */
  const [lang, setLang] = useState<'all' | 'zh' | 'en'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [confirmElement, confirm] = useConfirm()
  const [refreshing, setRefreshing] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = async (showProgress = false) => {
    setError(null)
    if (showProgress) setRefreshing(true)
    try {
      const params = new URLSearchParams()
      if (tag) params.set('tag', tag)
      if (status !== 'all') params.set('status', status)
      const result = await api.get<{ posts: PostSummary[], tags: string[], total: number }>(
        `/api/sites/${siteId}/posts?${params}`,
      )
      setPosts(result.posts)
      setTags(result.tags)
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    }
    finally {
      setRefreshing(false)
    }
  }

  useEffect(() => { void load() }, [siteId, tag, status])

  /**
   * Import Markdown files.
   *
   * The files are read as text in the browser and sent together, so a batch is
   * one commit and one build. A conflict is not silently overwritten: the
   * server refuses it, and the report names the post so the author can decide.
   */
  const importFiles = async (list: FileList | null) => {
    if (!list?.length) return
    const chosen = [...list].filter(file => /\.(md|markdown|mdx)$/i.test(file.name))
    if (!chosen.length) {
      ctx.toast('warn', '只接受 .md / .markdown 文件')
      return
    }

    const tooBig = chosen.find(file => file.size > 2 * 1024 * 1024)
    if (tooBig) {
      ctx.toast('danger', `${tooBig.name} 超过 2 MB`)
      return
    }

    try {
      const files = await Promise.all(chosen.map(async file => ({
        name: file.name,
        content: await file.text(),
      })))
      const result = await api.post<{
        imported: Array<{ slug: string, title: string, path: string, created: boolean }>
        rejected: Array<{ name: string, reason: string }>
        conflicts: string[]
      }>(`/api/sites/${siteId}/posts/import`, { files })

      const parts: string[] = []
      if (result.imported.length) parts.push(`导入 ${result.imported.length} 篇`)
      if (result.rejected.length) parts.push(`${result.rejected.length} 个无法解析`)
      if (result.conflicts.length) parts.push(`${result.conflicts.length} 个已存在`)
      ctx.toast(
        result.rejected.length || result.conflicts.length ? 'warn' : 'ok',
        parts.join(' · ') || '没有可导入的文件',
      )
      if (result.rejected.length) {
        ctx.toast('danger', result.rejected.map(item => `${item.name}：${item.reason}`).join('；'))
      }
      if (result.conflicts.length) {
        ctx.toast('warn', `这些文章已存在，未覆盖：${result.conflicts.join('、')}`)
      }
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
    finally {
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  // Filtering is local: the server already returned the whole list for this
  // site, and a round trip per keystroke would make typing feel heavy.
  const hasLanguages = useMemo(
    () => Boolean(posts?.some(post => post.lang)),
    [posts],
  )

  const visible = useMemo(() => {
    if (!posts) return []
    const needle = query.trim().toLowerCase()
    return posts.filter((post) => {
      if (lang !== 'all' && (post.lang || 'zh') !== lang) return false
      if (!needle) return true
      return `${post.title} ${post.description} ${post.tags.join(' ')} ${post.slug}`
        .toLowerCase()
        .includes(needle)
    })
  }, [posts, query, lang])

  const toggle = (slug: string) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  const allSelected = visible.length > 0 && visible.every(post => selected.has(post.slug))

  const toggleAll = () => {
    setSelected(current => {
      if (allSelected) {
        const next = new Set(current)
        for (const post of visible) next.delete(post.slug)
        return next
      }
      return new Set([...current, ...visible.map(post => post.slug)])
    })
  }

  const runBatch = async (op: string, extra: Record<string, unknown> = {}) => {
    if (!selected.size) return
    const labels: Record<string, string> = {
      publish: '发布', unpublish: '转为草稿', pin: '置顶', unpin: '取消置顶', delete: '删除',
    }
    if (op === 'delete') {
      const ok = await confirm({
        title: `删除 ${selected.size} 篇文章？`,
        message: '这会从仓库里删掉这些文件，历史里还能找回，但站点会立刻少掉这些页面。',
        confirmLabel: '删除',
        danger: true,
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const result = await api.post<{ count: number }>(`/api/sites/${siteId}/posts/batch`, {
        slugs: [...selected],
        op,
        ...extra,
      })
      ctx.toast('ok', `已${labels[op] ?? op} ${result.count} 篇`)
      setSelected(new Set())
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
    finally {
      setBusy(false)
    }
  }

  if (error) return <ErrorBox error={error} onRetry={() => { void load() }} />

  /*
    The head and the toolbar render immediately and stay put.

    They used to be inside a `if (!posts) return <SkeletonRows/>` early return,
    so on every visit the whole page — title, buttons, filters — appeared only
    after the GitHub round trip, pushing everything down when it arrived. On a
    phone with 13 posts that is a visible jump on every navigation. Only the
    list area waits now, in the shape it will have.
  */
  const loaded = posts !== null

  return (
    <div class="stack">
      <PageHead
        title="文章"
        description={
          // Always a line, even before the data arrives. Omitting it while
          // loading made the list start higher and then drop when the count
          // appeared — the jump in the screenshots.
          loaded
            ? `${posts.length} 篇 · 置顶 ${posts.filter(post => post.pin > 0).length} · 草稿 ${posts.filter(post => post.draft).length}`
            : '读取中…'
        }
        actions={
          <div class="row">
            <input
              ref={fileInput}
              type="file"
              accept=".md,.markdown,.mdx,text/markdown"
              multiple
              class="sr-only"
              id="md-import"
              onChange={event => void importFiles((event.target as HTMLInputElement).files)}
            />
            <label class="btn" for="md-import">上传 Markdown</label>
            <button
              type="button"
              class="btn btn--primary"
              onClick={() => navigate({ name: 'new-post', siteId })}
            >
              写新文章
            </button>
          </div>
        }
      />

      <div class="toolbar">
        <input
          class="input toolbar__search"
          type="search"
          placeholder="搜索标题、摘要、标签"
          aria-label="搜索文章"
          value={query}
          onInput={event => setQuery((event.target as HTMLInputElement).value)}
        />
        <select
          class="select"
          aria-label="按标签筛选"
          value={tag}
          onChange={event => setTag((event.target as HTMLSelectElement).value)}
        >
          <option value="">全部标签</option>
          {tags.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <select
          class="select"
          aria-label="按状态筛选"
          value={status}
          onChange={event => setStatus((event.target as HTMLSelectElement).value as typeof status)}
        >
          <option value="all">全部状态</option>
          <option value="published">已发布</option>
          <option value="draft">草稿</option>
        </select>
        {hasLanguages && (
          <select
            class="select"
            aria-label="按语言筛选"
            value={lang}
            onChange={event => setLang((event.target as HTMLSelectElement).value as typeof lang)}
          >
            <option value="all">全部语言</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        )}
      </div>

      {selected.size > 0 && (
        <div class="bulkbar" role="region" aria-label="批量操作">
          <span>已选 {selected.size} 篇</span>
          <div class="row">
            <button type="button" class="btn btn--sm" disabled={busy} onClick={() => void runBatch('publish')}>发布</button>
            <button type="button" class="btn btn--sm" disabled={busy} onClick={() => void runBatch('unpublish')}>转为草稿</button>
            <button type="button" class="btn btn--sm" disabled={busy} onClick={() => void runBatch('pin', { pin: 1 })}>置顶</button>
            <button type="button" class="btn btn--sm" disabled={busy} onClick={() => void runBatch('unpin')}>取消置顶</button>
            <button type="button" class="btn btn--sm btn--danger" disabled={busy} onClick={() => void runBatch('delete')}>删除</button>
            <button type="button" class="btn btn--sm btn--ghost" onClick={() => setSelected(new Set())}>取消选择</button>
          </div>
        </div>
      )}

      {!loaded ? (
        <SkeletonRows rows={7} />
      ) : !visible.length ? (
        <Empty
          title={query || tag || status !== 'all' || lang !== 'all' ? '没有符合条件的文章' : '还没有文章'}
          action={
            <button type="button" class="btn btn--primary" onClick={() => navigate({ name: 'new-post', siteId })}>
              写第一篇
            </button>
          }
        >
          {query || tag || status !== 'all' || lang !== 'all'
            ? '换一个关键词，或把筛选清掉。'
            : '新建一篇文章，保存后会直接提交到仓库。'}
        </Empty>
      ) : (
        <table class="ledger">
          <caption class="sr-only">文章列表</caption>
          <thead>
            <tr>
              <th scope="col" class="ledger__check">
                <input
                  type="checkbox"
                  aria-label="全选当前列表"
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </th>
              <th scope="col">标题</th>
              <th scope="col">日期</th>
              <th scope="col" class="ledger__num">字数</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(post => (
              <tr key={post.slug} class="ledger__row">
                <td class="ledger__check">
                  <input
                    type="checkbox"
                    aria-label={`选择《${post.title}》`}
                    checked={selected.has(post.slug)}
                    onChange={() => toggle(post.slug)}
                  />
                </td>
                <th scope="row" class="ledger__title">
                  {/* The title is the row's link. Putting the checkbox inside
                      the anchor would make every selection also navigate, and
                      Space on a focused checkbox would open the editor. */}
                  <a
                    class="ledger__link"
                    href={`#/sites/${siteId}/posts/${encodeURIComponent(post.slug)}`}
                  >
                    {post.pin > 0 && <span class="pin" title={`置顶权重 ${post.pin}`} aria-hidden="true">↑ </span>}
                    <span class="ledger__name">{post.title}</span>
                    {post.pin > 0 && <span class="sr-only">（置顶）</span>}
                  </a>
                  {/* Only on a site that actually mixes languages: a badge
                      saying "en" on every row of an English blog says nothing. */}
                  {hasLanguages && post.lang === 'en' && (
                    <span class="mark mark--muted ledger__lang">EN</span>
                  )}
                  {post.description && <span class="ledger__desc">{post.description}</span>}
                </th>
                <td class="ledger__date">{formatDate(post.published)}</td>
                <td class="ledger__words ledger__num">{post.words.toLocaleString('zh-CN')}</td>
                <td class="ledger__state">
                  <span class={`mark mark--${post.draft ? 'muted' : 'ok'}`}>
                    {post.draft ? '草稿' : '已发布'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmElement}
    </div>
  )
}
