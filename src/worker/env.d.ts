/// <reference types="@cloudflare/workers-types" />

/**
 * Bindings and configuration the Worker sees at runtime.
 *
 * Secrets are declared here but never given a default: a deployment that
 * forgets one fails its health check instead of running with an empty token.
 */
export interface Env {
  /**
   * D1, when the account can create one. The panel prefers it; the KV
   * fallback below is used when D1 is unavailable, so the product still works
   * on a token without `d1:edit`.
   */
  DB?: D1Database
  /** KV fallback store, and the cache for the post index and rate limits. */
  STORE?: KVNamespace
  CACHE: KVNamespace
  ASSETS: Fetcher

  // --- Cloudflare Access -------------------------------------------------
  /** e.g. `yourteam.cloudflareaccess.com` */
  ACCESS_TEAM_DOMAIN?: string
  /** The application's AUD tag from the Access dashboard. */
  ACCESS_AUD?: string
  /** The one hostname Access protects, e.g. `admin.example.com`. */
  PANEL_HOSTNAME?: string
  /** `false` only for local development. Anything else is treated as true. */
  REQUIRE_ACCESS?: string

  // --- GitHub ------------------------------------------------------------
  /** Default token, used by sites that do not name their own secret. */
  GITHUB_PAT?: string

  // --- Encryption --------------------------------------------------------
  /** Key material for per-site token encryption (base64, 32 bytes). */
  SESSION_SECRET?: string

  // --- Optional integrations --------------------------------------------
  /** Read-only token for the Pages deployment status module. */
  CF_API_TOKEN?: string
  CF_ACCOUNT_ID?: string

  // --- Local development -------------------------------------------------
  /** Return error details to the owner. Off unless explicitly set. */
  DEBUG_ERRORS?: string

  /** The identity `wrangler dev` uses when `REQUIRE_ACCESS=false`. */
  DEV_AUTH_EMAIL?: string
}

/** KV bindings are untyped on `Env` for the per-site secrets a deployment adds. */
export type AppEnv = { Bindings: Env }
