/**
 * 任务中心.
 *
 * The panel does not run npm scripts; it dispatches them to GitHub Actions and
 * reports on the run. This screen is where "did it work?" is answered in three
 * layers: the run's state, the step that failed, and what the run actually
 * changed when it succeeded.
 *
 * A run outlives the tab that started it, so the list reconciles against GitHub
 * on every open — coming back in the morning shows the real result, never a row
 * stuck on "进行中".
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, isApiError, type TaskRow } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { Empty, ErrorBox, Loading, StatusMark, relativeTime, useConfirm } from '../components/ui'
import { SkeletonRows } from '../components/feedback'

interface Meta {
  kinds: Array<{ kind: string, description: string, commits: boolean }>
  workflow: { path: string, installed: boolean }
}

export function TasksView({ ctx, siteId }: { ctx: AppContext, siteId: number }): ComponentChildren {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [tasks, setTasks] = useState<TaskRow[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [kind, setKind] = useState('covers')
  const [args, setArgs] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [confirmElement, confirm] = useConfirm()
  const timer = useRef<number | null>(null)
  const backoff = useRef(3000)

  const load = async (showLoading = false) => {
    if (showLoading) setTasks(null)
    try {
      const [metaResult, list] = await Promise.all([
        // Both are polled, so both must be read live: a cached answer here
        // would report a finished run as still running.
        api.getFresh<Meta>(`/api/sites/${siteId}/tasks/meta`),
        api.getFresh<{ tasks: TaskRow[] }>(`/api/sites/${siteId}/tasks`),
      ])
      setMeta(metaResult)
      setTasks(list.tasks)
      setError(null)
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)))
    }
  }

  // Poll while something is open, with backoff, and stop when nothing is.
  // The interval lives outside the render so a state update cannot start a
  // second loop.
  useEffect(() => {
    void load(true)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [siteId])

  useEffect(() => {
    if (!tasks) return
    const open = tasks.some(task => task.status === 'queued' || task.status === 'in_progress')
    if (timer.current) window.clearTimeout(timer.current)
    if (!open) {
      backoff.current = 3000
      return
    }
    timer.current = window.setTimeout(() => {
      backoff.current = Math.min(backoff.current * 2, 30_000)
      void load()
    }, backoff.current)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [tasks])

  const start = async () => {
    try {
      await api.post(`/api/sites/${siteId}/tasks`, { kind, args })
      ctx.toast('ok', '已开始')
      setArgs('')
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  const cancel = async (task: TaskRow) => {
    try {
      await api.post(`/api/sites/${siteId}/tasks/${task.id}/cancel`)
      ctx.toast('ok', '已请求取消')
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  const install = async () => {
    // The first request is inside the guard too: it used to sit outside the
    // try, so a failure there left the button doing nothing at all.
    try {
      const current = await api.get<{ installed: boolean, differs: boolean }>(
        `/api/sites/${siteId}/tasks/workflow`,
      )
      const ok = await confirm({
        title: current.installed ? '更新任务通道？' : '安装任务通道？',
        message: current.installed
          ? '仓库里已有一个 admin-task.yml。会更新成面板当前的版本；如果你改过它，改动会被覆盖。'
          : '会在仓库里写 .github/workflows/admin-task.yml。之后仓库所有者需要在 Actions 页面允许这个 workflow 运行。',
        confirmLabel: current.installed ? '更新' : '安装',
      })
      if (!ok) return
      await api.put(`/api/sites/${siteId}/tasks/workflow`)
      ctx.toast('ok', '任务通道已就绪')
      await load()
    }
    catch (caught) {
      ctx.toast('danger', isApiError(caught) ? caught.message : String(caught))
    }
  }

  // The head and the run controls stay put; only the list waits. Returning a
  // loading line made the page 264px shorter until the data arrived.
  const selected = meta?.kinds.find(item => item.kind === kind)
  const installed = meta?.workflow.installed ?? false

  return (
    <div class="stack">
      <PageHead
        title="任务"
        description="npm 脚本在 GitHub Actions 上运行，面板负责触发和显示结果。"
        actions={
          meta && !installed && (
            <button type="button" class="btn btn--primary" onClick={() => void install()}>
              安装任务通道
            </button>
          )
        }
      />

      {error && <ErrorBox error={error} onRetry={() => { void load(true) }} />}

      {meta && !installed && (
        <div class="notice notice--warn" role="status">
          <p>这个仓库还没有任务通道（.github/workflows/admin-task.yml），任务无法触发。</p>
          <button type="button" class="btn btn--sm" onClick={() => void install()}>安装</button>
        </div>
      )}

      <div class="toolbar">
        <select class="select" aria-label="选择任务" value={kind} onChange={event => setKind((event.target as HTMLSelectElement).value)}>
          {(meta?.kinds ?? []).map(item => (
            <option key={item.kind} value={item.kind}>
              {item.kind}{item.commits ? ' （会提交）' : ''}
            </option>
          ))}
        </select>
        <input
          class="input toolbar__search mono"
          placeholder="参数（例如 城南旧事 一一），可留空"
          aria-label="任务参数"
          value={args}
          onInput={event => setArgs((event.target as HTMLInputElement).value)}
        />
        <button type="button" class="btn btn--primary" disabled={!installed} onClick={() => void start()}>
          运行
        </button>
      </div>
      {selected && <p class="hint">{selected.description}{args ? ` · 参数：${args}` : ''}</p>}

      {!tasks ? (
        <SkeletonRows rows={4} />
      ) : !tasks.length ? (
        <Empty title="还没运行过任务">
          补封面跑 <code class="mono">covers</code>；改了音乐卡片跑 <code class="mono">music</code>；想确认改动没问题跑 <code class="mono">build</code>。
        </Empty>
      ) : (
        <div class="tasks">
          {tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              expanded={expanded === task.id}
              onToggle={() => setExpanded(current => (current === task.id ? null : task.id))}
              onCancel={() => void cancel(task)}
            />
          ))}
        </div>
      )}

      {confirmElement}
    </div>
  )
}

function TaskCard({
  task, expanded, onToggle, onCancel,
}: {
  task: TaskRow
  expanded: boolean
  onToggle: () => void
  onCancel: () => void
}): ComponentChildren {
  const result = task.result
  const running = task.status === 'queued' || task.status === 'in_progress'
  const failed = task.status === 'failure' || task.status === 'unknown'
  const failedStep = task.jobs
    ?.flatMap(job => job.steps ?? [])
    .find(step => step.conclusion === 'failure')

  return (
    <article class={`task ${failed ? 'task--failed' : ''}`}>
      <header class="task__head">
        <div class="task__summary">
          <StatusMark status={task.status} />
          <span class="mono task__kind">{task.kind}</span>
          {task.args && <span class="mono muted">{task.args}</span>}
          <span class="muted">{relativeTime(task.created_at)}</span>
        </div>
        <div class="row">
          {running && (
            <button type="button" class="btn btn--sm btn--danger" onClick={onCancel}>取消</button>
          )}
          <button type="button" class="btn btn--sm btn--ghost" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? '收起' : '详情'}
          </button>
          <a class="btn btn--sm btn--ghost" href={task.log_url} target="_blank" rel="noreferrer noopener">
            日志
          </a>
        </div>
      </header>

      {task.status === 'success' && result?.summary && (
        <p class="task__result">{result.summary}{result.commit ? ` · ${result.commit.slice(0, 7)}` : ''}</p>
      )}
      {failed && (
        <p class="task__result task__result--fail">
          {failedStep ? `失败的步骤：${failedStep.name}` : '运行失败'}
          {task.status === 'unknown' && ' · 对不上 GitHub 的 run，请点「日志」确认'}
        </p>
      )}

      {expanded && (
        <div class="task__detail">
          {task.jobs?.length ? (
            task.jobs.map(job => (
              <div key={job.name} class="task__job">
                <h3 class="task__job-name">{job.name}</h3>
                <ol class="steps">
                  {job.steps.map((step, index) => (
                    <li key={index} class={`step step--${step.conclusion ?? step.status}`}>
                      <span class="step__name">{step.name}</span>
                      <span class="step__state">{stepLabel(step.conclusion, step.status)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))
          ) : (
            <p class="hint">没有步骤信息。日志在 GitHub 上，点右上角「日志」。</p>
          )}

          {result?.files?.length ? (
            <div class="task__files">
              <h3 class="task__job-name">改动的文件</h3>
              <ul class="files">
                {result.files.map(file => (
                  <li key={file.path} class="file">
                    <span class={`file__status file__status--${file.status}`}>
                      {file.status === 'added' ? '新增' : file.status === 'removed' ? '删除' : '修改'}
                    </span>
                    <span class="mono file__path">{file.path}</span>
                    <span class="muted">+{file.additions} −{file.deletions}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </article>
  )
}

function stepLabel(conclusion: string | null, status: string): string {
  if (conclusion === 'success') return '完成'
  if (conclusion === 'failure') return '失败'
  if (conclusion === 'skipped') return '跳过'
  if (conclusion === 'cancelled') return '取消'
  if (status === 'in_progress') return '进行中'
  if (status === 'queued') return '排队'
  return conclusion ?? status
}
