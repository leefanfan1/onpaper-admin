/**
 * The task channel: run an npm script on GitHub Actions and report on it.
 *
 * The Worker cannot run `npm run covers` (no filesystem, no sharp, no
 * Playwright, and Douban blocks datacenter IPs). Actions can, with the theme's
 * scripts unchanged. So the panel's job is narrow and well-defined:
 *
 *   dispatch a workflow  →  remember which run it is  →  reconcile its status
 *
 * The `tasks` table is the source of truth, not memory, because a run outlives
 * the page that started it. Anything still open is re-checked against GitHub
 * whenever the panel is opened, so "in progress" never means "I stopped
 * looking".
 */

import type { Env } from './env'
import type { Site } from './sites'
import { tokenFor } from './sites'
import { storeOf } from './store'
import { invalidateSite } from './lib/cache'
import {
  cancelRun,
  commitStat,
  dispatchWorkflow,
  getRun,
  getRunJobs,
  GithubError,
  listRuns,
  type RepoTarget,
} from './lib/github'

/** The npm scripts the panel may run, and what each one is for. */
export const TASK_KINDS = {
  covers: '补全书单 / 片单 / 歌单 / 「最近」的字段与封面',
  music: '解析并缓存 ::music 链接，下载卡片封面',
  og: '从 public/og.svg 重新生成 public/og.png',
  build: '构建站点，验证改动没有破坏页面',
  'build:clean': '清理内容缓存后构建',
  clean: '只清理 .astro 缓存（不提交任何文件）',
  shots: 'Playwright 截图检查（会先起 dev server）',
  'test:shelf': '跑书架相关的回归测试',
  'test:render': '跑 Markdown 渲染测试',
  'test:font-source': '检查字体来源安全边界',
} as const

export type TaskKind = keyof typeof TASK_KINDS

