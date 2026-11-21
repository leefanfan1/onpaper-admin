/**
 * GitHub REST client, scoped to what the panel does.
 *
 * Every method takes the site it acts on, so a caller cannot accidentally use
 * one site's credential against another's repo. Errors are translated into a
 * small set of codes the UI can explain — a 404 on a path is "the file is not
 * there", not "GitHub said Not Found" — and the response body is never passed
 * through to the browser unread.
 */

export class GithubError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'GithubError'
    this.status = status
    this.code = code
  }
}

export interface RepoTarget {
  owner: string
  repo: string
  branch: string
  /** The token to use — resolved by the caller from a secret or an encrypted row. */
  token: string
}

const API = 'https://api.github.com'
const UA = 'onpaper-admin'

interface RequestOptions {
  method?: string
  body?: unknown
  accept?: string
  signal?: AbortSignal
}

async function request<T>(target: RepoTarget, path: string, options: RequestOptions = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${API}${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${target.token}`,
    Accept: options.accept ?? 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
  }
  catch (error) {
    throw new GithubError(0, 'NETWORK', `无法连接 GitHub：${error instanceof Error ? error.message : String(error)}`)
  }

  if (response.status === 401) {
    throw new GithubError(401, 'AUTH', 'GitHub 令牌无效或已过期')
  }
  if (response.status === 403) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    if (remaining === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
      const minutes = Math.max(1, Math.ceil((reset - Date.now()) / 60000))
      throw new GithubError(403, 'RATE_LIMIT', `GitHub 接口额度用尽，约 ${minutes} 分钟后恢复`)
    }
    throw new GithubError(403, 'FORBIDDEN', 'GitHub 拒绝了这个操作，请检查令牌权限')
  }
  if (response.status === 404) {
    throw new GithubError(404, 'NOT_FOUND', '文件或仓库不存在')
  }
  if (response.status === 409 || response.status === 422) {
    const body = await response.json().catch(() => ({})) as { message?: string }
    throw new GithubError(response.status, 'CONFLICT', body.message ?? '文件在此期间被修改，请刷新后重试')
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new GithubError(response.status, 'HTTP', `GitHub 返回 ${response.status}${body ? `：${body.slice(0, 200)}` : ''}`)
  }
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

function repoPath(target: RepoTarget): string {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

export interface ContentFile {
  path: string
  sha: string
  content: string
  encoding: 'utf-8'
  size: number
}

interface RawContent {
  type: string
  path: string
  sha: string
  content?: string
  size?: number
  encoding?: string
}

/** Read one file. A directory returns `kind: 'dir'` rather than throwing. */
export async function getFile(
  target: RepoTarget,
  path: string,
): Promise<ContentFile | { kind: 'dir', entries: Array<{ name: string, path: string, type: string, size: number }> }> {
  const raw = await request<RawContent | RawContent[]>(
    target,
    `${repoPath(target)}/contents/${encodePath(path)}?ref=${encodeURIComponent(target.branch)}`,
  )
  if (Array.isArray(raw)) {
    return {
      kind: 'dir',
      entries: raw.map(entry => ({
        name: entry.path.split('/').pop() ?? entry.path,
        path: entry.path,
        type: entry.type,
        size: entry.size ?? 0,
      })),
    }
  }
  if (raw.type !== 'file') {
    throw new GithubError(400, 'NOT_FILE', `${path} 不是文件`)
  }
  // GitHub returns base64 with newlines. `atob` gives a binary string, one
  // char per byte; those bytes are then decoded as UTF-8. Doing it in one step
  // per chunk (rather than spreading the whole array into `fromCharCode`)
  // avoids a large-array spread and keeps每 byte exact.
  const base64 = (raw.content ?? '').replace(/\s/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i) & 0xff
  }
  // `fatal: true` would throw on a malformed byte; the panel then reports a
  // post it cannot read instead of silently writing U+FFFD back into it.
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    throw new GithubError(422, 'ENCODING', `${path} 不是有效的 UTF-8 文本，面板不会改写它`)
  }
  return {
    path: raw.path,
    sha: raw.sha,
    content,
    encoding: 'utf-8',
    size: raw.size ?? bytes.length,
  }
}

export interface WriteResult {
  path: string
  sha: string
  commit: string
}

/** Create or update one file, with the caller's sha as the optimistic lock. */
export async function putFile(
  target: RepoTarget,
  path: string,
  content: string,
  sha: string | undefined,
  message: string,
): Promise<WriteResult> {
  const body: Record<string, unknown> = {
    message,
    content: base64Encode(content),
    branch: target.branch,
  }
  if (sha) body.sha = sha
  const result = await request<{ content: { sha: string, path: string }, commit: { sha: string } }>(
    target,
    `${repoPath(target)}/contents/${encodePath(path)}`,
    { method: 'PUT', body },
  )
  return { path: result.content.path, sha: result.content.sha, commit: result.commit.sha }
}

export async function deleteFile(
  target: RepoTarget,
  path: string,
  sha: string,
  message: string,
): Promise<{ commit: string }> {
  const result = await request<{ commit: { sha: string } }>(
    target,
    `${repoPath(target)}/contents/${encodePath(path)}`,
    { method: 'DELETE', body: { message, sha, branch: target.branch } },
  )
  return { commit: result.commit.sha }
}

// ---------------------------------------------------------------------------
// Git Data — a multi-file commit that either lands whole or not at all.
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string
  content?: string
  sha?: string
  delete?: boolean
}

/**
 * Commit several changes at once.
 *
 * Used for anything that touches more than one file — saving a post and its
 * images, renaming a slug, editing config plus nav. A sequence of `putFile`
 * calls would leave the repo in a half-applied state if one failed, and Pages
 * would build that state.
 */
export async function commitFiles(
  target: RepoTarget,
  changes: FileChange[],
  message: string,
): Promise<{ commit: string, tree: string }> {
  if (!changes.length) throw new GithubError(400, 'EMPTY', '没有要提交的改动')

  const ref = await request<{ object: { sha: string } }>(
    target,
    `${repoPath(target)}/git/ref/heads/${encodeURIComponent(target.branch)}`,
  )
  const baseCommitSha = ref.object.sha
  const baseCommit = await request<{ tree: { sha: string } }>(
    target,
    `${repoPath(target)}/git/commits/${baseCommitSha}`,
  )

  const tree: Array<{ path: string, mode: '100644', type: 'blob', sha: string | null }> = []
  for (const change of changes) {
    if (change.delete) {
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const blob = await request<{ sha: string }>(target, `${repoPath(target)}/git/blobs`, {
      method: 'POST',
      body: { content: change.content ?? '', encoding: 'utf-8' },
    })
    tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  const newTree = await request<{ sha: string }>(target, `${repoPath(target)}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseCommit.tree.sha, tree },
  })
  const commit = await request<{ sha: string }>(target, `${repoPath(target)}/git/commits`, {
    method: 'POST',
    body: { message, tree: newTree.sha, parents: [baseCommitSha] },
  })
  await request(target, `${repoPath(target)}/git/refs/heads/${encodeURIComponent(target.branch)}`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
  })

  return { commit: commit.sha, tree: newTree.sha }
}

