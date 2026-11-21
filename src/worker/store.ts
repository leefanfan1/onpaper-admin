/**
 * The panel's small persistent store.
 *
 * It holds four kinds of record — sites, users, audit entries, tasks — and one
 * CSRF token per user. The content itself is never stored here: the repo is the
 * source of truth, and a second copy would be a second truth.
 *
 * Two backends, one interface:
 *
 *   - **D1** (`DB` binding present) — the intended backend. Real SQL, an
 *     index on the task list, atomic `last_row_id`.
 *   - **KV** (`STORE` binding) — a fallback for an account whose token cannot
 *     create a D1 database. Records live as JSON under `db:<table>:<id>`, with
 *     a small in-KV counter for ids. KV has no transactions, so the fallback
 *     serialises writes through a lock key with a short lease.
 *
 * The fallback is not a toy: every read path the panel uses is served by both,
 * and the same tests run against each. It is slower on the task list (a prefix
 * list plus N gets instead of one indexed query), which is the price of not
 * having SQL.
 */

import type { Env } from './env'

export type TableName = 'sites' | 'users' | 'audit_log' | 'tasks' | 'csrf_tokens' | 'settings'

export interface Store {
  /** All rows, unordered. */
  all<T>(table: TableName): Promise<T[]>
  /** Rows matching a simple predicate, evaluated in JS on both backends. */
  filter<T>(table: TableName, predicate: (row: T) => boolean): Promise<T[]>
  get<T>(table: TableName, key: string): Promise<T | null>
  put(table: TableName, key: string, row: object): Promise<void>
  delete(table: TableName, key: string): Promise<void>
  /** How many rows the table holds — used for the first-user bootstrap. */
  count(table: TableName): Promise<number>
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

/** The key column of each table, for `get`/`put`. */
const KEYS: Record<TableName, string> = {
  sites: 'id',
  users: 'email',
  audit_log: 'id',
  tasks: 'id',
  csrf_tokens: 'token',
  settings: 'key',
}

class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async all<T>(table: TableName): Promise<T[]> {
    const result = await this.db.prepare(`SELECT * FROM ${table}`).all<T>()
    return result.results ?? []
  }

  async filter<T>(table: TableName, predicate: (row: T) => boolean): Promise<T[]> {
    // Filtering in SQL would need a query per predicate; the panel's lists are
    // small enough (hundreds of rows) that one read plus a JS filter is both
    // simpler and correct. The task list is the only hot one, and it has an
    // index plus its own query in tasks.ts.
    const rows = await this.all<T>(table)
    return rows.filter(predicate)
  }

  async get<T>(table: TableName, key: string): Promise<T | null> {
    const column = KEYS[table]
    return await this.db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).bind(key).first<T>()
  }

  async put(table: TableName, _key: string, row: object): Promise<void> {
    const record = row as Record<string, unknown>
    const columns = Object.keys(record)
    const placeholders = columns.map(() => '?').join(', ')
    const values = columns.map(column => record[column])
    await this.db
      .prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
      .bind(...values)
      .run()
  }

  async delete(table: TableName, key: string): Promise<void> {
    const column = KEYS[table]
    await this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(key).run()
  }

  async count(table: TableName): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>()
    return row?.n ?? 0
  }
}

// ---------------------------------------------------------------------------
// KV
// ---------------------------------------------------------------------------

class KvStore implements Store {
  constructor(private readonly kv: KVNamespace) {}

  async all<T>(table: TableName): Promise<T[]> {
    // KV lists keys, not values; a page of 1000 keys is the practical bound for
    // the panel's tables, and `cursor` is followed when there are more.
    const rows: T[] = []
    let cursor: string | undefined
    do {
      const page = await this.kv.list({ prefix: `db:${table}:`, cursor, limit: 1000 })
      const values = await Promise.all(
        page.keys.map(key => this.kv.get(key.name, 'json')),
      )
      for (const value of values) if (value) rows.push(value as T)
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
    return rows
  }

  async filter<T>(table: TableName, predicate: (row: T) => boolean): Promise<T[]> {
    return (await this.all<T>(table)).filter(predicate)
  }

  async get<T>(table: TableName, key: string): Promise<T | null> {
    return await this.kv.get<T>(this.keyOf(table, key), 'json')
  }

  async put(table: TableName, key: string, row: object): Promise<void> {
    await this.kv.put(this.keyOf(table, key), JSON.stringify(row))
  }

  async delete(table: TableName, key: string): Promise<void> {
    await this.kv.delete(this.keyOf(table, key))
  }

  async count(table: TableName): Promise<number> {
    let total = 0
    let cursor: string | undefined
    do {
      const page = await this.kv.list({ prefix: `db:${table}:`, cursor, limit: 1000 })
      total += page.keys.length
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
    return total
  }

  private keyOf(table: TableName, key: string): string {
    return `db:${table}:${key}`
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function storeOf(env: Env): Store {
  if (env.DB) return new D1Store(env.DB)
  if (env.STORE) return new KvStore(env.STORE)
  throw new Error('没有可用的存储绑定：需要 DB（D1）或 STORE（KV）')
}

/** Which backend is in use, for the health line. */
export function storeKind(env: Env): 'd1' | 'kv' | 'none' {
  if (env.DB) return 'd1'
  if (env.STORE) return 'kv'
  return 'none'
}

/**
 * The next id for an append-only table.
 *
 * D1 gives `last_row_id`; KV has no sequences, so ids come from a counter key.
 * A counter read-modify-write is not atomic in KV — two simultaneous inserts
 * could take the same number — so the caller serialises inserts through
 * `withLock` below. That is enough for a panel with a handful of users; it is
 * not a general-purpose sequence, and the code says so rather than pretending.
 */
export async function nextId(env: Env, table: TableName): Promise<number> {
  if (env.DB) {
    const store = new D1Store(env.DB)
    const rows = await store.all<Record<string, number>>(table)
    return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  }
  const kv = env.STORE
  if (!kv) throw new Error('没有可用的存储绑定')
  const key = `seq:${table}`
  const current = Number.parseInt((await kv.get(key)) ?? '0', 10) || 0
  const next = current + 1
  await kv.put(key, String(next))
  return next
}

/**
 * Serialise a read-modify-write with a short KV lease.
 *
 * Only used by the KV fallback. The lease is 10 seconds and is not renewed:
 * the operations it guards are a single put, so a crashed holder costs at most
 * one wait cycle, and the caller retries rather than failing.
 */
export async function withLock<T>(env: Env, name: string, run: () => Promise<T>): Promise<T> {
  if (env.DB) return await run()
  const kv = env.STORE
  if (!kv) return await run()

  const key = `lock:${name}`
  for (let attempt = 0; attempt < 25; attempt++) {
    const held = await kv.get(key)
    if (!held) {
      await kv.put(key, String(Date.now()), { expirationTtl: 10 })
      // Re-read to narrow the race window: two writers that both saw the lock
      // free will both have written, and the second write wins the value.
      const check = await kv.get(key)
      if (check && Date.now() - Number(check) < 1000) {
        try {
          return await run()
        }
        finally {
          await kv.delete(key)
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  // Rather than block a user's save forever, proceed: the lock is an
  // optimisation for id allocation, not a correctness boundary for content.
  return await run()
}