export const WORKFLOW_FILE = 'admin-task.yml'  // .github/workflows/admin-task.yml
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`

/**
 * Tasks whose whole point is a commit. `build`, `clean` and the tests write
 * nothing, and the workflow is told not to push for them — a `build` that
 * pushed would create an empty commit on every click.
 */
const COMMITTING: ReadonlySet<TaskKind> = new Set(['covers', 'music', 'og'])

export function isCommitting(kind: TaskKind): boolean {
  return COMMITTING.has(kind)
}

export class TaskError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TaskError'
    this.code = code
  }
}

/**
 * Validate a run request before it reaches GitHub.
 *
 * `args` becomes a workflow input, which the workflow passes through `env` —
 * never spliced into a `run:` line. Even so, it is filtered here: a value with
 * `;`, `$()` or backticks has no legitimate use in "only these entries", and
 * refusing it early keeps the injection surface at zero rather than "handled
 * downstream".
 */
export function validateArgs(kind: string, rawArgs: string): { kind: TaskKind, args: string } {
  if (!Object.prototype.hasOwnProperty.call(TASK_KINDS, kind)) {
    throw new TaskError('TASK_KIND', `不支持的任务 ${kind}`)
  }
  const args = String(rawArgs ?? '').trim()
  if (args.length > 200) throw new TaskError('TASK_ARGS', '参数过长（最多 200 字符）')
  /*
   * An entry title, not a command line.
   *
   * Explicit ranges rather than `\p{Script=Han}`: the Unicode property escape is
   * not reliably supported in the Workers runtime, and a title like 「100 种生活」
   * was rejected there while passing in Node — the two runtimes disagreed about
   * the same regex.
   *
   * The ranges cover the CJK blocks the theme's text uses, plus the full-width
   * punctuation an editorial title is likely to contain.
   */
  const ALLOWED = /^[㐀-䶿一-鿿豈-﫿A-Za-z0-9 _.\-/《》()（），、：；！？·—…「」『』]+$/
  if (args && !ALLOWED.test(args)) {
    throw new TaskError('TASK_ARGS', '参数只能包含中英文、数字、空格和常见标点')
  }
  // `--` would let the argument list be extended; `-` at the start reads as a
  // flag to npm. The scripts take entry titles, never flags.
  if (/(^|\s)--/.test(args) || /^-/.test(args)) {
    throw new TaskError('TASK_ARGS', '参数不能以 - 开头，也不能包含 --')
  }
  return { kind: kind as TaskKind, args }
}

export interface TaskRow {
  id: number
  site_id: number
  kind: string
  args: string
  run_id: number | null
  status: string
  conclusion: string | null
  triggered_by: string
  result_json: string
  log_url: string
  created_at: string
  updated_at: string
}

async function targetFor(env: Env, site: Site): Promise<RepoTarget> {
  return {
    owner: site.owner,
    repo: site.repo,
    branch: site.branch,
    token: await tokenFor(env, site),
  }
}

/**
 * Start a run and record it.
 *
 * GitHub's `return_run_details` gives the run id directly. Where it is ignored
 * (older deployments return 204), the id is recovered by listing runs and
 * taking the newest one created after this dispatch — matched on the workflow
 * file and branch, and only accepted when its timestamp is after the moment we
 * asked, so a run already in flight cannot be mistaken for ours.
 */
export async function startTask(
  env: Env,
  site: Site,
  kind: TaskKind,
  args: string,
  email: string,
): Promise<TaskRow> {
  const target = await targetFor(env, site)
  const dispatchedAt = Date.now()

  let run: { id: number, htmlUrl: string } | null = null
  try {
    const detailed = await dispatchWorkflow(target, WORKFLOW_FILE, {
      task: kind,
      args,
      commit: isCommitting(kind) ? 'true' : 'false',
    })
    if (detailed) run = { id: detailed.id, htmlUrl: detailed.htmlUrl }
  }
  catch (error) {
    if (error instanceof GithubError && error.status === 404) {
      throw new TaskError(
        'TASK_CHANNEL',
        '任务通道还没安装：仓库里没有 .github/workflows/admin-task.yml，请先在「任务中心」安装',
      )
    }
    if (error instanceof GithubError && error.status === 403) {
      throw new TaskError('TASK_PERMISSION', '令牌缺少 Actions 权限（需要 Actions: write）')
    }
    throw error
  }

  if (!run) {
    // Wait briefly for the run to appear, then match it.
    for (let attempt = 0; attempt < 4 && !run; attempt++) {
      if (attempt) await sleep(1200)
      const runs = await listRuns(target, 10).catch(() => [])
      const match = runs.find(candidate =>
        candidate.headBranch === site.branch
        && Date.parse(candidate.createdAt) >= dispatchedAt - 5000,
      )
      if (match) run = { id: match.id, htmlUrl: match.htmlUrl }
    }
  }

  const store = storeOf(env)
  const all = await store.all<TaskRow>('tasks')
  const id = all.reduce((max, item) => Math.max(max, item.id), 0) + 1
  const now = new Date().toISOString()
  const row: TaskRow = {
    id,
    site_id: site.id,
    kind,
    args,
    run_id: run?.id ?? null,
    status: run ? 'queued' : 'unknown',
    conclusion: null,
    triggered_by: email,
    result_json: '{}',
    log_url: run?.htmlUrl ?? `https://github.com/${site.owner}/${site.repo}/actions`,
    created_at: now,
    updated_at: now,
  }
  await store.put('tasks', String(id), row)
  return row
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Map a GitHub run onto the panel's status vocabulary. */
function statusOf(status: string, conclusion: string | null): { status: string, conclusion: string | null } {
  if (status === 'completed') {
    const map: Record<string, string> = {
      success: 'success',
      failure: 'failure',
      cancelled: 'cancelled',
      skipped: 'cancelled',
      timed_out: 'failure',
      action_required: 'failure',
    }
    return { status: map[conclusion ?? ''] ?? 'unknown', conclusion }
  }
  if (status === 'in_progress') return { status: 'in_progress', conclusion: null }
  if (status === 'queued' || status === 'waiting' || status === 'pending' || status === 'requested') {
    return { status: 'queued', conclusion: null }
  }
  return { status: 'unknown', conclusion }
}

export interface TaskView extends TaskRow {
  /** Per-job step detail, only fetched while a run is open or on request. */
  jobs?: Array<{ name: string, status: string, conclusion: string | null, steps: Array<{ name: string, status: string, conclusion: string | null }> }>
  /** What the run actually changed, once it succeeded. */
  result?: {
    commit?: string
    files?: Array<{ path: string, additions: number, deletions: number, status: string }>
    total?: number
    summary?: string
  }
}