// ---------------------------------------------------------------------------
// Trees, commits (reads for the list views)
// ---------------------------------------------------------------------------

export interface TreeEntry {
  path: string
  type: string
  sha: string
  size?: number
}

export async function listTree(target: RepoTarget, path = ''): Promise<TreeEntry[]> {
  const ref = await request<{ object: { sha: string } }>(
    target,
    `${repoPath(target)}/git/ref/heads/${encodeURIComponent(target.branch)}`,
  )
  const tree = await request<{ tree: TreeEntry[], truncated: boolean }>(
    target,
    `${repoPath(target)}/git/trees/${ref.object.sha}?recursive=1`,
  )
  if (tree.truncated) {
    // A truncated tree silently hides files, which would make a media list
    // look like the repo lost them.
    throw new GithubError(413, 'TREE_TRUNCATED', '仓库文件过多，GitHub 返回的目录树被截断')
  }
  return path
    ? tree.tree.filter(entry => entry.path.startsWith(`${path}/`) || entry.path === path)
    : tree.tree
}

export interface CommitSummary {
  sha: string
  message: string
  author: string
  date: string
  url: string
}

export async function listCommits(
  target: RepoTarget,
  path?: string,
  limit = 30,
): Promise<CommitSummary[]> {
  const query = new URLSearchParams({ sha: target.branch, per_page: String(Math.min(limit, 100)) })
  if (path) query.set('path', path)
  const commits = await request<Array<{
    sha: string
    commit: { message: string, author: { name: string, date: string } }
    html_url: string
  }>>(target, `${repoPath(target)}/commits?${query}`)
  return commits.map(item => ({
    sha: item.sha,
    message: item.commit.message.split('\n')[0],
    author: item.commit.author.name,
    date: item.commit.author.date,
    url: item.html_url,
  }))
}

