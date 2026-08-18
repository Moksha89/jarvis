/**
 * SQLite is the authoritative store for everything except secrets.
 * Secrets are never written here; they belong in the OS credential store
 * (Windows Credential Manager), which is out of scope for this milestone.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  mode TEXT,
  error TEXT,
  step_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  conversation_id TEXT,
  detail TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  action TEXT NOT NULL,
  input_json TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  task_id TEXT,
  conversation_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_started ON tool_calls(started_at);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_rule_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);

CREATE TABLE IF NOT EXISTS permission_rules (
  id TEXT PRIMARY KEY,
  tool_pattern TEXT NOT NULL,
  target_pattern TEXT,
  effect TEXT NOT NULL,
  max_risk_level INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS path_scopes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  mode TEXT NOT NULL,
  effect TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  time TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  risk_level INTEGER NOT NULL,
  permission TEXT NOT NULL,
  permission_reason TEXT NOT NULL,
  result TEXT NOT NULL,
  reversible INTEGER NOT NULL,
  duration_ms INTEGER,
  detail TEXT,
  task_id TEXT,
  conversation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(time DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_events(tool_id, time DESC);

CREATE TABLE IF NOT EXISTS saved_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  max_steps INTEGER NOT NULL,
  schedule_kind TEXT NOT NULL,
  interval_minutes INTEGER,
  daily_time TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_tasks_due ON saved_tasks(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES saved_tasks(id) ON DELETE CASCADE,
  conversation_id TEXT,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  steps_used INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at DESC);
`;

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` leaves
 * existing databases untouched, so new columns are applied separately.
 */
export const COLUMN_MIGRATIONS: readonly { table: string; column: string; definition: string }[] = [
  { table: 'messages', column: 'step_json', definition: 'TEXT' },
];