/**
 * Bring one task row up to date with GitHub.
 *
 * Only open rows are polled: a finished run's conclusion does not change, and
 * re-fetching it would burn rate limit for no information. A row that cannot
 * be matched becomes `unknown` rather than staying hopefully `queued`.
 */
export async function reconcileTask(env: Env, site: Site, row: TaskRow, withJobs = false): Promise<TaskView> {
  const view: TaskView = { ...row }
  if (!row.run_id) {
    return view
  }
  if (row.status !== 'queued' && row.status !== 'in_progress' && row.status !== 'unknown') {
    // Finished: serve the stored result; jobs are only fetched on demand.
    if (withJobs) {
      const jobs = await getRunJobs(await targetFor(env, site), row.run_id).catch(() => [])
      view.jobs = jobs
    }
    view.result = parseResult(row.result_json)
    return view
  }

  const target = await targetFor(env, site)
  let run
  try {
    run = await getRun(target, row.run_id)
  }
  catch (error) {
    if (error instanceof GithubError && error.status === 404) {
      // The run was deleted (or retention cleaned it up). Do not pretend.
      await markTask(env, row.id, { status: 'unknown', conclusion: null })
      return { ...view, status: 'unknown' }
    }
    throw error
  }

  const mapped = statusOf(run.status, run.conclusion)
  const changed = mapped.status !== row.status || mapped.conclusion !== row.conclusion

  if (mapped.status === 'success' && isCommitting(row.kind as TaskKind)) {
    // The run's success is only half the answer — the useful half is what it
    // committed. Ask for the commit it pushed.
    const commit = await findRunCommit(target, run.createdAt).catch(() => '')
    if (commit) {
      const stat = await commitStat(target, commit).catch(() => null)
      const result = {
        commit,
        files: stat?.files ?? [],
        total: stat?.total ?? 0,
        summary: summarize(row.kind as TaskKind, stat?.files ?? []),
      }
      await markTask(env, row.id, {
        status: mapped.status,
        conclusion: mapped.conclusion,
        resultJson: JSON.stringify(result),
        logUrl: run.htmlUrl,
      })
      /*
       * A task that commits changed files the panel shows.
       *
       * `covers` writes the shelf entries, `music` rewrites posts — but the
       * read caches were filled before the run and nothing here would have
       * dropped them, so the screen that started the task showed its old
       * content after the task said it succeeded. Only invalidated on the
       * transition, so polling a finished task does not keep clearing it.
       */
      if (changed || !row.result_json) {
        await invalidateSite(env, site.id, site.branch)
      }
      return { ...view, status: mapped.status, conclusion: mapped.conclusion, result, result_json: JSON.stringify(result) }
    }
  }

  if (changed || withJobs) {
    await markTask(env, row.id, {
      status: mapped.status,
      conclusion: mapped.conclusion,
      logUrl: run.htmlUrl,
    })
  }

  if (withJobs) {
    const jobs = await getRunJobs(target, row.run_id).catch(() => [])
    view.jobs = jobs
  }
  if (changed && mapped.status === 'success' && !isCommitting(row.kind as TaskKind)) {
    const result = { summary: `${TASK_KINDS[row.kind as TaskKind] ?? row.kind} 已完成（未提交文件）` }
    await markTask(env, row.id, {
      status: mapped.status,
      conclusion: mapped.conclusion,
      resultJson: JSON.stringify(result),
    })
    view.result = result
  }

  return { ...view, status: mapped.status, conclusion: mapped.conclusion }
}

function parseResult(json: string): TaskView['result'] {
  try {
    const parsed = JSON.parse(json || '{}') as TaskView['result']
    return Object.keys(parsed ?? {}).length ? parsed : undefined
  }
  catch {
    return undefined
  }
}

/**
 * The commit a run pushed.
 *
 * The task workflow's last step commits and pushes to the same branch, so the
 * newest commit on that branch created after the run started is the one. This
 * is read-only matching, not a guarantee — if someone pushed in between, the
 * summary names the wrong commit, which is why `jobs` and the log link are
 * shown alongside it.
 */
