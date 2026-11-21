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
import { useT } from '../lib/i18n'

export function SitesView({ ctx }: { ctx: AppContext }): ComponentChildren {
  const { t } = useT()
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
      title: t('sites.disconnectTitle', site.name),
      message: t('sites.disconnectBody'),
      confirmLabel: t('sites.disconnect'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.delete(`/api/sites/${site.id}`)
      ctx.toast('ok', t('sites.disconnected'))
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
        title={t('sites.title')}
        description={t('sites.subtitle')}
        actions={
          isOwner && (
            <button type="button" class="btn btn--primary" onClick={() => setEditing('new')}>
              {t('sites.connect')}
            </button>
          )
        }
      />

      {error && <ErrorBox error={error} onRetry={() => { void load() }} />}
      {!sites && !error && <SkeletonRows rows={3} />}

      {sites && !sites.length ? (
        <Empty title={t('sites.empty')}>
          {isOwner ? t('sites.emptyOwner') : t('sites.emptyEditor')}
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
                    : <p class="mark mark--warn">{t('sites.noPublicUrl')}</p>}
                </div>
                <div class="row">
                  <a class="btn btn--sm" href={`#/sites/${site.id}/posts`}>{t('sites.enter')}</a>
                  {isOwner && (
                    <>
                      <button type="button" class="btn btn--sm" onClick={() => setEditing(site)}>{t('common.edit')}</button>
                      <button type="button" class="btn btn--sm btn--danger" onClick={() => void remove(site)}>{t('sites.disconnect')}</button>
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
  const { t } = useT()
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
        toast('ok', t('sites.connected'))
      }
      else if (site) {
        await api.put(`/api/sites/${site.id}`, { name, owner, repo, branch, patRef, publicUrl })
        toast('ok', t('common.saved'))
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
      toast('ok', t('sites.tokenSaved'))
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
      title={isNew ? t('sites.connectTitle') : t('sites.editTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void submit()}>
            {busy ? t('common.saving') : isNew ? t('sites.connect') : t('common.save')}
          </button>
        </>
      }
    >
      <div class="stack">
        <label class="field">
          <span class="label">{t('sites.displayName')}</span>
          <input class="input" value={name} onInput={event => setName((event.target as HTMLInputElement).value)} placeholder={t('sites.namePlaceholder')} />
        </label>
        <div class="meta-grid">
          <label class="field">
            <span class="label">{t('sites.owner')}</span>
            <input class="input mono" value={owner} onInput={event => setOwner((event.target as HTMLInputElement).value)} placeholder="leefanfan1" />
          </label>
          <label class="field">
            <span class="label">{t('sites.repo')}</span>
            <input class="input mono" value={repo} onInput={event => setRepo((event.target as HTMLInputElement).value)} placeholder="cijianfanfan" />
          </label>
          <label class="field">
            <span class="label">{t('sites.branch')}</span>
            <input class="input mono" value={branch} onInput={event => setBranch((event.target as HTMLInputElement).value)} placeholder="main" />
          </label>
          <label class="field meta-grid__wide">
            <span class="label">{t('sites.publicUrl')}</span>
            <input
              class="input mono"
              value={publicUrl}
              placeholder="https://liff.cc"
              onInput={event => setPublicUrl((event.target as HTMLInputElement).value)}
            />
            <span class="hint">{t('sites.publicUrlHint')}</span>
          </label>
          <label class="field">
            <span class="label">{t('sites.patRef')}</span>
            <input class="input mono" value={patRef} onInput={event => setPatRef((event.target as HTMLInputElement).value)} placeholder={t('sites.patRefPlaceholder')} />
            <span class="hint">{t('sites.patRefHint')}</span>
          </label>
        </div>

        {!isNew && (
          <div class="stack">
            <label class="field">
              <span class="label">{t('sites.token')}</span>
              <div class="row">
                <input
                  class="input mono"
                  type="password"
                  autocomplete="off"
                  value={token}
                  onInput={event => setToken((event.target as HTMLInputElement).value)}
                  placeholder="ghp_… / github_pat_…"
                />
                <button type="button" class="btn" disabled={!token.trim()} onClick={() => void saveToken()}>
                  {t('sites.tokenSave')}
                </button>
              </div>
              <span class="hint">{t('sites.tokenHint')}</span>
            </label>

            <div class="row">
              <button type="button" class="btn btn--sm" onClick={() => void runCheck()}>{t('sites.check')}</button>
              {check && (
                <span class={`mark mark--${check.looksLikeOnPaper ? 'ok' : 'warn'}`}>
                  {check.looksLikeOnPaper ? t('sites.checkOk') : t('sites.checkPartial')}
                </span>
              )}
            </div>

            {check && (
              <dl class="checklist">
                <div><dt>{t('sites.repoFiles')}</dt><dd>{t('sites.fileCount', check.repo.files)}</dd></div>
                <div><dt>{t('sites.tokenIdentity')}</dt><dd class="mono">{check.token.login ?? check.token.error}</dd></div>
                <div><dt>{t('sites.structConfig')}</dt><dd>{check.structure.config ? '✓' : '✗'} src/config.ts</dd></div>
                <div><dt>{t('sites.structPosts')}</dt><dd>{check.structure.posts ? '✓' : '✗'}</dd></div>
                <div><dt>{t('sites.structChannel')}</dt><dd>{check.structure.taskWorkflow ? `✓ ${t('tasks.installed')}` : `✗ ${t('sites.channelMissing')}`}</dd></div>
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
