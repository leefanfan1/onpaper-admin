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
import { useT } from '../lib/i18n'

export function AuditView({ ctx, siteId }: { ctx: AppContext, siteId: number }): ComponentChildren {
  const { t } = useT()
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
        title={t('audit.title')}
        description={t('audit.subtitle')}
      />

      {error && <ErrorBox error={error} />}
      {!entries && !error && <SkeletonRows rows={6} />}

      {entries && !entries.length ? (
        <Empty title={t('audit.empty')}>{t('audit.emptyHint')}</Empty>
      ) : entries ? (
        <div class="ledger ledger--list" role="table" aria-label={t('audit.title')}>
          <div class="ledger__head" role="row">
            <span role="columnheader">{t('common.time')}</span>
            <span role="columnheader">{t('audit.colAction')}</span>
            <span role="columnheader">{t('audit.colTarget')}</span>
            <span role="columnheader">{t('audit.colCommit')}</span>
            <span role="columnheader">{t('audit.colWho')}</span>
          </div>
          {entries.map(entry => (
            <div key={entry.id} class="ledger__row ledger__row--static" role="row">
              <span class="muted" role="cell" title={entry.created_at}>{relativeTime(entry.created_at, t)}</span>
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
  const { t } = useT()
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
        title={t('history.title')}
        description={t('history.subtitle', ctx.site?.owner ?? '', ctx.site?.repo ?? '', ctx.site?.branch ?? '')}
      />

      {error && <ErrorBox error={error} />}
      {!commits && !error && <SkeletonRows rows={6} />}

      {commits && !commits.length ? (
        <Empty title={t('history.empty')} />
      ) : commits ? (
        <div class="ledger ledger--list" role="table" aria-label={t('history.title')}>
          <div class="ledger__head" role="row">
            <span role="columnheader">{t('common.time')}</span>
            <span role="columnheader">{t('history.colMessage')}</span>
            <span role="columnheader">SHA</span>
            <span role="columnheader">{t('history.colAuthor')}</span>
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
