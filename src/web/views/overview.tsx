/**
 * The overview: what exists, what is running, what failed.
 *
 * It is a dashboard with a job: when the panel opens, the first question is
 * "is anything wrong?", so open tasks and recent failures are at the top, ahead
 * of the site list.
 */

import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, type Site } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { SkeletonRows } from '../components/feedback'
import { Empty, ErrorBox, Loading, StatusMark, relativeTime } from '../components/ui'
import { useT } from '../lib/i18n'

interface Overview {
  sites: Array<{ id: number, name: string, repo: string, branch: string, enabled: boolean }>
  tasks: { open: number, recentFailures: number }
  lastRuns: Array<{
    siteId: number
    name: string
    lastTask: { status: string, kind: string, created_at: string } | null
  }>
}

export function OverviewView({ ctx }: { ctx: AppContext, route: never }): ComponentChildren {
  const { t } = useT()
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const load = async () => {
    try {
      setData(await api.get<Overview>('/api/overview'))
      setError(null)
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    }
  }

  useEffect(() => { void load() }, [])

  if (error) return <ErrorBox error={error} onRetry={() => { void load() }} />
  if (!data) return <SkeletonRows rows={5} />

  const attention = data.tasks.open > 0 || data.tasks.recentFailures > 0

  return (
    <div class="stack">
      <PageHead
        title={t('overview.title')}
        description={t('overview.subtitle', data.sites.length, data.tasks.open, data.tasks.recentFailures, attention)}
      />

      {attention && (
        <div class="notice" role="status">
          {data.tasks.open > 0 && <p>{t('overview.running', data.tasks.open)}</p>}
          {data.tasks.recentFailures > 0 && (
            <p>{t('overview.failures', data.tasks.recentFailures)}</p>
          )}
        </div>
      )}

      {!data.sites.length ? (
        <Empty
          title={t('overview.noSites')}
          action={<a class="btn btn--primary" href="#/sites">{t('overview.connectOne')}</a>}
        >
          {t('overview.noSitesHint')}
        </Empty>
      ) : (
        <div class="ledger ledger--list" role="table" aria-label={t('nav.aria.sites')}>
          <div class="ledger__head" role="row">
            <span role="columnheader">{t('overview.colSite')}</span>
            <span role="columnheader">{t('overview.colRepo')}</span>
            <span role="columnheader">{t('overview.colLastTask')}</span>
          </div>
          {data.lastRuns.map(item => (
            <a
              key={item.siteId}
              class="ledger__row ledger__row--three"
              role="row"
              href={`#/sites/${item.siteId}/posts`}
            >
              <span class="ledger__title" role="cell">
                <span class="ledger__name">{item.name}</span>
              </span>
              <span class="mono ledger__repo" role="cell">
                {data.sites.find(site => site.id === item.siteId)?.repo}
              </span>
              <span role="cell">
                {item.lastTask ? (
                  <span class="row">
                    <StatusMark status={item.lastTask.status} />
                    <span class="muted mono">{item.lastTask.kind}</span>
                    <span class="muted">{relativeTime(item.lastTask.created_at, t)}</span>
                  </span>
                ) : (
                  <span class="muted">{t('users.never')}</span>
                )}
              </span>
            </a>
          ))}
        </div>
      )}

      <section class="stack">
        <h2>{t('overview.canDo')}</h2>
        <dl class="capabilities">
          <dt>{t('nav.posts')}</dt>
          <dd>{t('overview.doPosts')}</dd>
          <dt>{t('nav.pages')}</dt>
          <dd>{t('overview.doPages')}</dd>
          <dt>{t('nav.shelf')}</dt>
          <dd>{t('overview.doShelf')}</dd>
          <dt>{t('nav.config')}</dt>
          <dd>{t('overview.doConfig')}</dd>
          <dt>{t('nav.media')}</dt>
          <dd>{t('overview.doMedia')}</dd>
          <dt>{t('nav.tasks')}</dt>
          <dd>{t('overview.doTasks')}</dd>
        </dl>
      </section>
    </div>
  )
}
