-- OnPaper Admin schema.
--
-- Content itself is not stored here: the repo is the source of truth and the
-- panel reads it live. These tables hold only what the panel must remember
-- between requests — which sites exist, who may use them, what was done, and
-- which task is still running.

CREATE TABLE IF NOT EXISTS sites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  owner        TEXT    NOT NULL,
  repo         TEXT    NOT NULL,
  branch       TEXT    NOT NULL DEFAULT 'main',
  paths_json   TEXT    NOT NULL DEFAULT '{}',
  pat_ref      TEXT    NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner, repo, branch)
);

CREATE TABLE IF NOT EXISTS users (
  email      TEXT    PRIMARY KEY,
  role       TEXT    NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL,
  email      TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  target     TEXT    NOT NULL DEFAULT '',
  detail     TEXT    NOT NULL DEFAULT '{}',
  commit_sha TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_site_time ON audit_log (site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id      INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  args         TEXT    NOT NULL DEFAULT '',
  run_id       INTEGER,
  status       TEXT    NOT NULL DEFAULT 'queued',
  conclusion   TEXT,
  triggered_by TEXT    NOT NULL DEFAULT '',
  result_json  TEXT    NOT NULL DEFAULT '{}',
  log_url      TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_site_time ON tasks (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks (status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A CSRF token per Access session. Access already proves who the caller is,
-- but its cookie rides along on cross-site form posts, so a token that only
-- the panel's own JavaScript can read is what stops a forged write.
CREATE TABLE IF NOT EXISTS csrf_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_csrf_email ON csrf_tokens (email);
