/**
 * The audit log and the commit history.
 *
 * Two views of the same question — "what changed, and who changed it". The
 * audit log answers for the panel; the commit list answers for the repo, which
 * includes everything done outside the panel too.
 */

import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, type AuditEntry, type CommitSummary } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { SkeletonRows } from '../components/feedback'
import { Empty, ErrorBox, Loading, formatDate, relativeTime } from '../components/ui'

export function AuditView({ ctx, siteId }: { ctx: AppContext, siteId: number }): ComponentChildren {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.get<{ entries: AuditEntry[] }>(`/api/audit?site=${siteId}&limit=200`)
        setEntries(result.entries)
      }
      catch (caught) {
        setError(caught instanceof Error ? caught : new Error(String(caught)))
      }
    })()
  }, [siteId])

  /*
   * The head is drawn before the data arrives, so the page does not start
   * short and grow. Measured on the real panel: without this, the audit page
   * began 120px higher and settled at 120 after loading.
   */
  return (
    <div class="stack">
      <PageHead
        title="审计"
        description="面板里的每一次写入都记在这里。日志不含任何令牌。"
      />

      {error && <ErrorBox error={error} />}
      {!entries && !error && <SkeletonRows rows={6} />}

      {entries && !entries.length ? (
        <Empty title="还没有记录">做过一次修改之后，这里会出现第一条。</Empty>
      ) : entries ? (
        <div class="ledger ledger--list" role="table" aria-label="审计日志">
          <div class="ledger__head" role="row">
            <span role="columnheader">时间</span>
            <span role="columnheader">操作</span>
            <span role="columnheader">对象</span>
            <span role="columnheader">提交</span>
            <span role="columnheader">人</span>
          </div>
          {entries.map(entry => (
            <div key={entry.id} class="ledger__row ledger__row--static" role="row">
              <span class="muted" role="cell" title={entry.created_at}>{relativeTime(entry.created_at)}</span>
              <span class="mono" role="cell">{entry.action}</span>
              <span class="mono ledger__target" role="cell">{entry.target || '—'}</span>
              <span role="cell">
                {entry.commit_sha ? (
                  <a
                    class="mono"
                    href={`https://github.com/${ctx.site?.owner}/${ctx.site?.repo}/commit/${entry.commit_sha}`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {entry.commit_sha.slice(0, 7)}
                  </a>
                ) : '—'}
              </span>
              <span class="muted" role="cell">{entry.email}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function HistoryView({ ctx, siteId }: { ctx: AppContext, siteId: number }): ComponentChildren {
  const [commits, setCommits] = useState<CommitSummary[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.get<{ commits: CommitSummary[] }>(`/api/sites/${siteId}/commits`)
        setCommits(result.commits)
      }
      catch (caught) {
        setError(caught instanceof Error ? caught : new Error(String(caught)))
      }
    })()
  }, [siteId])

  return (
    <div class="stack">
      <PageHead
        title="提交"
        description={`${ctx.site?.owner}/${ctx.site?.repo} · ${ctx.site?.branch} 上的最近提交，包括面板之外做的改动。`}
      />

      {error && <ErrorBox error={error} />}
      {!commits && !error && <SkeletonRows rows={6} />}

      {commits && !commits.length ? (
        <Empty title="没有提交" />
      ) : commits ? (
        <div class="ledger ledger--list" role="table" aria-label="提交历史">
          <div class="ledger__head" role="row">
            <span role="columnheader">时间</span>
            <span role="columnheader">说明</span>
            <span role="columnheader">SHA</span>
            <span role="columnheader">作者</span>
          </div>
          {commits.map(commit => (
            <a
              key={commit.sha}
              class="ledger__row ledger__row--static"
              role="row"
              href={commit.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              <span class="muted" role="cell">{formatDate(commit.date)}</span>
              <span class="ledger__name" role="cell">{commit.message}</span>
              <span class="mono" role="cell">{commit.sha.slice(0, 7)}</span>
              <span class="muted" role="cell">{commit.author}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  )
}
