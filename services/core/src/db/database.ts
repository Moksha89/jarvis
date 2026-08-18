import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { COLUMN_MIGRATIONS, SCHEMA_SQL } from './schema.js';

export type JarvisDatabase = Database.Database;

export function openDatabase(file: string): JarvisDatabase {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.exec(SCHEMA_SQL);
  applyColumnMigrations(db);
  return db;
}

function applyColumnMigrations(db: JarvisDatabase): void {
  for (const migration of COLUMN_MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all() as { name: string }[];
    if (columns.some((column) => column.name === migration.column)) continue;
    db.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.definition}`);
  }
}
