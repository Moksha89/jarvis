import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type JarvisDatabase } from '../db/database.js';
import { SavedTaskStore, nextRunFrom, validate } from './saved-task-store.js';

describe('saved task validation', () => {
  it('requires a name and a prompt', () => {
    expect(() => validate({ name: ' ', prompt: 'do it', schedule: { kind: 'manual' } })).toThrow(/name/i);
    expect(() => validate({ name: 'Task', prompt: '  ', schedule: { kind: 'manual' } })).toThrow(/prompt/i);
  });

  it('rejects intervals faster than the floor', () => {
    expect(() =>
      validate({ name: 'Task', prompt: 'go', schedule: { kind: 'interval', intervalMinutes: 1 } }),
    ).toThrow(/5 minutes/);
  });

  it('rejects a daily time that is not HH:MM', () => {
    expect(() => validate({ name: 'Task', prompt: 'go', schedule: { kind: 'daily', dailyTime: '7am' } })).toThrow(
      /HH:MM/,
    );
    expect(validate({ name: 'Task', prompt: 'go', schedule: { kind: 'daily', dailyTime: '07:30' } }).schedule)
      .toEqual({ kind: 'daily', dailyTime: '07:30' });
  });

  it('clamps the step budget', () => {
    expect(validate({ name: 'Task', prompt: 'go', maxSteps: 500, schedule: { kind: 'manual' } }).maxSteps).toBe(16);
    expect(validate({ name: 'Task', prompt: 'go', maxSteps: 0, schedule: { kind: 'manual' } }).maxSteps).toBe(1);
  });
});

describe('nextRunFrom', () => {
  const from = new Date('2026-01-01T10:00:00.000Z');

  it('has no next run for manual tasks', () => {
    expect(nextRunFrom({ kind: 'manual' }, from)).toBeUndefined();
  });

  it('adds the interval', () => {
    expect(nextRunFrom({ kind: 'interval', intervalMinutes: 15 }, from)).toBe('2026-01-01T10:15:00.000Z');
  });

  it('moves a daily time that already passed to tomorrow', () => {
    const local = new Date('2026-01-01T12:00:00');
    const next = nextRunFrom({ kind: 'daily', dailyTime: '09:00' }, local);
    expect(next).toBeDefined();
    const parsed = new Date(next as string);
    expect(parsed.getDate()).toBe(2);
    expect(parsed.getHours()).toBe(9);
  });
});

describe('SavedTaskStore', () => {
  let db: JarvisDatabase;
  let store: SavedTaskStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new SavedTaskStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('schedules an interval task on creation and lists it when due', () => {
    const task = store.create({
      name: 'Morning summary',
      prompt: 'summarise my downloads folder',
      mode: 'agent',
      schedule: { kind: 'interval', intervalMinutes: 5 },
    });
    expect(task.nextRunAt).toBeDefined();
    expect(store.listDue(new Date())).toHaveLength(0);
    expect(store.listDue(new Date(Date.now() + 6 * 60_000))).toHaveLength(1);
  });

  it('never lists a manual or disabled task as due', () => {
    store.create({ name: 'Manual', prompt: 'go', schedule: { kind: 'manual' } });
    const scheduled = store.create({
      name: 'Scheduled',
      prompt: 'go',
      schedule: { kind: 'interval', intervalMinutes: 5 },
    });
    store.setEnabled(scheduled.id, false);
    expect(store.listDue(new Date(Date.now() + 60 * 60_000))).toHaveLength(0);
  });

  it('advances the schedule so a slow run cannot double-fire', () => {
    const task = store.create({
      name: 'Every 5',
      prompt: 'go',
      schedule: { kind: 'interval', intervalMinutes: 5 },
    });
    const advanced = store.advanceSchedule(task.id, new Date(Date.now() + 6 * 60_000));
    expect(new Date(advanced.nextRunAt as string).getTime()).toBeGreaterThan(
      new Date(task.nextRunAt as string).getTime(),
    );
  });

  it('records run history and surfaces the latest outcome on the task', () => {
    const task = store.create({ name: 'Task', prompt: 'go', schedule: { kind: 'manual' } });
    const run = store.startRun(task.id, 'manual', 'conv-1');
    expect(store.require(task.id).running).toBe(true);

    const finished = store.finishRun(run.id, { status: 'succeeded', stepsUsed: 3 });
    expect(finished).toMatchObject({ status: 'succeeded', stepsUsed: 3, conversationId: 'conv-1' });
    expect(finished.finishedAt).toBeDefined();

    const reloaded = store.require(task.id);
    expect(reloaded.running).toBe(false);
    expect(reloaded.lastRunStatus).toBe('succeeded');
    expect(store.listRuns({ taskId: task.id })).toHaveLength(1);
  });

  it('fails runs that a crash left in flight', () => {
    const task = store.create({ name: 'Task', prompt: 'go', schedule: { kind: 'manual' } });
    store.startRun(task.id, 'schedule');
    const recovered = store.failStaleRuns();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ status: 'failed' });
    expect(store.failStaleRuns()).toHaveLength(0);
  });

  it('deletes a task with its runs', () => {
    const task = store.create({ name: 'Task', prompt: 'go', schedule: { kind: 'manual' } });
    store.startRun(task.id, 'manual');
    store.delete(task.id);
    expect(store.list()).toHaveLength(0);
    expect(store.listRuns()).toHaveLength(0);
  });
});
