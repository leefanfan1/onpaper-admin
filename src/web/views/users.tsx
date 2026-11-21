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

interface UserRow {
  email: string
  role: 'owner' | 'editor'
  created_at: string
  last_seen: string | null
}

export function UsersView({ ctx }: { ctx: AppContext }): ComponentChildren {
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
      ctx.toast('ok', '已添加')
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  const remove = async (user: UserRow) => {
    const ok = await confirm({
      title: `移除 ${user.email}？`,
      message: '移除后这个人即使通过了 Cloudflare Access 也无法使用面板，立即生效。',
      confirmLabel: '移除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.delete(`/api/users/${encodeURIComponent(user.email)}`)
      ctx.toast('ok', '已移除')
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
        title="管理员"
        description="Cloudflare Access 决定谁能打开面板，这张表决定进来以后能做什么——两者都要通过。"
      />

      {error && <ErrorBox error={error} onRetry={() => { void load() }} />}
      {!users && !error && <SkeletonRows rows={4} />}

      {isOwner && (
        <div class="toolbar">
          <input
            class="input toolbar__search"
            type="email"
            placeholder="someone@example.com"
            aria-label="新管理员邮箱"
            value={email}
            onInput={event => setEmail((event.target as HTMLInputElement).value)}
          />
          <select
            class="select"
            aria-label="角色"
            value={role}
            onChange={event => setRole((event.target as HTMLSelectElement).value as typeof role)}
          >
            <option value="editor">editor — 可编辑内容</option>
            <option value="owner">owner — 还可管理站点与管理员</option>
          </select>
          <button type="button" class="btn btn--primary" disabled={!email.trim()} onClick={() => void add()}>
            添加
          </button>
        </div>
      )}

      {users && <div class="ledger ledger--list" role="table" aria-label="管理员列表">
        <div class="ledger__head" role="row">
          <span role="columnheader">邮箱</span>
          <span role="columnheader">角色</span>
          <span role="columnheader">最近使用</span>
          <span role="columnheader" />
        </div>
        {users.map(user => (
          <div key={user.email} class="ledger__row ledger__row--static" role="row">
            <span class="ledger__name" role="cell">
              {user.email}
              {user.email === ctx.health.user.email && <span class="muted">（你）</span>}
            </span>
            <span role="cell">
              <span class={`mark mark--${user.role === 'owner' ? 'ok' : 'muted'}`}>{user.role}</span>
            </span>
            <span class="muted" role="cell">{user.last_seen ? formatDate(user.last_seen) : '还没用过'}</span>
            <span role="cell">
              {isOwner && user.email !== ctx.health.user.email && (
                <button type="button" class="btn btn--sm btn--danger" onClick={() => void remove(user)}>
                  移除
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
