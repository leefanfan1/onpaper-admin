/**
 * The API client.
 *
 * One place that knows how a request is shaped: the CSRF header, the JSON
 * envelope, and the mapping from a server `{ error, code }` to something the UI
 * can show. A caller never handles a raw Response, so a forgotten header cannot
 * turn into a mysterious 403.
 */

export interface ApiError extends Error {
  code: string
  status: number
}

function isApiError(value: unknown): value is ApiError {
  return value instanceof Error && 'code' in value
}

/**
 * The answer to a GET, kept in memory for a few seconds.
 *
 * The server already caches reads in KV, which cuts a round trip from seconds
 * to milliseconds — but milliseconds are still a network hop, and on a phone
 * that hop is 200ms of "正在读取" between two taps on the same tab. Holding the
 * response here makes coming back to a screen you already opened instant.
 *
 * The lifetime is deliberately short and it is dropped on any write, on focus,
 * and when the tab becomes visible again, so what it can ever show stale is a
 * change made in another tab within the last few seconds.
 */
const MEMORY_TTL = 15_000
const memory = new Map<string, { at: number, value: unknown }>()
const inflight = new Map<string, Promise<unknown>>()

function memoryGet<T>(path: string): T | undefined {
  const hit = memory.get(path)
  if (!hit) return undefined
  if (Date.now() - hit.at > MEMORY_TTL) {
    memory.delete(path)
    return undefined
  }
  return hit.value as T
}

/** Forget everything. Used on regaining focus, and by the tests. */
export function forgetReads(): void {
  memory.clear()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) memory.clear()
  })
  window.addEventListener('focus', () => memory.clear())
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  // The server requires this header on every state-changing request; its
  // presence is itself part of the CSRF defence (a cross-origin form cannot
  // set it without a preflight this API never answers).
  if (init.method && init.method !== 'GET') headers.set('X-Panel-CSRF', csrfToken)

  let response: Response
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  }
  catch (error) {
    throw makeError(0, 'NETWORK', `无法连接服务器：${error instanceof Error ? error.message : String(error)}`)
  }

  // (the error message is localised below, once the response body is read)

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  }
  catch {
    body = null
  }

  if (!response.ok) {
    const record = body as { error?: string, code?: string } | null
    const code = record?.code ?? 'HTTP'
    /*
     * The message is chosen here, in the reader's language, from the code the
     * Worker sent.
     *
     * The Worker answers with a stable `code` (`CONFLICT`, `RATE_LIMIT`, …) and
     * a Chinese sentence. Reading the sentence is right when it says something
     * the codes cannot — a GitHub quota window, a file name — so it is kept as
     * the fallback, but a known code gets the dictionary's wording.
     */
    const message = localisedError(code) ?? record?.error ?? `请求失败（${response.status}）`
    throw makeError(response.status, code, message)
  }
  return body as T
}

/**
 * A GET, served from memory when it can be, and de-duplicated otherwise.
 *
 * Two screens mounting at once (the shell and the view, say) must not each
 * open their own request for the same list — that is what turned one tap into
 * three GitHub round trips.
 */
/** Two spellings of the same request must share one key — `/posts` and `/posts?` are the same list. */
function cacheKeyOf(path: string): string {
  return path.endsWith('?') ? path.slice(0, -1) : path
}

async function getJson<T>(path: string): Promise<T> {
  const key = cacheKeyOf(path)
  const hit = memoryGet<T>(key)
  if (hit !== undefined) return hit

  const pending = inflight.get(key)
  if (pending) return pending as Promise<T>

  const promise = request<T>(path)
    .then((value) => {
      memory.set(key, { at: Date.now(), value })
      return value
    })
    .finally(() => { inflight.delete(key) })

  inflight.set(key, promise)
  return promise
}

function makeError(status: number, code: string, message: string): ApiError {
  const error = new Error(message) as ApiError
  error.code = code
  error.status = status
  return error
}

export { isApiError }

/**
 * The CSRF token, rotated with the session.
 *
 * Kept in a module variable rather than localStorage: it is only useful with a
 * live Access session, and storing it would outlive the session it belongs to.
 */
let csrfToken = ''

export async function bootstrap(): Promise<Health> {
  const health = await request<Health>('/api/health')
  csrfToken = health.csrf
  return health
}

export interface Health {
  ok: boolean
  access: { required: boolean, configured: boolean }
  github: { configured: boolean }
  user: { email: string, role: 'owner' | 'editor' }
  csrf: string
  store?: string
}

/**
 * A GET that must not be answered from memory.
 *
 * Polling and "did the run finish?" are the two cases where a cached answer is
 * worse than none: the whole point of the request is that the state changed
 * since the last one. Everything else uses `get`.
 */
async function getFresh<T>(path: string): Promise<T> {
  const key = cacheKeyOf(path)
  memory.delete(key)
  inflight.delete(key)
  const value = await request<T>(path)
  memory.set(key, { at: Date.now(), value })
  return value
}

/** Any write may have changed anything, so the read cache does not survive one. */
function written(): void {
  memory.clear()
}

export const api = {
  get: <T>(path: string) => getJson<T>(path),
  getFresh: <T>(path: string) => getFresh<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
      .finally(written),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) })
      .finally(written),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) })
      .finally(written),
}

/**
 * Ask the Worker to fill every screen's cache for a site.
 *
 * The browser cannot do this well: each screen is a GitHub round trip, and over
 * a phone connection six of them in sequence is ten seconds of a skeleton. The
 * Worker makes the same calls from a much better line and runs them together,
 * so by the time a tab is clicked its answer is already in KV.
 *
 * Fire-and-forget by design. A failure here changes nothing except that the
 * screen loads the normal way, which is why nothing awaits it and nothing
 * reports it.
 */
