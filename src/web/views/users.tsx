/**
 * Administrators.
 *
 * Access decides who may reach the panel; this table decides what they may do
 * once they are through. Both have to say yes, so removing someone here takes
 * effect immediately even if their Access session is still valid.
 */

import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, isApiError } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { ErrorBox, Loading, formatDate, useConfirm } from '../components/ui'
import { SkeletonRows } from '../components/feedback'
import { useT } from '../lib/i18n'

interface UserRow {
  email: string
  role: 'owner' | 'editor'
  created_at: string
  last_seen: string | null
}

export function UsersView({ ctx }: { ctx: AppContext }): ComponentChildren {
  const { t } = useT()
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'owner' | 'editor'>('editor')
  const [confirmElement, confirm] = useConfirm()

  const load = async () => {
    try {
      const result = await api.get<{ users: UserRow[] }>('/api/users')
      setUsers(result.users)
      setError(null)
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    }
  }

  useEffect(() => { void load() }, [])

  const add = async () => {
    try {
      await api.post('/api/users', { email, role })
      setEmail('')
      ctx.toast('ok', t('users.added'))
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  const remove = async (user: UserRow) => {
    const ok = await confirm({
      title: t('users.removeTitle', user.email),
      message: t('users.removeBody'),
      confirmLabel: t('common.remove'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.delete(`/api/users/${encodeURIComponent(user.email)}`)
      ctx.toast('ok', t('users.removed'))
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
        title={t('users.title')}
        description={t('users.subtitle')}
      />

      {error && <ErrorBox error={error} onRetry={() => { void load() }} />}
      {!users && !error && <SkeletonRows rows={4} />}

      {isOwner && (
        <div class="toolbar">
          <input
            class="input toolbar__search"
            type="email"
            placeholder="someone@example.com"
            aria-label={t('users.emailAria')}
            value={email}
            onInput={event => setEmail((event.target as HTMLInputElement).value)}
          />
          <select
            class="select"
            aria-label={t('users.roleAria')}
            value={role}
            onChange={event => setRole((event.target as HTMLSelectElement).value as typeof role)}
          >
            <option value="editor">{t('users.roleEditor')}</option>
            <option value="owner">{t('users.roleOwner')}</option>
          </select>
          <button type="button" class="btn btn--primary" disabled={!email.trim()} onClick={() => void add()}>
            {t('users.add')}
          </button>
        </div>
      )}

      {users && <div class="ledger ledger--list" role="table" aria-label={t('users.title')}>
        <div class="ledger__head" role="row">
          <span role="columnheader">{t('users.colEmail')}</span>
          <span role="columnheader">{t('users.colRole')}</span>
          <span role="columnheader">{t('users.colLastSeen')}</span>
          <span role="columnheader" />
        </div>
        {users.map(user => (
          <div key={user.email} class="ledger__row ledger__row--static" role="row">
            <span class="ledger__name" role="cell">
              {user.email}
              {user.email === ctx.health.user.email && <span class="muted">{t('users.you')}</span>}
            </span>
            <span role="cell">
              <span class={`mark mark--${user.role === 'owner' ? 'ok' : 'muted'}`}>{user.role}</span>
            </span>
            <span class="muted" role="cell">{user.last_seen ? formatDate(user.last_seen) : t('users.never')}</span>
            <span role="cell">
              {isOwner && user.email !== ctx.health.user.email && (
                <button type="button" class="btn btn--sm btn--danger" onClick={() => void remove(user)}>
                  {t('common.remove')}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>}

      {confirmElement}
    </div>
  )
}
