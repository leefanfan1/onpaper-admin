/**
 * Tasks.
 *
 * The panel does not run npm scripts; it dispatches them to GitHub Actions and
 * reports on the run. This screen is where "did it work?" is answered in three
 * layers: the run's state, the step that failed, and what the run actually
 * changed when it succeeded.
 *
 * A run outlives the tab that started it, so the list reconciles against GitHub
 * on every open — coming back in the morning shows the real result, never a row
 * stuck on "running".
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api, isApiError, type TaskRow } from '../lib/api'
import type { AppContext } from '../app'
import { PageHead } from '../app'
import { Empty, ErrorBox, Loading, StatusMark, relativeTime, useConfirm } from '../components/ui'
import { SkeletonRows } from '../components/feedback'
import { useT, type Dictionary, type I18n } from '../lib/i18n'

interface Meta {
  kinds: Array<{ kind: string, description: string, commits: boolean }>
  workflow: { path: string, installed: boolean }
}

export function TasksView({ ctx, siteId }: { ctx: AppContext, siteId: number }): ComponentChildren {
  const { t } = useT()
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
      ctx.toast('ok', t('tasks.started'))
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
      ctx.toast('ok', t('tasks.cancelled'))
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
        title: current.installed ? t('tasks.updateChannelTitle') : t('tasks.installTitle'),
        message: current.installed
          ? t('tasks.installConfirmUpdate')
          : t('tasks.installConfirmNew'),
        confirmLabel: current.installed ? t('tasks.update') : t('tasks.installAction'),
      })
      if (!ok) return
      await api.put(`/api/sites/${siteId}/tasks/workflow`)
      ctx.toast('ok', t('tasks.ready'))
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
        title={t('tasks.title')}
        description={t('tasks.subtitle')}
        actions={
          meta && !installed && (
            <button type="button" class="btn btn--primary" onClick={() => void install()}>
              {t('tasks.install')}
            </button>
          )
        }
      />

      {error && <ErrorBox error={error} onRetry={() => { void load(true) }} />}

      {meta && !installed && (
        <div class="notice notice--warn" role="status">
          <p>{t('tasks.notInstalled')}</p>
          <button type="button" class="btn btn--sm" onClick={() => void install()}>{t('tasks.installAction')}</button>
        </div>
      )}

      <div class="toolbar">
        <select class="select" aria-label={t('tasks.selectTask')} value={kind} onChange={event => setKind((event.target as HTMLSelectElement).value)}>
          {(meta?.kinds ?? []).map(item => (
            <option key={item.kind} value={item.kind}>
              {item.kind}{item.commits ? ` (${t('tasks.commits')})` : ''}
            </option>
          ))}
        </select>
        <input
          class="input toolbar__search mono"
          placeholder={t('tasks.argsPlaceholder')}
          aria-label={t('tasks.argsAria')}
          value={args}
          onInput={event => setArgs((event.target as HTMLInputElement).value)}
        />
        <button type="button" class="btn btn--primary" disabled={!installed} onClick={() => void start()}>
          {t('tasks.run')}
        </button>
      </div>
      {/*
        The description comes from the Worker in Chinese, since it is also what
        the task channel's own log prints. On an English panel the dictionary
        wins; an unknown kind falls back to the served text.
      */}
      {selected && (
        <p class="hint">
          {describeKind(selected.kind, selected.description, t)}
          {args ? ` · ${args}` : ''}
        </p>
      )}

      {!tasks ? (
        <SkeletonRows rows={4} />
      ) : !tasks.length ? (
        <Empty title={t('tasks.empty')}>
          {t('tasks.emptyHintPre')} <code class="mono">covers</code>{t('tasks.emptyHintMid')} <code class="mono">music</code>{t('tasks.emptyHintEnd')} <code class="mono">build</code>.
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
  const { t } = useT()
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
          <span class="muted">{relativeTime(task.created_at, t)}</span>
        </div>
        <div class="row">
          {running && (
            <button type="button" class="btn btn--sm btn--danger" onClick={onCancel}>{t('tasks.cancel')}</button>
          )}
          <button type="button" class="btn btn--sm btn--ghost" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? t('tasks.collapse') : t('tasks.details')}
          </button>
          <a class="btn btn--sm btn--ghost" href={task.log_url} target="_blank" rel="noreferrer noopener">
            {t('tasks.logs')}
          </a>
        </div>
      </header>

      {task.status === 'success' && result?.summary && (
        <p class="task__result">{result.summary}{result.commit ? ` · ${result.commit.slice(0, 7)}` : ''}</p>
      )}
      {failed && (
        <p class="task__result task__result--fail">
          {failedStep ? t('tasks.failedStep', failedStep.name) : t('tasks.failed')}
          {task.status === 'unknown' && ` · ${t('tasks.mismatch')}`}
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
                      <span class="step__state">{stepLabel(step.conclusion, step.status, t)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))
          ) : (
            <p class="hint">{t('tasks.noSteps')}</p>
          )}

          {result?.files?.length ? (
            <div class="task__files">
              <h3 class="task__job-name">{t('tasks.changedFiles')}</h3>
              <ul class="files">
                {result.files.map(file => (
                  <li key={file.path} class="file">
                    <span class={`file__status file__status--${file.status}`}>
                      {file.status === 'added' ? t('tasks.fileAdded') : file.status === 'removed' ? t('tasks.fileRemoved') : t('tasks.fileModified')}
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

/**
 * The description of a task kind, in the reader's language.
 *
 * The Worker serves a Chinese description (it is also what the task channel's
 * log prints), so a known kind is looked up in the dictionary instead. An
 * unknown kind — one added to the theme's package.json after this build — falls
 * back to the served text rather than showing a bare key.
 */
function describeKind(kind: string, served: string, t: I18n['t']): string {
  const key = `taskKind.${kind}`
  const text = t(key as keyof Dictionary)
  return text === key ? served : text
}

function stepLabel(conclusion: string | null, status: string, t: I18n['t']): string {
  if (conclusion === 'success') return t('tasks.stepDone')
  if (conclusion === 'failure') return t('tasks.stepFailed')
  if (conclusion === 'skipped') return t('tasks.stepSkipped')
  if (conclusion === 'cancelled') return t('tasks.stepCancelled')
  if (status === 'in_progress') return t('tasks.inProgress')
  if (status === 'queued') return t('tasks.queued')
  return conclusion ?? status
}
