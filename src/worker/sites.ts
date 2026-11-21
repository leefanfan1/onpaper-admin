/**
 * Site records and the credential each one uses.
 *
 * A "site" is a repo the panel may edit. Multiple sites are supported because
 * the theme is a template: one person may run several blogs from it, and the
 * panel should not hard-code one owner/repo pair.
 *
 * Tokens are the sensitive part. The default token is a Worker secret; a site
 * that names its own (`pat_ref`) gets a per-site secret, or an AES-GCM
 * encrypted value in D1 under that site's row. Nothing decrypted ever leaves
 * this module as a value the caller could log by accident — it is handed
 * straight into a GitHub client.
 */

import type { Env } from './env'
import type { SiteRow } from './middleware'
import { DEFAULT_PATHS, type SitePaths } from './lib/paths'
import { storeOf } from './store'

export interface Site {
  id: number
  name: string
  owner: string
  repo: string
  branch: string
  paths: SitePaths
  /** Where the built site is served — `https://liff.cc`. Media lives here. */
  publicUrl: string
  enabled: boolean
  createdAt: string
}

export class SiteError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SiteError'
    this.code = code
  }
}

export function toSite(row: SiteRow): Site {
  let parsed: Partial<SitePaths> = {}
  try {
    parsed = JSON.parse(row.paths_json || '{}') as Partial<SitePaths>
  }
  catch {
    // A corrupt paths column falls back to the theme defaults rather than
    // making the site unreachable.
    parsed = {}
  }
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    paths: { ...DEFAULT_PATHS, ...parsed },
    publicUrl: (row as SiteRow & { public_url?: string }).public_url ?? '',
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  }
}

export async function listSites(env: Env): Promise<Site[]> {
  const rows = await storeOf(env).all<SiteRow>('sites')
  rows.sort((a, b) => a.id - b.id)
  return rows.map(toSite)
}

export async function getSite(env: Env, id: number): Promise<Site> {
  const row = await storeOf(env).get<SiteRow>('sites', String(id))
  if (!row) throw new SiteError('SITE_NOT_FOUND', '站点不存在')
  if (row.enabled !== 1) throw new SiteError('SITE_DISABLED', '这个站点已被停用')
  return toSite(row)
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,200}$/

export interface SiteInput {
  name: string
  owner: string
  repo: string
  branch: string
  paths?: Partial<SitePaths>
  patRef?: string
  /** The published site, e.g. `https://liff.cc`. Must be https or empty. */
  publicUrl?: string
}

export function validateSiteInput(input: SiteInput): SiteInput {
  const name = String(input.name ?? '').trim()
  if (!name) throw new SiteError('SITE_NAME', '站点名称不能为空')

  /*
   * Reject text that was already corrupted before it arrived.
   *
   * U+FFFD is what a decoder writes when it cannot read a byte sequence. In
   * practice it arrives when a client sends UTF-8 bytes that were decoded as
   * something else — a Windows console in GBK, a form posted with the wrong
   * charset. Accepting it stores a permanently mangled name that no later edit
   * can recover, so the write is refused with an explanation instead.
   */
  if (name.includes('�')) {
    throw new SiteError(
      'SITE_ENCODING',
      '站点名称里有无法识别的字符（可能是终端或浏览器编码问题），请重新输入',
    )
  }

  const owner = String(input.owner ?? '').trim()
  if (!OWNER_RE.test(owner)) throw new SiteError('SITE_OWNER', 'GitHub 用户名或组织名不合法')
  const repo = String(input.repo ?? '').trim()
  if (!REPO_RE.test(repo)) throw new SiteError('SITE_REPO', '仓库名不合法')
  const branch = String(input.branch ?? 'main').trim() || 'main'
  // `..` inside a branch name would let a ref read escape the ref namespace.
  if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new SiteError('SITE_BRANCH', '分支名不合法')
  }
  if (input.patRef && !/^[A-Z_][A-Z0-9_]{0,60}$/.test(input.patRef)) {
    throw new SiteError('SITE_PAT_REF', 'per-site 令牌的 secret 名不合法')
  }

  // The public address is used to build image URLs that the panel shows. It is
  // validated here for the same reason every other user-supplied URL is: a
  // `javascript:` value would end up in an `img src` the panel renders.
  const publicUrl = String(input.publicUrl ?? '').trim().replace(/\/+$/, '')
  if (publicUrl) {
    let parsed: URL
    try {
      parsed = new URL(publicUrl)
    }
    catch {
      throw new SiteError('SITE_URL', '站点地址不是完整的网址，例如 https://liff.cc')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new SiteError('SITE_URL', '站点地址只能是 http(s)')
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new SiteError('SITE_URL', '站点地址只填域名，不要带路径')
    }
  }

  return {
    name, owner, repo, branch,
    paths: input.paths,
    patRef: input.patRef ?? '',
    publicUrl,
  }
}

