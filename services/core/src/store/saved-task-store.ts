import type { SavedTask, SavedTaskInput, TaskRun, TaskRunStatus, TaskSchedule } from '@jarvis/types';
import { TASK_LIMITS } from '@jarvis/types';
import type { JarvisDatabase } from '../db/database.js';

interface SavedTaskRow {
  id: string;
  name: string;
  prompt: string;
  mode: string;
  model: string | null;
  max_steps: number;
  schedule_kind: string;
  interval_minutes: number | null;
  daily_time: string | null;
  enabled: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRunRow {
  id: string;
  task_id: string;
  conversation_id: string | null;
  status: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  steps_used: number | null;
}

const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Saved prompts and their run history. Validation lives here so every caller shares it. */
export class SavedTaskStore {
  constructor(private readonly db: JarvisDatabase) {}

  create(input: SavedTaskInput): SavedTask {
    const validated = validate(input);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const enabled = input.enabled ?? true;
    const nextRunAt = enabled ? nextRunFrom(validated.schedule, new Date()) : undefined;
    this.db
      .prepare(
        `INSERT INTO saved_tasks
           (id, name, prompt, mode, model, max_steps, schedule_kind, interval_minutes, daily_time,
            enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        validated.name,
        validated.prompt,
        validated.mode,
        validated.model ?? null,
        validated.maxSteps,
        validated.schedule.kind,
        validated.schedule.intervalMinutes ?? null,
        validated.schedule.dailyTime ?? null,
        enabled ? 1 : 0,
        nextRunAt ?? null,
        now,
        now,
      );
    return this.require(id);
  }

  update(id: string, input: SavedTaskInput & { enabled?: boolean }): SavedTask {
    const existing = this.require(id);
    const validated = validate(input);
    const enabled = input.enabled ?? existing.enabled;
    const scheduleChanged =
      validated.schedule.kind !== existing.schedule.kind ||
      validated.schedule.intervalMinutes !== existing.schedule.intervalMinutes ||
      validated.schedule.dailyTime !== existing.schedule.dailyTime;
    const nextRunAt = !enabled
      ? undefined
      : scheduleChanged || !existing.nextRunAt
        ? nextRunFrom(validated.schedule, new Date())
        : existing.nextRunAt;
    this.db
      .prepare(
        `UPDATE saved_tasks SET name = ?, prompt = ?, mode = ?, model = ?, max_steps = ?, schedule_kind = ?,
           interval_minutes = ?, daily_time = ?, enabled = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        validated.name,
        validated.prompt,
        validated.mode,
        validated.model ?? null,
        validated.maxSteps,
        validated.schedule.kind,
        validated.schedule.intervalMinutes ?? null,
        validated.schedule.dailyTime ?? null,
        enabled ? 1 : 0,
        nextRunAt ?? null,
        new Date().toISOString(),
        id,
      );
    return this.require(id);
  }