async function findRunCommit(target: RepoTarget, runStartedAt: string): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits?sha=${encodeURIComponent(target.branch)}&per_page=1`,
    {
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'onpaper-admin',
      },
    },
  )
  if (!response.ok) return ''
  const commits = await response.json() as Array<{ sha: string, commit: { author: { date: string } } }>
  const latest = commits[0]
  if (!latest) return ''
  const started = Date.parse(runStartedAt)
  return Date.parse(latest.commit.author.date) >= started ? latest.sha : ''
}

/** Turn a diff stat into the one line the task list shows. */
function summarize(kind: TaskKind, files: Array<{ path: string, status: string, additions: number }>): string {
  if (!files.length) {
    return kind === 'covers' ? '没有需要补全的条目' : '没有文件变化'
  }
  const added = files.filter(file => file.status === 'added').length
  const modified = files.filter(file => file.status === 'modified').length
  const removed = files.filter(file => file.status === 'removed').length

  const covers = files.filter(file => file.path.startsWith('public/shelf/') || file.path.startsWith('public/music/')).length
  const parts: string[] = []
  if (kind === 'covers' && covers) parts.push(`新增封面 ${covers} 张`)
  if (added) parts.push(`新增 ${added} 个文件`)
  if (modified) parts.push(`修改 ${modified} 个文件`)
  if (removed) parts.push(`删除 ${removed} 个文件`)
  return parts.join(' · ') || `${files.length} 个文件有变化`
}

async function markTask(
  env: Env,
  id: number,
  patch: { status: string, conclusion: string | null, resultJson?: string, logUrl?: string },
): Promise<void> {
  const store = storeOf(env)
  const row = await store.get<TaskRow>('tasks', String(id))
  if (!row) return
  await store.put('tasks', String(id), {
    ...row,
    status: patch.status,
    conclusion: patch.conclusion,
    result_json: patch.resultJson ?? row.result_json,
    log_url: patch.logUrl ?? row.log_url,
    updated_at: new Date().toISOString(),
  })
}

/**
 * Reconcile every open task for a site.
 *
 * Called when the panel opens, so a run that finished overnight is already
 * correct by the time the page paints.
 */
export async function reconcileOpenTasks(env: Env, site: Site): Promise<TaskRow[]> {
  const store = storeOf(env)
  const open = (await store.filter<TaskRow>(
    'tasks',
    row => row.site_id === site.id && ['queued', 'in_progress', 'unknown'].includes(row.status),
  )).sort((a, b) => b.id - a.id).slice(0, 20)
  // Sequential on purpose: a burst of parallel GitHub calls is what trips the
  // secondary rate limit, and this runs at most a few times a minute.
  for (const row of open) {
    if (!row.run_id && Date.now() - Date.parse(`${row.created_at}Z`) < 60_000) {
      // Give a just-dispatched run time to appear before calling it unknown.
      continue
    }
    await reconcileTask(env, site, row).catch(() => {})
  }
  return open
}

export async function cancelTask(env: Env, site: Site, row: TaskRow): Promise<void> {
  if (!row.run_id) throw new TaskError('TASK_NO_RUN', '这个任务还没有对应的 run')
  if (row.status !== 'queued' && row.status !== 'in_progress') {
    throw new TaskError('TASK_DONE', '任务已经结束，不能取消')
  }
  await cancelRun(await targetFor(env, site), row.run_id)
  await markTask(env, row.id, { status: 'cancelled', conclusion: 'cancelled' })
}

export async function getTaskRow(env: Env, siteId: number, id: number): Promise<TaskRow> {
  const row = await storeOf(env).get<TaskRow>('tasks', String(id))
  if (!row || row.site_id !== siteId) throw new TaskError('TASK_NOT_FOUND', '任务不存在')
  return row
}

export async function listTaskRows(env: Env, siteId: number, limit = 30): Promise<TaskRow[]> {
  const rows = await storeOf(env).filter<TaskRow>('tasks', row => row.site_id === siteId)
  return rows.sort((a, b) => b.id - a.id).slice(0, Math.min(limit, 100))
}