export async function createSite(env: Env, input: SiteInput): Promise<Site> {
  const valid = validateSiteInput(input)
  const store = storeOf(env)
  const rows = await store.all<SiteRow>('sites')
  const duplicate = rows.find(
    row => row.owner === valid.owner && row.repo === valid.repo && row.branch === valid.branch,
  )
  if (duplicate) throw new SiteError('SITE_EXISTS', '这个仓库和分支已经在列表里了')

  const id = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
  await store.put('sites', String(id), {
    id,
    name: valid.name,
    owner: valid.owner,
    repo: valid.repo,
    branch: valid.branch,
    paths_json: JSON.stringify(valid.paths ?? {}),
    pat_ref: valid.patRef ?? '',
    public_url: valid.publicUrl ?? '',
    enabled: 1,
    created_at: new Date().toISOString(),
  } satisfies SiteRow)
  return await getSite(env, id)
}

export async function updateSite(env: Env, id: number, input: SiteInput): Promise<Site> {
  const valid = validateSiteInput(input)
  const store = storeOf(env)
  const row = await store.get<SiteRow>('sites', String(id))
  if (!row) throw new SiteError('SITE_NOT_FOUND', '站点不存在')
  await store.put('sites', String(id), {
    ...row,
    name: valid.name,
    owner: valid.owner,
    repo: valid.repo,
    branch: valid.branch,
    paths_json: JSON.stringify(valid.paths ?? {}),
    pat_ref: valid.patRef ?? '',
    public_url: valid.publicUrl ?? '',
  } as SiteRow)
  return await getSite(env, id)
}

export async function deleteSite(env: Env, id: number): Promise<void> {
  const store = storeOf(env)
  await store.delete('sites', String(id))
  for (const table of ['audit_log', 'tasks'] as const) {
    const rows = await store.filter<{ id: number, site_id: number }>(table, row => Number(row.site_id) === id)
    await Promise.all(rows.map(row => store.delete(table, String(row.id))))
  }
}