export function warmSite(siteId: number): void {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean, effectiveType?: string }
  }).connection
  // On a metered or very slow link, guessed-ahead work is the wrong trade.
  if (connection?.saveData) return
  if (connection?.effectiveType && /(^|-)2g$/.test(connection.effectiveType)) return

  void request<{ warmed: string[], failed: string[] }>(
    `/api/sites/${siteId}/warm`,
    { method: 'POST' },
  ).catch(() => {})
}

/**
 * Fetch screens ahead of the click.
 *
 * The panel knows which screens a site has; the person will visit some of them
 * within the next minute or two. Requesting them in the background — one at a
 * time, after the current screen has settled — means the tab they are about to
 * open is already answered. On a metered or slow connection it is skipped
 * rather than spending someone's data on a guess.
 */
export function prefetch(paths: string[]): void {
  if (typeof navigator !== 'undefined') {
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean, effectiveType?: string }
    }).connection
    if (connection?.saveData) return
    if (connection?.effectiveType && /(^|-)2g$/.test(connection.effectiveType)) return
  }

  /*
   * Three at a time, not one.
   *
   * Serially, a six-screen list took the sum of six cold GitHub round trips —
   * by the time the last one started the person had already clicked. Three
   * concurrent requests keep the queue short without flooding a connection
   * that the screen they are reading also needs.
   */
  const run = async () => {
    const queue = [...paths]
    const worker = async () => {
      while (queue.length) {
        // Stop as soon as the tab is gone: their own screen comes first.
        if (document.visibilityState === 'hidden') return
        const path = queue.shift()
        if (!path) return
        await getJson(path).catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 80))
      }
    }
    await Promise.all([worker(), worker(), worker()])
  }

  const idle = (window as Window & { requestIdleCallback?: (fn: () => void) => void }).requestIdleCallback
  if (idle) idle(() => { void run() })
  else setTimeout(() => { void run() }, 400)
}

// --- Shared wire types ------------------------------------------------------

export interface Site {
  id: number
  name: string
  owner: string
  repo: string
  branch: string
  paths: Record<string, string>
  /** The published site, e.g. https://liff.cc — where media is served. */
  publicUrl: string
  enabled: boolean
  createdAt: string
}

export interface PostSummary {
  slug: string
  path: string
  title: string
  description: string
  published: string
  updated?: string
  tags: string[]
  pin: number
  draft: boolean
  /** The post's own language, or '' when the file has no `lang` line. */
  lang: string
  words: number
  minutes: number
  sha: string
}

export interface PostDetail {
  slug: string
  path: string
  sha: string
  frontmatter: {
    title: string
    description: string
    published: string
    updated?: string
    tags: string[]
    pin: number
    draft: boolean
    /** Present only when the file has the line (newer themes). */
    lang?: string
  }
  body: string
  extra: Record<string, string>
  raw: string
  words: number
  minutes: number
  url: string
}

export interface ShelfEntry {
  title: string
  creator: string
  year: string
  note: string
  douban: string
  link: string
  cover: string
  handwrittenCover: boolean
}

export interface ShelfList {
  list: string
  kind: 'book' | 'film' | 'music'
  exists: boolean
  path?: string
  sha?: string
  entries: ShelfEntry[]
  fieldOrder?: string[]
  creatorKey?: string
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
  jobs?: Array<{
    name: string
    status: string
    conclusion: string | null
    steps: Array<{ name: string, status: string, conclusion: string | null }>
  }>
  result?: {
    commit?: string
    total?: number
    summary?: string
    files?: Array<{ path: string, additions: number, deletions: number, status: string }>
  }
}

export interface SiteConfigView {
  title: string
  subtitle: string
  description: string
  author: string
  email: string
  url: string
  lang: string
  locale: string
  startYear: number
  postsPerPage: number
  tocOpen: boolean
  nav: Array<{ key?: string, label?: string, href: string }>
  /** Newer themes fix the interface language at build time. `''` = older theme. */
  i18n: { defaultLang: string }
  socials: Array<{ label: string, href: string, external?: boolean }>
  analytics: { googleAnalyticsId: string }
  theme: { defaultMode: string, light: Record<string, string>, dark: Record<string, string> }
  fonts: { display: string, body: string, mono: string }
  features: Record<string, boolean>
}

export interface AuditEntry {
  id: number
  site_id: number
  email: string
  action: string
  target: string
  detail: string
  commit_sha: string
  created_at: string
}

export interface CommitSummary {
  sha: string
  message: string
  author: string
  date: string
  url: string
}

// ---------------------------------------------------------------------------
// Localised error messages
// ---------------------------------------------------------------------------

/**
 * The panel's current language, for the API layer.
 *
 * The app sets this whenever the language changes. It lives here rather than
 * being passed through every call because the error is constructed inside
 * `request`, far from any component that could supply it — and a wrong-language
 * error is worse than a plain one.
 */
type Translate = (key: never, ...args: unknown[]) => string

let currentTranslate: Translate | null = null

/** Called whenever the panel's language changes; the app owns the translator. */
export function setErrorTranslator(fn: Translate | null): void {
  currentTranslate = fn
}

/** The dictionary's wording for a Worker error code, or `null` when unknown. */
function localisedError(code: string): string | null {
  if (!currentTranslate) return null
  const key = `error.${code}`
  const text = currentTranslate(key as never)
  // The translator echoes an unknown key back; that is the "no entry" signal.
  return text === key ? null : text
}
