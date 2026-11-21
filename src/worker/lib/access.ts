/**
 * Cloudflare Access identity.
 *
 * Access sits in front of the panel's hostname and adds a signed JWT to every
 * request it lets through. That JWT is the only thing trusted here:
 *
 *   - `Cf-Access-Authenticated-User-Email` is a plain header. Anything that
 *     reaches the Worker another way could set it, so it is never read.
 *   - A request is authorised only if its JWT signature, issuer, audience and
 *     expiry all check out. Any failure is a rejection, never a fallback.
 *   - `aud` matters as much as the signature: every Access application in a
 *     team shares the signing keys, so without an audience check a token minted
 *     for a different app in the same team would open this one.
 */

const HEADER = 'Cf-Access-Jwt-Assertion'
const CERTS_PATH = '/cdn-cgi/access/certs'
/** Refresh the key set a little before Access rotates it. */
const CERTS_TTL_SECONDS = 3600

export class AccessError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AccessError'
    this.code = code
  }
}

export interface AccessIdentity {
  email: string
  sub: string
  /** Everything else in the claims, for the audit log. */
  claims: Record<string, unknown>
}

export interface AccessConfig {
  teamDomain: string
  aud: string
  /** The hostname the Access application protects. */
  panelHostname: string
}

interface Jwk {
  kid: string
  kty: string
  alg?: string
  n?: string
  e?: string
  use?: string
}

interface JwksCacheEntry {
  keys: Jwk[]
  fetchedAt: number
}

// Module-level cache: a Worker instance keeps its cert set across requests, and
// the platform recycles instances anyway, so this is bounded by design.
let jwksCache: JwksCacheEntry | null = null

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='))
  // `new Uint8Array(length)` is backed by a plain ArrayBuffer, which is what
  // WebCrypto's BufferSource takes; a subarray view could be a SharedArrayBuffer.
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function decodeJsonPart(part: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part))) as Record<string, unknown>
  }
  catch {
    throw new AccessError('JWT_MALFORMED', 'Access 令牌格式错误')
  }
}

async function fetchJwks(teamDomain: string, force = false): Promise<Jwk[]> {
  const now = Date.now()
  if (!force && jwksCache && now - jwksCache.fetchedAt < CERTS_TTL_SECONDS * 1000) {
    return jwksCache.keys
  }
  const url = `https://${teamDomain}${CERTS_PATH}`
  let response: Response
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } })
  }
  catch (error) {
    throw new AccessError('JWKS_NETWORK', `无法获取 Access 公钥：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new AccessError('JWKS_HTTP', `Access 公钥接口返回 ${response.status}`)
  }
  const body = await response.json() as { keys?: Jwk[], public_certs?: Array<{ kid: string, cert: string }> }
  // The endpoint documents both shapes; `keys` is the modern one.
  const keys = body.keys ?? []
  if (!keys.length) {
    throw new AccessError('JWKS_EMPTY', 'Access 公钥为空')
  }
  jwksCache = { keys, fetchedAt: now }
  return keys
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new AccessError('JWK_SHAPE', '公钥不是 RSA JWK')
  }
  return await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

/** Verify a JWT's RS256 signature against the team's key set. */
async function verifySignature(token: string, teamDomain: string): Promise<Record<string, unknown>> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AccessError('JWT_MALFORMED', 'Access 令牌格式错误')
  const [headerPart, payloadPart, signaturePart] = parts

  const header = decodeJsonPart(headerPart)
  if (header.alg !== 'RS256') {
    // `none` and HS256 are the two classic downgrade attempts.
    throw new AccessError('JWT_ALG', 'Access 令牌的签名算法不受支持')
  }
  const kid = typeof header.kid === 'string' ? header.kid : ''

  let keys = await fetchJwks(teamDomain)
  let jwk = keys.find(key => key.kid === kid)
  if (!jwk) {
    // Access rotates keys; a `kid` we have not seen may be a fresh one. Fetch
    // once more before rejecting, so a rotation does not break the panel.
    keys = await fetchJwks(teamDomain, true)
    jwk = keys.find(key => key.kid === kid)
  }
  if (!jwk) throw new AccessError('JWT_KID', '找不到对应的 Access 公钥')

  const key = await importRsaKey(jwk)
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signaturePart),
    signed,
  )
  if (!valid) throw new AccessError('JWT_SIGNATURE', 'Access 令牌签名无效')

  return decodeJsonPart(payloadPart)
}

function claimString(claims: Record<string, unknown>, name: string): string {
  const value = claims[name]
  return typeof value === 'string' ? value : ''
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected
  if (Array.isArray(aud)) return aud.some(item => item === expected)
  return false
}

/**
 * Validate the request and return who made it.
 *
 * `now` is injectable so the tests can exercise expiry without waiting.
 */
export async function verifyAccess(
  request: Request,
  config: AccessConfig,
  now = Date.now(),
): Promise<AccessIdentity> {
  if (!config.teamDomain || !config.aud) {
    throw new AccessError('CONFIG', 'Access 未配置：缺少 team domain 或 AUD')
  }

  // Access is bound to one hostname. If the Worker is somehow reachable on
  // another one, a valid token should still not open it — that is how a
  // `workers.dev` route would undo the whole protection.
  if (config.panelHostname) {
    const host = request.headers.get('Host') ?? new URL(request.url).host
    if (host !== config.panelHostname) {
      throw new AccessError('HOST', '这个地址不是面板的入口')
    }
  }

  const token = request.headers.get(HEADER)
  if (!token) {
    throw new AccessError('NO_TOKEN', '缺少 Access 令牌，请通过 Cloudflare Access 登录')
  }

  const claims = await verifySignature(token, config.teamDomain)

  const iss = claimString(claims, 'iss')
  if (iss !== `https://${config.teamDomain}`) {
    throw new AccessError('JWT_ISS', 'Access 令牌的签发方不匹配')
  }
  if (!audienceMatches(claims.aud, config.aud)) {
    throw new AccessError('JWT_AUD', 'Access 令牌不属于这个应用')
  }

  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : 0
  if (!exp || exp <= now) {
    throw new AccessError('JWT_EXPIRED', '登录已过期，请重新登录')
  }
  const nbf = typeof claims.nbf === 'number' ? claims.nbf * 1000 : 0
  if (nbf && nbf > now + 60_000) {
    throw new AccessError('JWT_NBF', 'Access 令牌尚未生效')
  }

  // The identity claim Access sets for a user is `email`. Service tokens
  // carry `common_name` instead and have no email — the panel is for people.
  const email = claimString(claims, 'email').trim().toLowerCase()
  if (!email) {
    throw new AccessError('JWT_EMAIL', 'Access 令牌里没有用户邮箱')
  }

  return { email, sub: claimString(claims, 'sub'), claims }
}

/** Test seam: drop the cached key set. */
export function resetJwksCache(): void {
  jwksCache = null
}

/** Exported for the tests, which build tokens against a key they control. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
