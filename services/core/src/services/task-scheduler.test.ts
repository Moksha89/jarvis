import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '@jarvis/types';
import { EventBus } from '@jarvis/events';
import { openDatabase, type JarvisDatabase } from '../db/database.js';
import { ConversationStore } from '../store/conversation-store.js';
import { SavedTaskStore } from '../store/saved-task-store.js';
import { TaskScheduler, type TaskRunner } from './task-scheduler.js';

/** A runner we can hold open, so concurrency and cancellation are observable. */
function gatedRunner(): {
  runner: TaskRunner;
  started: number;
  release: () => void;
  aborted: () => number;
} {
  let started = 0;
  let aborts = 0;
  const gates: (() => void)[] = [];
  const runner: TaskRunner = async function* (options) {
    started += 1;
    await new Promise<void>((resolve) => {
      gates.push(resolve);
      options.signal.addEventListener(
        'abort',
        () => {
          aborts += 1;
          resolve();
        },
        { once: true },
      );
    });
    const event: ChatStreamEvent = { type: 'done', messageId: 'm', content: 'ok' };
    yield event;
  };
  return {
    runner,
    get started() {
      return started;
    },
    release: () => {
      for (const gate of gates.splice(0)) gate();
    },
    aborted: () => aborts,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('TaskScheduler', () => {
  let db: JarvisDatabase;
  let tasks: SavedTaskStore;
  let conversations: ConversationStore;
  let bus: EventBus;

  beforeEach(() => {
    db = openDatabase(':memory:');
    tasks = new SavedTaskStore(db);
    conversations = new ConversationStore(db);
    bus = new EventBus();
  });

  afterEach(() => {
    db.close();
  });

  it('runs a manual task on demand and records the run', async () => {
    const gate = gatedRunner();
    const scheduler = new TaskScheduler(tasks, conversations, bus, gate.runner);
    const task = tasks.create({ name: 'Task', prompt: 'go', schedule: { kind: 'manual' } });

    const run = scheduler.runNow(task.id);
    expect(run.status).toBe('running');
    expect(run.conversationId).toBeDefined();
    await flush();
    expect(gate.started).toBe(1);

    gate.release();
    await flush();
    expect(tasks.requireRun(run.id).status).toBe('succeeded');
    scheduler.stop();
  });

  it('refuses a second run of the same task', async () => {
    const gate = gatedRunner();
    const scheduler = new TaskScheduler(tasks, conversations, bus, gate.runner);
    const task = tasks.create({ name: 'Task', prompt: 'go', schedule: { kind: 'manual' } });

    scheduler.runNow(task.id);
    await flush();
    expect(() => scheduler.runNow(task.id)).toThrow(/already running/i);
    gate.release();
    await flush();
    scheduler.stop();
  });

  it('caps concurrent runs at two', async () => {
    const gate = gatedRunner();
    const scheduler = new TaskScheduler(tasks, conversations, bus, gate.runner);
    const ids = ['a', 'b', 'c'].map((name) => tasks.create({ name, prompt: 'go', schedule: { kind: 'manual' } }).id);

    for (const id of ids.slice(0, 2)) scheduler.runNow(id);
    await flush();
    expect(gate.started).toBe(2);
    expect(() => scheduler.runNow(ids[2] as string)).toThrow(/at most 2/);

    gate.release();
    await flush();
    scheduler.stop();
  });

  it('cancels a run and marks it cancelled', async () => {
    const gate = gatedRunner();
    const scheduler = new TaskScheduler(tasks, conversations, bus, gate.runner);
    const task = tasks.create({ name: 'Task', prompt: 'go', schedule: { kind: 'manual' } });

    const run = scheduler.runNow(task.id);
    await flush();
    scheduler.cancelRun(run.id);
    await flush();

    expect(gate.aborted()).toBe(1);
    expect(tasks.requireRun(run.id).status).toBe('cancelled');
    expect(() => scheduler.cancelRun(run.id)).toThrow(/already finished/i);
    scheduler.stop();
  });

  it('survives a task deleted while one of its runs is still in flight', async () => {
    const gate = gatedRunner();
    const scheduler = new TaskScheduler(tasks, conversations, bus, gate.runner);
    const task = tasks.create({ name: 'Task', prompt: 'go', schedule: { kind: 'manual' } });

    scheduler.runNow(task.id);
    await flush();

    // What Core does on delete: abort the run, then drop the rows underneath it. The
    // run finishing afterwards must not throw on rows that are no longer there.
    scheduler.cancelRunsForTask(task.id);
    tasks.delete(task.id);
    await flush();

    expect(gate.aborted()).toBe(1);
    expect(tasks.listRuns({ taskId: task.id })).toHaveLength(0);
    scheduler.stop();
  });

  it('does not finalise runs after it has been stopped', async () => {
    const gate = gatedRunner();
    const scheduler = new TaskScheduler(tasks, conversations, bus, gate.runner);
    const task = tasks.create({ name: 'Task', prompt: 'go', schedule: { kind: 'manual' } });

    const run = scheduler.runNow(task.id);
    await flush();
    scheduler.stop();
    await flush();

    expect(gate.aborted()).toBe(1);
    // Left as running on purpose: the next start marks crashed runs as failed.
    expect(tasks.requireRun(run.id).status).toBe('running');
  });

  it('catches up an overdue schedule on the first tick and moves it forward', async () => {
    const gate = gatedRunner();
    const task = tasks.create({
      name: 'Every 5',
      prompt: 'go',
      schedule: { kind: 'interval', intervalMinutes: 5 },
    });
    // Pretend Jarvis was closed when this was due.
    db.prepare('UPDATE saved_tasks SET next_run_at = ? WHERE id = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
      task.id,
    );

    const scheduler = new TaskScheduler(tasks, conversations, bus, gate.runner);
    scheduler.start();
    await flush();

    expect(gate.started).toBe(1);
    const runs = tasks.listRuns({ taskId: task.id });
    expect(runs[0]).toMatchObject({ trigger: 'schedule' });
    expect(new Date(tasks.require(task.id).nextRunAt as string).getTime()).toBeGreaterThan(Date.now());

    gate.release();
    await flush();
    scheduler.stop();
  });

  it('fails runs left in flight by a crash when it starts', async () => {
    const gate = gatedRunner();
    const task = tasks.create({ name: 'Task', prompt: 'go', schedule: { kind: 'manual' } });
    const stale = tasks.startRun(task.id, 'schedule');

    const scheduler = new TaskScheduler(tasks, conversations, bus, gate.runner);
    scheduler.start();
    await flush();

    expect(tasks.requireRun(stale.id).status).toBe('failed');
    scheduler.stop();
  });
});
