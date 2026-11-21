/**
 * Site connections: the repos the panel may edit.
 *
 * Adding a site is an owner action and it is a real grant — once connected, the
 * panel can write to that repo's content paths. The form says which paths and
 * which token, and the connection check answers the three questions a new site
 * raises before anything is edited.
 */

import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, isApiError, type Site } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { Dialog, Empty, ErrorBox, Loading, useConfirm } from '../components/ui'
import { SkeletonRows } from '../components/feedback'

export function SitesView({ ctx }: { ctx: AppContext }): ComponentChildren {
  const [sites, setSites] = useState<Site[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [editing, setEditing] = useState<Site | 'new' | null>(null)
  const [confirmElement, confirm] = useConfirm()

  const load = async () => {
    try {
      const result = await api.get<{ sites: Site[] }>('/api/sites')
      setSites(result.sites)
      setError(null)
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    }
  }

  useEffect(() => { void load() }, [])

  const remove = async (site: Site) => {
    const ok = await confirm({
      title: `断开「${site.name}」？`,
      message: '只会从面板里移除这个站点，仓库和内容都不会被动。审计日志和任务记录会一起清掉。',
      confirmLabel: '断开',
      danger: true,
    })
    if (!ok) return
    try {
      await api.delete(`/api/sites/${site.id}`)
      ctx.toast('ok', '已断开')
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  const isOwner = ctx.health.user.role === 'owner'

  return (
    <div class="stack">
      <PageHead
        title="站点"
        description="面板可以连接任意多个 OnPaper 主题仓库，每个站点独立选择分支和内容路径。"
        actions={
          isOwner && (
            <button type="button" class="btn btn--primary" onClick={() => setEditing('new')}>
              连接仓库
            </button>
          )
        }
      />

      {error && <ErrorBox error={error} onRetry={() => { void load() }} />}
      {!sites && !error && <SkeletonRows rows={3} />}

      {sites && !sites.length ? (
        <Empty title="还没有站点">
          {isOwner ? '点「连接仓库」，填 owner/repo 和分支。' : '需要 owner 添加站点。'}
        </Empty>
      ) : sites ? (
        <div class="stack">
          {sites.map(site => (
            <article key={site.id} class="card">
              <header class="card__head">
                <div>
                  <h2 class="card__title">
                    <a href={`#/sites/${site.id}/posts`}>{site.name}</a>
                  </h2>
                  <p class="mono muted">{site.owner}/{site.repo} · {site.branch}</p>
                  {site.publicUrl
                    ? <p class="mono muted">{site.publicUrl}</p>
                    : <p class="mark mark--warn">未设置站点地址，图片不会显示</p>}
                </div>
                <div class="row">
                  <a class="btn btn--sm" href={`#/sites/${site.id}/posts`}>进入</a>
                  {isOwner && (
                    <>
                      <button type="button" class="btn btn--sm" onClick={() => setEditing(site)}>编辑</button>
                      <button type="button" class="btn btn--sm btn--danger" onClick={() => void remove(site)}>断开</button>
                    </>
                  )}
                </div>
              </header>
              <dl class="paths">
                {Object.entries(site.paths).map(([key, value]) => (
                  <div key={key} class="paths__row">
                    <dt class="muted">{key}</dt>
                    <dd class="mono">{value}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
      ) : null}

      <SiteDialog
        site={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null)
          await load()
        }}
        toast={ctx.toast}
      />

      {confirmElement}
    </div>
  )
}

function SiteDialog({
  site,
  onClose,
  onSaved,
  toast,
}: {
  site: Site | 'new' | null
  onClose: () => void
  onSaved: () => Promise<void>
  toast: AppContext['toast']
}): ComponentChildren {
  const isNew = site === 'new'
  const [name, setName] = useState('')
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('main')
  const [patRef, setPatRef] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<CheckResult | null>(null)

  useEffect(() => {
    if (site === 'new') {
      setName('')
      setOwner('')
      setRepo('')
      setBranch('main')
      setPatRef('')
      setPublicUrl('')
      setToken('')
    }
    else if (site) {
      setName(site.name)
      setOwner(site.owner)
      setRepo(site.repo)
      setBranch(site.branch)
      setPatRef('')
      setPublicUrl(site.publicUrl ?? '')
      setToken('')
      setCheck(null)
    }
    setCheck(null)
  }, [site])

  const submit = async () => {
    setBusy(true)
    try {
      if (isNew) {
        await api.post('/api/sites', { name, owner, repo, branch, patRef, publicUrl })
        toast('ok', '站点已连接')
      }
      else if (site) {
        await api.put(`/api/sites/${site.id}`, { name, owner, repo, branch, patRef, publicUrl })
        toast('ok', '已保存')
      }
      await onSaved()
    }
    catch (caught) {
      toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
    finally {
      setBusy(false)
    }
  }

  const saveToken = async () => {
    if (!site || site === 'new' || !token.trim()) return
    try {
      await api.put(`/api/sites/${site.id}/token`, { token })
      setToken('')
      toast('ok', '令牌已加密保存')
    }
    catch (caught) {
      toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  const runCheck = async () => {
    if (!site || site === 'new') return
    try {
      setCheck(await api.post<CheckResult>(`/api/sites/${site.id}/check`))
    }
    catch (caught) {
      toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  return (
    <Dialog
      open={site !== null}
      title={isNew ? '连接仓库' : '编辑站点'}
      onClose={onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>取消</button>
          <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '保存中…' : isNew ? '连接' : '保存'}
          </button>
        </>
      }
    >
      <div class="stack">
        <label class="field">
          <span class="label">显示名称</span>
          <input class="input" value={name} onInput={event => setName((event.target as HTMLInputElement).value)} placeholder="我的博客" />
        </label>
        <div class="meta-grid">
          <label class="field">
            <span class="label">GitHub 用户名或组织</span>
            <input class="input mono" value={owner} onInput={event => setOwner((event.target as HTMLInputElement).value)} placeholder="your-github-name" />
          </label>
          <label class="field">
            <span class="label">仓库</span>
            <input class="input mono" value={repo} onInput={event => setRepo((event.target as HTMLInputElement).value)} placeholder="your-repo" />
          </label>
          <label class="field">
            <span class="label">分支</span>
            <input class="input mono" value={branch} onInput={event => setBranch((event.target as HTMLInputElement).value)} placeholder="main" />
          </label>
          <label class="field meta-grid__wide">
            <span class="label">站点地址（发布后的域名）</span>
            <input
              class="input mono"
              value={publicUrl}
              placeholder="https://example.com"
              onInput={event => setPublicUrl((event.target as HTMLInputElement).value)}
            />
            <span class="hint">书架封面和媒体库的图片从这里读取；留空则图片无法显示。</span>
          </label>
          <label class="field">
            <span class="label">令牌 secret 名（可选）</span>
            <input class="input mono" value={patRef} onInput={event => setPatRef((event.target as HTMLInputElement).value)} placeholder="留空用默认 GITHUB_PAT" />
            <span class="hint">填了就用这个 Worker secret，不会退回默认令牌。</span>
          </label>
        </div>

        {!isNew && (
          <div class="stack">
            <label class="field">
              <span class="label">这个站点专用令牌（可选）</span>
              <div class="row">
                <input
                  class="input mono"
                  type="password"
                  autocomplete="off"
                  value={token}
                  onInput={event => setToken((event.target as HTMLInputElement).value)}
                  placeholder="ghp_… 或 github_pat_…"
                />
                <button type="button" class="btn" disabled={!token.trim()} onClick={() => void saveToken()}>
                  加密保存
                </button>
              </div>
              <span class="hint">用 AES-GCM 加密后存进 D1，明文只在你提交的这一次请求里出现。</span>
            </label>

            <div class="row">
              <button type="button" class="btn btn--sm" onClick={() => void runCheck()}>检查连接</button>
              {check && (
                <span class={`mark mark--${check.looksLikeOnPaper ? 'ok' : 'warn'}`}>
                  {check.looksLikeOnPaper ? '看起来是 OnPaper 站点' : '结构不完整'}
                </span>
              )}
            </div>

            {check && (
              <dl class="checklist">
                <div><dt>仓库文件</dt><dd>{check.repo.files} 个</dd></div>
                <div><dt>令牌身份</dt><dd class="mono">{check.token.login ?? check.token.error}</dd></div>
                <div><dt>配置</dt><dd>{check.structure.config ? '✓' : '✗'} src/config.ts</dd></div>
                <div><dt>文章</dt><dd>{check.structure.posts ? '✓' : '✗'}</dd></div>
                <div><dt>任务通道</dt><dd>{check.structure.taskWorkflow ? '✓ 已安装' : '✗ 未安装'}</dd></div>
              </dl>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}

interface CheckResult {
  repo: { files: number }
  token: { login?: string, error?: string }
  structure: {
    config: boolean
    posts: boolean
    pages: boolean
    shelf: boolean
    public: boolean
    package: boolean
    taskWorkflow: boolean
  }
  looksLikeOnPaper: boolean
}