/** The diff stat of one commit — what a task actually changed. */
export async function commitStat(
  target: RepoTarget,
  sha: string,
): Promise<{ files: Array<{ path: string, additions: number, deletions: number, status: string }>, total: number }> {
  const commit = await request<{ files?: Array<{ filename: string, additions: number, deletions: number, status: string }>, stats?: { total: number } }>(
    target,
    `${repoPath(target)}/commits/${sha}`,
  )
  return {
    files: (commit.files ?? []).map(file => ({
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      status: file.status,
    })),
    total: commit.stats?.total ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface WorkflowRun {
  id: number
  status: string
  conclusion: string | null
  createdAt: string
  updatedAt: string
  htmlUrl: string
  event: string
  headBranch: string
  displayTitle: string
  runAttempt?: number
}

interface RawRun {
  id: number
  status: string
  conclusion: string | null
  created_at: string
  updated_at: string
  html_url: string
  event: string
  head_branch: string
  display_title?: string
  run_attempt?: number
}

function toRun(raw: RawRun): WorkflowRun {
  return {
    id: raw.id,
    status: raw.status,
    conclusion: raw.conclusion,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    htmlUrl: raw.html_url,
    event: raw.event,
    headBranch: raw.head_branch,
    displayTitle: raw.display_title ?? '',
    runAttempt: raw.run_attempt,
  }
}

/**
 * Dispatch the panel's task workflow.
 *
 * `return_run_details` asks GitHub to hand back the run id synchronously, which
 * saves a window of "which run is mine?" guessing. Older deployments ignore the
 * flag and return 204, so the caller falls back to matching by time.
 */
export async function dispatchWorkflow(
  target: RepoTarget,
  workflowFile: string,
  inputs: Record<string, string>,
): Promise<WorkflowRun | null> {
  const result = await request<RawRun | undefined>(
    target,
    `${repoPath(target)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
    {
      method: 'POST',
      body: { ref: target.branch, inputs, return_run_details: true },
      accept: 'application/vnd.github+json',
    },
  )
  return result && typeof result === 'object' && 'id' in result ? toRun(result) : null
}

export async function listRuns(target: RepoTarget, limit = 20): Promise<WorkflowRun[]> {
  const runs = await request<{ workflow_runs: RawRun[] }>(
    target,
    `${repoPath(target)}/actions/runs?per_page=${Math.min(limit, 100)}`,
  )
  return runs.workflow_runs.map(toRun)
}

export async function getRun(target: RepoTarget, runId: number): Promise<WorkflowRun> {
  const raw = await request<RawRun>(target, `${repoPath(target)}/actions/runs/${runId}`)
  return toRun(raw)
}

export interface RunStep {
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  number: number
}

export interface RunJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  steps: RunStep[]
  htmlUrl: string
}

/** Per-step status — the panel's answer to "which step failed?". */
export async function getRunJobs(target: RepoTarget, runId: number): Promise<RunJob[]> {
  const jobs = await request<{ jobs: Array<{
    id: number
    name: string
    status: string
    conclusion: string | null
    started_at: string | null
    completed_at: string | null
    html_url: string
    steps?: Array<{ name: string, status: string, conclusion: string | null, started_at: string | null, completed_at: string | null, number: number }>
  }> }>(target, `${repoPath(target)}/actions/runs/${runId}/jobs`)
  return jobs.jobs.map(job => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    htmlUrl: job.html_url,
    steps: (job.steps ?? []).map(step => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      startedAt: step.started_at,
      completedAt: step.completed_at,
      number: step.number,
    })),
  }))
}

export async function cancelRun(target: RepoTarget, runId: number): Promise<void> {
  await request(target, `${repoPath(target)}/actions/runs/${runId}/cancel`, { method: 'POST', body: {} })
}

/** The authenticated user, used to explain whose token is in play. */
export async function getViewer(target: RepoTarget): Promise<{ login: string, name: string }> {
  return await request<{ login: string, name: string }>(target, '/user')
}

// ---------------------------------------------------------------------------

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * UTF-8 to base64 without a Buffer.
 *
 * `btoa` takes a binary string, so the path is via TextEncoder → bytes →
 * latin1 string. Doing it the other way (`btoa(unescape(encodeURIComponent()))`)
 * is the deprecated trick and mangles astral characters.
 */
export function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

// ---------------------------------------------------------------------------
// GraphQL — one round trip instead of one per file.
// ---------------------------------------------------------------------------

export interface BlobText {
  name: string
  path: string
  text: string
  sha: string
}

/**
 * Read every file under a directory in one request.
 *
 * The REST Contents API returns one file per call, so a thirteen-post index cost
 * thirteen round trips — six seconds from a slow link, which is what made the
 * article list feel broken. GitHub's GraphQL API returns the text of every blob
 * in a tree in one response, and the cost is then a single round trip plus the
 * page size.
 *
 * A directory with more entries than the page limit is walked in pages rather
 * than silently truncated: a list that quietly misses posts is worse than a
 * slow one.
 */
export async function readDirectory(target: RepoTarget, dir: string): Promise<BlobText[]> {
  const files: BlobText[] = []
  let after: string | null = null

  for (let page = 0; page < 10; page++) {
    const query = `query($owner: String!, $name: String!, $expr: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        object(expression: $expr) {
          ... on Tree {
            entries {
              name
              type
              object {
                ... on Blob {
                  text
                  oid
                }
              }
            }
            # GraphQL's tree entries are not paginated in the public schema, so
            # one page is the whole directory; the loop is defensive.
          }
        }
      }
    }`

    const body = await request<{
      data?: { repository?: { object?: { entries?: Array<{
        name: string
        type: string
        object?: { text?: string, oid?: string }
      }> } } }
      errors?: Array<{ message: string, type?: string }>
    }>(target, '/graphql', {
      method: 'POST',
      body: {
        query,
        variables: {
          owner: target.owner,
          name: target.repo,
          expr: `${target.branch}:${dir}`,
          after,
        },
      },
    })

    if (body.errors?.length) {
      // A GraphQL error is still an error; do not return a partial list that
      // looks like "this directory is empty".
      throw new GithubError(400, 'GRAPHQL', `GitHub GraphQL：${body.errors[0].message}`)
    }

    const entries = body.data?.repository?.object?.entries
    if (!entries) {
      // Not a tree — an empty directory or a missing path.
      return files
    }

    for (const entry of entries) {
      if (entry.type !== 'blob' || typeof entry.object?.text !== 'string') continue
      files.push({
        name: entry.name,
        path: `${dir}/${entry.name}`,
        text: entry.object.text,
        sha: entry.object.oid ?? '',
      })
    }
    break
  }

  return files
}
