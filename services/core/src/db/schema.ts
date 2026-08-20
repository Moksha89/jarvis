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
  citations_json TEXT,
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

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  last_indexed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE (source_id, path)
);

-- Embeddings are float32 blobs, normalised on write, so a cosine score is a plain
-- dot product at query time. The model column is kept because vectors from different
-- embedding models are not comparable.
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  corpus TEXT NOT NULL,
  document_id TEXT REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_lookup ON knowledge_chunks(corpus, model);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks(document_id);

-- Skill servers speak the Model Context Protocol. Only the launch command is stored;
-- tokens or keys a server needs belong in the OS credential store, never here.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL,
  trust TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Workflows are fixed recipes: the steps are stored as written, and every run keeps its
-- own step results so the trail survives a later edit of the workflow.
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  steps_json TEXT NOT NULL,
  model TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'user',
  goal TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  conversation_id TEXT,
  steps_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, started_at DESC);
`;

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` leaves
 * existing databases untouched, so new columns are applied separately.
 */
export const COLUMN_MIGRATIONS: readonly { table: string; column: string; definition: string }[] = [
  { table: 'messages', column: 'step_json', definition: 'TEXT' },
  { table: 'messages', column: 'citations_json', definition: 'TEXT' },
  { table: 'knowledge_chunks', column: 'message_id', definition: 'TEXT' },
  { table: 'workflows', column: 'source', definition: "TEXT NOT NULL DEFAULT 'user'" },
  { table: 'workflows', column: 'goal', definition: 'TEXT' },
];

/**
 * Indexes over migrated columns. They run after COLUMN_MIGRATIONS because an
 * existing database only gains those columns there, and indexing a column that
 * does not exist yet aborts the whole schema step.
 */
export const POST_MIGRATION_SQL = `
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_message ON knowledge_chunks(message_id);
`;