export async function setSiteEnabled(env: Env, id: number, enabled: boolean): Promise<void> {
  const store = storeOf(env)
  const row = await store.get<SiteRow>('sites', String(id))
  if (!row) throw new SiteError('SITE_NOT_FOUND', '站点不存在')
  await store.put('sites', String(id), { ...row, enabled: enabled ? 1 : 0 })
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * The token for a site.
 *
 * Three sources, in order: the site's own Worker secret, an encrypted value in
 * D1, then the shared default. A site naming a secret that does not exist
 * fails here rather than silently falling back to the default token — using a
 * different credential than the operator chose is worse than an error.
 */
export async function tokenFor(env: Env, site: Site): Promise<string> {
  const store = storeOf(env)
  const row = await store.get<SiteRow>('sites', String(site.id))
  const patRef = row?.pat_ref?.trim() ?? ''

  // 1. The Worker secret this site names.
  if (patRef) {
    const fromSecret = (env as unknown as Record<string, unknown>)[patRef]
    if (typeof fromSecret === 'string' && fromSecret) return fromSecret
  }

  // 2. A token pasted into this site's settings.
  //
  // Checked whether or not `pat_ref` is set: the UI stores it under the site,
  // not under a secret name, and requiring both meant a token someone pasted
  // was saved encrypted and then never read.
  const encrypted = await store.get<{ value: string }>('settings', `site_token:${site.id}`)
  if (encrypted?.value) {
    if (!env.SESSION_SECRET) {
      throw new SiteError(
        'SITE_TOKEN',
        `站点「${site.name}」的令牌已加密保存，但缺少 SESSION_SECRET，无法解密`,
      )
    }
    return await decryptToken(encrypted.value, env.SESSION_SECRET)
  }

  // A site that named a secret expects that secret; falling back to the shared
  // token would use a credential the operator did not choose.
  if (patRef) {
    throw new SiteError('SITE_TOKEN', `站点「${site.name}」的 secret ${patRef} 不存在，也没有保存令牌`)
  }

  // 3. The shared default.
  if (!env.GITHUB_PAT) {
    throw new SiteError('NO_TOKEN', '没有配置 GitHub 令牌：设置 GITHUB_PAT，或在站点里保存一个令牌')
  }
  return env.GITHUB_PAT
}

/** Which credential a site will use — for the settings screen. */
export async function tokenSource(env: Env, siteId: number): Promise<{
  source: 'secret' | 'encrypted' | 'default' | 'none'
  secretName?: string
}> {
  const store = storeOf(env)
  const row = await store.get<SiteRow>('sites', String(siteId))
  const patRef = row?.pat_ref?.trim() ?? ''
  if (patRef && (env as unknown as Record<string, unknown>)[patRef]) {
    return { source: 'secret', secretName: patRef }
  }
  const encrypted = await store.get<{ value: string }>('settings', `site_token:${siteId}`)
  if (encrypted?.value) return { source: 'encrypted' }
  if (env.GITHUB_PAT) return { source: 'default' }
  return { source: 'none' }
}

/** Remove a site's stored token, so it can be revoked without a DB console. */
export async function clearSiteToken(env: Env, siteId: number): Promise<void> {
  await storeOf(env).delete('settings', `site_token:${siteId}`)
}

/** A token the operator pasted into the UI, encrypted at rest. */
export async function storeSiteToken(env: Env, siteId: number, token: string): Promise<void> {
  if (!env.SESSION_SECRET) {
    throw new SiteError('NO_SESSION_SECRET', '没有配置 SESSION_SECRET，无法加密保存令牌')
  }
  if (!/^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(token.trim())) {
    throw new SiteError('TOKEN_SHAPE', '这不像是 GitHub 令牌')
  }
  const value = await encryptToken(token.trim(), env.SESSION_SECRET)
  await storeOf(env).put('settings', `site_token:${siteId}`, { key: `site_token:${siteId}`, value })
}

async function keyFrom(secret: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(secret), char => char.charCodeAt(0))
  if (raw.length !== 32) {
    throw new SiteError('SESSION_SECRET', 'SESSION_SECRET 必须是 base64 编码的 32 字节')
  }
  return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encryptToken(plain: string, secret: string): Promise<string> {
  const key = await keyFrom(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain))
  const combined = new Uint8Array(iv.length + cipher.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(cipher), iv.length)
  return btoa(String.fromCharCode(...combined))
}

async function decryptToken(encoded: string, secret: string): Promise<string> {
  const key = await keyFrom(secret)
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
  const iv = bytes.slice(0, 12)
  const data = bytes.slice(12)
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
    return new TextDecoder().decode(plain)
  }
  catch {
    throw new SiteError('TOKEN_DECRYPT', '令牌解密失败，SESSION_SECRET 可能已更换')
  }
}