  setEnabled(id: string, enabled: boolean): SavedTask {
    const task = this.require(id);
    const nextRunAt = enabled ? nextRunFrom(task.schedule, new Date()) : undefined;
    this.db
      .prepare('UPDATE saved_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nextRunAt ?? null, new Date().toISOString(), id);
    return this.require(id);
  }

  /** Move the schedule forward before a run starts, so a slow run cannot double-fire. */
  advanceSchedule(id: string, from = new Date()): SavedTask {
    const task = this.require(id);
    const nextRunAt = task.enabled ? nextRunFrom(task.schedule, from) : undefined;
    this.db.prepare('UPDATE saved_tasks SET next_run_at = ? WHERE id = ?').run(nextRunAt ?? null, id);
    return this.require(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM saved_tasks WHERE id = ?').run(id);
  }

  get(id: string): SavedTask | undefined {
    const row = this.db.prepare('SELECT * FROM saved_tasks WHERE id = ?').get(id) as SavedTaskRow | undefined;
    return row ? this.toSavedTask(row) : undefined;
  }

  require(id: string): SavedTask {
    const task = this.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  list(): SavedTask[] {
    const rows = this.db.prepare('SELECT * FROM saved_tasks ORDER BY created_at DESC').all() as SavedTaskRow[];
    return rows.map((row) => this.toSavedTask(row));
  }

  /** Enabled scheduled tasks whose next run is now due. */
  listDue(now = new Date()): SavedTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM saved_tasks
         WHERE enabled = 1 AND schedule_kind != 'manual' AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(now.toISOString()) as SavedTaskRow[];
    return rows.map((row) => this.toSavedTask(row));
  }

  startRun(taskId: string, trigger: TaskRun['trigger'], conversationId?: string): TaskRun {
    const run: TaskRun = {
      id: crypto.randomUUID(),
      taskId,
      conversationId,
      status: 'running',
      trigger,
      startedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO task_runs (id, task_id, conversation_id, status, trigger, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.taskId, run.conversationId ?? null, run.status, run.trigger, run.startedAt);
    return run;
  }

  finishRun(
    runId: string,
    patch: { status: TaskRunStatus; error?: string; stepsUsed?: number; conversationId?: string },
  ): TaskRun {
    const finishedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE task_runs SET status = ?, error = ?, steps_used = ?, finished_at = ?,
           conversation_id = COALESCE(?, conversation_id)
         WHERE id = ?`,
      )
      .run(patch.status, patch.error ?? null, patch.stepsUsed ?? null, finishedAt, patch.conversationId ?? null, runId);
    return this.requireRun(runId);
  }

  requireRun(id: string): TaskRun {
    const row = this.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as TaskRunRow | undefined;
    if (!row) throw new Error(`Unknown task run: ${id}`);
    return toTaskRun(row);
  }

  listRuns(options: { taskId?: string; limit?: number } = {}): TaskRun[] {
    const limit = Math.min(options.limit ?? 50, 200);
    const rows = options.taskId
      ? (this.db
          .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?')
          .all(options.taskId, limit) as TaskRunRow[])
      : (this.db.prepare('SELECT * FROM task_runs ORDER BY started_at DESC LIMIT ?').all(limit) as TaskRunRow[]);
    return rows.map(toTaskRun);
  }

  /** A run left `running` by a crash is not really running; mark it failed on startup. */
  failStaleRuns(): TaskRun[] {
    const rows = this.db.prepare("SELECT * FROM task_runs WHERE status = 'running'").all() as TaskRunRow[];
    return rows.map((row) =>
      this.finishRun(row.id, { status: 'failed', error: 'Jarvis closed while this run was in flight.' }),
    );
  }

  private toSavedTask(row: SavedTaskRow): SavedTask {
    const last = this.db
      .prepare("SELECT status, started_at FROM task_runs WHERE task_id = ? AND status != 'running' ORDER BY started_at DESC LIMIT 1")
      .get(row.id) as { status: string; started_at: string } | undefined;
    const running = this.db
      .prepare("SELECT 1 FROM task_runs WHERE task_id = ? AND status = 'running' LIMIT 1")
      .get(row.id) as unknown;
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      mode: row.mode === 'agent' ? 'agent' : 'ask',
      model: row.model ?? undefined,
      maxSteps: row.max_steps,
      schedule: {
        kind: row.schedule_kind === 'interval' ? 'interval' : row.schedule_kind === 'daily' ? 'daily' : 'manual',
        intervalMinutes: row.interval_minutes ?? undefined,
        dailyTime: row.daily_time ?? undefined,
      },
      enabled: row.enabled === 1,
      nextRunAt: row.next_run_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: last?.started_at,
      lastRunStatus: last ? (last.status as TaskRunStatus) : undefined,
      running: running !== undefined,
    };
  }
}

function toTaskRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    conversationId: row.conversation_id ?? undefined,
    status: row.status as TaskRunStatus,
    trigger: row.trigger === 'schedule' ? 'schedule' : 'manual',
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
    stepsUsed: row.steps_used ?? undefined,
  };
}

export function validate(input: SavedTaskInput): Required<Pick<SavedTaskInput, 'name' | 'prompt' | 'mode' | 'maxSteps'>> & {
  model?: string;
  schedule: TaskSchedule;
} {
  const name = input.name?.trim() ?? '';
  const prompt = input.prompt?.trim() ?? '';
  if (!name) throw new Error('Give the task a name.');
  if (!prompt) throw new Error('Give the task a prompt to run.');
  const mode = input.mode === 'agent' ? 'agent' : 'ask';
  const maxSteps = Math.max(1, Math.min(TASK_LIMITS.maxSteps, Math.trunc(input.maxSteps ?? 6)));

  const kind = input.schedule?.kind ?? 'manual';
  if (kind !== 'manual' && kind !== 'interval' && kind !== 'daily') {
    throw new Error(`Unknown schedule kind: ${String(kind)}`);
  }
  const schedule: TaskSchedule = { kind };
  if (kind === 'interval') {
    const minutes = Math.trunc(input.schedule.intervalMinutes ?? 0);
    if (minutes < TASK_LIMITS.minIntervalMinutes) {
      throw new Error(`Interval schedules run at most every ${TASK_LIMITS.minIntervalMinutes} minutes.`);
    }
    schedule.intervalMinutes = minutes;
  }
  if (kind === 'daily') {
    const time = input.schedule.dailyTime ?? '';
    if (!DAILY_TIME_PATTERN.test(time)) throw new Error('Daily schedules need a time as HH:MM, for example 07:30.');
    schedule.dailyTime = time;
  }

  return { name: name.slice(0, 120), prompt, mode, maxSteps, model: input.model?.trim() || undefined, schedule };
}

/** The next moment a schedule should fire, in local time. */
export function nextRunFrom(schedule: TaskSchedule, from: Date): string | undefined {
  if (schedule.kind === 'interval' && schedule.intervalMinutes) {
    return new Date(from.getTime() + schedule.intervalMinutes * 60_000).toISOString();
  }
  if (schedule.kind === 'daily' && schedule.dailyTime) {
    const parts = schedule.dailyTime.split(':');
    const next = new Date(from);
    next.setHours(Number(parts[0] ?? 0), Number(parts[1] ?? 0), 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  return undefined;
}
