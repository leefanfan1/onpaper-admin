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
        title="总览"
        description={`${data.sites.length} 个站点${attention ? ` · ${data.tasks.open} 个任务进行中 · ${data.tasks.recentFailures} 个待处理` : ' · 一切正常'}`}
      />

      {attention && (
        <div class="notice" role="status">
          {data.tasks.open > 0 && <p>{data.tasks.open} 个任务正在运行，完成后会写回仓库。</p>}
          {data.tasks.recentFailures > 0 && (
            <p>{data.tasks.recentFailures} 个任务在最近 7 天失败或待确认。去任务中心看是哪一步。</p>
          )}
        </div>
      )}

      {!data.sites.length ? (
        <Empty
          title="还没连接任何站点"
          action={<a class="btn btn--primary" href="#/sites">连接一个仓库</a>}
        >
          面板通过 GitHub 读写仓库，站点可以是任意一个 OnPaper 主题的博客仓库。
        </Empty>
      ) : (
        <div class="ledger ledger--list" role="table" aria-label="站点列表">
          <div class="ledger__head" role="row">
            <span role="columnheader">站点</span>
            <span role="columnheader">仓库</span>
            <span role="columnheader">最近任务</span>
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
                    <span class="muted">{relativeTime(item.lastTask.created_at)}</span>
                  </span>
                ) : (
                  <span class="muted">还没运行过</span>
                )}
              </span>
            </a>
          ))}
        </div>
      )}

      <section class="stack">
        <h2>面板能做什么</h2>
        <dl class="capabilities">
          <dt>文章</dt>
          <dd>新建、编辑、删除、改网址、批量发布与置顶；Markdown 编辑与实时预览。</dd>
          <dt>页面与友链</dt>
          <dd>关于页、最近页、友链列表；「最近」按在听 / 在读 / 在看三段编辑。</dd>
          <dt>书架</dt>
          <dd>书单、片单、歌单逐条增删改，一键触发 <code class="mono">npm run covers</code> 补封面。</dd>
          <dt>站点配置</dt>
          <dd>站名、导航、社交链接、配色 token、功能开关；只改值，注释原样保留。</dd>
          <dt>媒体</dt>
          <dd>图片上传与管理，<code class="mono">og.svg</code> 编辑后触发重新生成。</dd>
          <dt>任务</dt>
          <dd><code class="mono">covers</code>、<code class="mono">music</code>、<code class="mono">og</code>、<code class="mono">build</code> 在 GitHub Actions 上运行，面板显示步骤级状态与改动摘要。</dd>
        </dl>
      </section>
    </div>
  )
}
