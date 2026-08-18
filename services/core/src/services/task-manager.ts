import type { Task, TaskStatus } from '@jarvis/types';
import type { EventBus } from '@jarvis/events';
import type { JarvisDatabase } from '../db/database.js';

interface TaskRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  conversation_id: string | null;
  detail: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as Task['kind'],
    status: row.status as TaskStatus,
    conversationId: row.conversation_id ?? undefined,
    detail: row.detail ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Owns the lifecycle of every unit of work Jarvis performs. */
export class TaskManager {
  constructor(
    private readonly db: JarvisDatabase,
    private readonly bus: EventBus,
  ) {}

  create(options: { title: string; kind: Task['kind']; conversationId?: string; detail?: string }): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: crypto.randomUUID(),
      title: options.title.slice(0, 200),
      kind: options.kind,
      status: 'queued',
      conversationId: options.conversationId,
      detail: options.detail,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, kind, status, conversation_id, detail, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(task.id, task.title, task.kind, task.status, task.conversationId ?? null, task.detail ?? null, now, now);
    this.bus.emit('task.changed', task);
    return task;
  }

  update(id: string, patch: { status?: TaskStatus; detail?: string; error?: string }): Task | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const updated: Task = {
      ...existing,
      status: patch.status ?? existing.status,
      detail: patch.detail ?? existing.detail,
      error: patch.error ?? existing.error,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare('UPDATE tasks SET status = ?, detail = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(updated.status, updated.detail ?? null, updated.error ?? null, updated.updatedAt, id);
    this.bus.emit('task.changed', updated);
    return updated;
  }

  get(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  list(options: { status?: TaskStatus; limit?: number } = {}): Task[] {
    const limit = Math.min(options.limit ?? 100, 500);
    const rows = options.status
      ? (this.db
          .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
          .all(options.status, limit) as TaskRow[])
      : (this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?').all(limit) as TaskRow[]);
    return rows.map(toTask);
  }
}
