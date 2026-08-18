import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

export type JarvisDatabase = Database.Database;

export function openDatabase(file: string): JarvisDatabase {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.exec(SCHEMA_SQL);
  return db;
}
