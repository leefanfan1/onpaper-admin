/**
 * Tasks: start a run, follow it, cancel it, install the workflow.
 */

import type { Hono } from 'hono'
import type { PanelEnv } from '../middleware'
import { audit, requireOwner } from '../middleware'
import { getFile, listRuns, putFile } from '../lib/github'
import {
  cancelTask,
  getTaskRow,
  isCommitting,
  listTaskRows,
  reconcileOpenTasks,
  reconcileTask,
  startTask,
  TASK_KINDS,
  TaskError,
  validateArgs,
  WORKFLOW_PATH,
  type TaskKind,
} from '../tasks'
import { WORKFLOW_INSTALL_PATH, WORKFLOW_TEMPLATE } from '../workflow-template'
import { authOf, handle, limitParam, readJson, siteOf, targetOf, writeBudget } from './shared'
import { cached, invalidateSite } from '../lib/cache'
import { storeOf } from '../store'

const MAX_TASKS_PER_HOUR = 30

export function registerTaskRoutes(api: Hono<PanelEnv>): void {
  /** What can be run, and whether the channel is installed. */
  /*
   * Cached, briefly, and for a reason.
   *
   * This route exists to answer "is the task channel installed?", which only
   * changes when someone installs it — from this panel, which invalidates this
   * key, or by hand, which the TTL covers. Without the cache every poll of the
   * task screen paid a GitHub round trip for a boolean that had not moved:
   * measured at three seconds per poll from a phone.
   */
  api.get('/sites/:siteId/tasks/meta', async (c) => {
    try {
      const site = await siteOf(c)
      const payload = await cached(c.env, { siteId: site.id, branch: site.branch, name: 'tasks-meta' }, async () => {
        const target = await targetOf(c, site)
        const installed = await getFile(target, WORKFLOW_INSTALL_PATH).then(() => true).catch(() => false)
        return {
          kinds: Object.entries(TASK_KINDS).map(([kind, description]) => ({
            kind,
            description,
            commits: isCommitting(kind as TaskKind),
          })),
          workflow: { path: WORKFLOW_PATH, installed },
        }
      })
      return c.json(payload)
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /**
   * The task list.
   *
   * Reconciling on read is what makes "yesterday's run" correct: any row still
   * open is checked against GitHub before the list is returned, so the panel
   * never shows a stale `in_progress` for a run that finished overnight.
   */

  /*
   * Literal paths are registered before the parameterised one.
   *
   * Hono matches routes in registration order, so a `GET /tasks/:taskId`
   * declared earlier swallowed `/tasks/workflow` and `/tasks/runs`: the install
   * button asked for the workflow template, the id route received the word
   * "workflow", and the panel answered 500 "任务不存在". Keep these above
   * `:taskId`.
   */
  api.get('/sites/:siteId/tasks/workflow', async (c) => {
    try {
      const site = await siteOf(c)
      const target = await targetOf(c, site)
      const existing = await getFile(target, WORKFLOW_INSTALL_PATH).catch(() => null) as
        | { content: string, sha: string }
        | null
      const current = existing?.content ?? ''
      return c.json({
        path: WORKFLOW_INSTALL_PATH,
        installed: Boolean(existing),
        current,
        template: WORKFLOW_TEMPLATE,
        // A site that installed an older template sees the difference rather
        // than a silent overwrite.
        differs: current.trim() !== WORKFLOW_TEMPLATE.trim(),
      })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  /**
   * Install or update the workflow.
   *
   * This is the one write outside the content allowlist, and it is deliberately
   * a separate endpoint with an exact target: nothing else in the panel can
   * touch `.github/`.
   */
  api.get('/sites/:siteId/tasks/runs', async (c) => {
    try {
      const site = await siteOf(c)
      const target = await targetOf(c, site)
      const runs = await listRuns(target, limitParam(c, 20, 50))
      return c.json({ runs })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.get('/sites/:siteId/tasks', async (c) => {
    try {
      const site = await siteOf(c)
      /*
       * One reconcile per row, not two.
       *
       * This used to call `reconcileOpenTasks` (which walks the open rows and
       * asks GitHub about each) and then `reconcileTask` on every row again —
       * so an open task cost two round trips and the list took three seconds.
       * `reconcileOpenTasks` is for the case where the caller only needs the
       * rows, so the list route skips it and lets `reconcileTask` do the work
       * once, in parallel.
       */
      const rows = await listTaskRows(c.env, site.id, limitParam(c, 30, 100))
      const views = await Promise.all(rows.map(row => reconcileTask(c.env, site, row).catch(() => row)))
      return c.json({ tasks: views })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.get('/sites/:siteId/tasks/:taskId', async (c) => {
    try {
      const site = await siteOf(c)
      const id = Number.parseInt(c.req.param('taskId'), 10)
      const row = await getTaskRow(c.env, site.id, id)
      const view = await reconcileTask(c.env, site, row, true)
      return c.json({ task: view })
    }
    catch (error) {
      return handle(c, error)
    }
  })

  api.post('/sites/:siteId/tasks', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const auth = authOf(c)

      // A runaway client must not be able to burn the Actions minutes the free
      // plan allows, so triggering is budgeted separately from ordinary writes.
      const store = storeOf(c.env)
      const cutoff = Date.now() - 60 * 60 * 1000
      const recent = await store.filter<{ created_at: string, site_id: number }>(
        'tasks',
        row => row.site_id === site.id && Date.parse(row.created_at) > cutoff,
      )
      if (recent.length >= MAX_TASKS_PER_HOUR) {
        return c.json({ error: `一小时内最多触发 ${MAX_TASKS_PER_HOUR} 个任务`, code: 'TASK_BUDGET' }, 429)
      }

      const body = await readJson<{ kind: string, args?: string }>(c)
      const { kind, args } = validateArgs(String(body.kind ?? ''), body.args ?? '')
      const row = await startTask(c.env, site, kind, args, auth.user.email)

      await audit(c.env, {
        siteId: site.id,
        email: auth.user.email,
        action: 'task.start',
        target: `${kind}${args ? ` ${args}` : ''}`,
        detail: { runId: row.run_id },
      })
      return c.json({ task: row }, 202)
    }
    catch (error) {
      if (error instanceof TaskError) {
        return c.json({ error: error.message, code: error.code }, 400)
      }
      return handle(c, error)
    }
  })

  api.post('/sites/:siteId/tasks/:taskId/cancel', async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const id = Number.parseInt(c.req.param('taskId'), 10)
      const row = await getTaskRow(c.env, site.id, id)
      await cancelTask(c.env, site, row)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: 'task.cancel',
        target: String(id),
        detail: { runId: row.run_id },
      })
      return c.json({ ok: true })
    }
    catch (error) {
      if (error instanceof TaskError) {
        return c.json({ error: error.message, code: error.code }, 400)
      }
      return handle(c, error)
    }
  })

  /** The panel's own workflow, for the install confirmation to show. */
  api.put('/sites/:siteId/tasks/workflow', requireOwner, async (c) => {
    const limited = await writeBudget(c)
    if (limited) return limited
    try {
      const site = await siteOf(c)
      const target = await targetOf(c, site)
      const existing = await getFile(target, WORKFLOW_INSTALL_PATH).catch(() => null) as { content: string, sha: string } | null

      const result = await putFile(
        target,
        WORKFLOW_INSTALL_PATH,
        WORKFLOW_TEMPLATE,
        existing?.sha,
        existing ? 'chore: 更新面板任务通道' : 'ci: 添加面板任务通道',
      )
      // The install/uninstall answer is cached; this is the one writer that
      // can change it, so it clears here rather than waiting out the TTL.
      await invalidateSite(c.env, site.id, site.branch)
      await audit(c.env, {
        siteId: site.id,
        email: authOf(c).user.email,
        action: existing ? 'task.workflow.update' : 'task.workflow.install',
        target: WORKFLOW_INSTALL_PATH,
        commit: result.commit,
      })
      return c.json({ ok: true, sha: result.sha, commit: result.commit })
    }
    catch (error) {
      return handle(c, error)
    }
  })

}
