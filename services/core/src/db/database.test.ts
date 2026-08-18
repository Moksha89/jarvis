import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';

describe('openDatabase', () => {
  let workspace: string;
  let file: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'jarvis-db-'));
    file = join(workspace, 'jarvis.sqlite');
  });

  afterEach(() => {
    try {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can hold the WAL files open past close; a leftover temp file is harmless.
    }
  });

  it('upgrades a database whose knowledge_chunks predates message_id', () => {
    // A release before conversation memories were tied to a message: the table
    // exists, so CREATE TABLE IF NOT EXISTS cannot add the column later.
    const older = new Database(file);
    older.exec(`CREATE TABLE knowledge_chunks (
      id TEXT PRIMARY KEY,
      corpus TEXT NOT NULL,
      document_id TEXT,
      conversation_id TEXT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
    older.close();

    const db = openDatabase(file);
    const columns = db.prepare('PRAGMA table_info(knowledge_chunks)').all() as { name: string }[];
    const indexes = db.prepare('PRAGMA index_list(knowledge_chunks)').all() as { name: string }[];
    db.close();

    expect(columns.map((column) => column.name)).toContain('message_id');
    expect(indexes.map((index) => index.name)).toContain('idx_knowledge_chunks_message');
  });

  it('creates the message index on a fresh database', () => {
    const db = openDatabase(file);
    const indexes = db.prepare('PRAGMA index_list(knowledge_chunks)').all() as { name: string }[];
    db.close();
    expect(indexes.map((index) => index.name)).toContain('idx_knowledge_chunks_message');
  });
});
