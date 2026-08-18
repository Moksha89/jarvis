import type { ChatStreamEvent, SavedTask, TaskRun } from '@jarvis/types';
import { TASK_LIMITS } from '@jarvis/types';
import type { EventBus } from '@jarvis/events';
import type { ConversationStore } from '../store/conversation-store.js';
import type { SavedTaskStore } from '../store/saved-task-store.js';

const TICK_MS = 30_000;

export interface TaskRunner {
  (options: {
    conversationId: string;
    prompt: string;
    mode: 'ask' | 'agent';
    model?: string;
    maxSteps: number;
    signal: AbortSignal;
  }): AsyncIterable<ChatStreamEvent>;
}

/**
 * Runs saved tasks: on demand, or when their schedule comes due. Runs happen in the
 * background through the same chat path a person uses, so tools stay permission-gated.
 * A missed schedule fires on the next tick, which is how a task catches up after Jarvis
 * was closed.
 */
export class TaskScheduler {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly active = new Map<string, { taskId: string; controller: AbortController }>();

  constructor(
    private readonly tasks: SavedTaskStore,
    private readonly conversations: ConversationStore,
    private readonly bus: EventBus,
    private readonly runner: TaskRunner,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    for (const run of this.tasks.failStaleRuns()) {
      this.bus.emit('task.run.changed', run);
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  /**
   * Aborts in-flight runs without awaiting them. Callers close the database right
   * after, so `stopped` tells a run's bookkeeping to stay off a dying handle.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const entry of this.active.values()) {
      entry.controller.abort();
    }
  }

  /** Start a task now, whatever its schedule says. */
  runNow(taskId: string): TaskRun {
    const task = this.tasks.require(taskId);
    if (this.isRunning(taskId)) {
      throw new Error(`"${task.name}" is already running.`);
    }
    if (this.active.size >= TASK_LIMITS.maxConcurrentRuns) {
      throw new Error(`Jarvis runs at most ${TASK_LIMITS.maxConcurrentRuns} tasks at once. Try again shortly.`);
    }
    return this.begin(task, 'manual');
  }

  cancelRun(runId: string): TaskRun {
    const entry = this.active.get(runId);
    if (!entry) throw new Error('That run already finished.');
    entry.controller.abort();
    return this.tasks.requireRun(runId);
  }

  /** Stops whatever a task is doing, so its rows can be deleted safely. */
  cancelRunsForTask(taskId: string): void {
    for (const entry of this.active.values()) {
      if (entry.taskId === taskId) entry.controller.abort();
    }
  }

  isRunning(taskId: string): boolean {
    for (const entry of this.active.values()) {
      if (entry.taskId === taskId) return true;
    }
    return false;
  }

  private async tick(): Promise<void> {
    for (const task of this.tasks.listDue()) {
      if (this.active.size >= TASK_LIMITS.maxConcurrentRuns) return;
      if (this.isRunning(task.id)) {
        // Still busy from last time: skip this slot rather than pile runs up.
        this.tasks.advanceSchedule(task.id);
        continue;
      }
      // Advance before running so a long run cannot fire twice.
      const advanced = this.tasks.advanceSchedule(task.id);
      this.bus.emit('task.saved.changed', advanced);
      this.begin(task, 'schedule');
    }
  }

  private begin(task: SavedTask, trigger: TaskRun['trigger']): TaskRun {
    const conversation = this.conversations.create({
      title: `${task.name} · ${new Date().toLocaleString()}`,
      mode: task.mode,
      model: task.model,
    });
    const run = this.tasks.startRun(task.id, trigger, conversation.id);
    const controller = new AbortController();
    this.active.set(run.id, { taskId: task.id, controller });
    this.bus.emit('task.run.changed', run);
    this.bus.emit('task.saved.changed', this.tasks.require(task.id));

    void this.execute(task, run, controller);
    return run;
  }

  private async execute(task: SavedTask, run: TaskRun, controller: AbortController): Promise<void> {
    let steps = 0;
    let error: string | undefined;
    try {
      const stream = this.runner({
        conversationId: run.conversationId ?? '',
        prompt: task.prompt,
        mode: task.mode,
        model: task.model,
        maxSteps: task.maxSteps,
        signal: controller.signal,
      });
      for await (const event of stream) {
        if (event.type === 'tool-result') steps += 1;
        if (event.type === 'error') error = event.error;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      this.active.delete(run.id);
      this.record(task, run, controller.signal.aborted, error, steps);
    }
  }

  /**
   * Records the outcome of a fire-and-forget run. Nothing awaits `execute`, so a throw
   * here would be an unhandled rejection that can take Core down: the task and its runs
   * can be deleted while the run is still streaming, and on shutdown the database is
   * already closed.
   */
  private record(task: SavedTask, run: TaskRun, cancelled: boolean, error: string | undefined, steps: number): void {
    if (this.stopped) return;
    try {
      const finished = this.tasks.finishRun(run.id, {
        status: cancelled ? 'cancelled' : error ? 'failed' : 'succeeded',
        error: cancelled ? 'You stopped this run.' : error,
        stepsUsed: steps,
      });
      this.bus.emit('task.run.changed', finished);
      this.bus.emit('task.saved.changed', this.tasks.require(task.id));
    } catch (caught) {
      this.bus.emit('core.log', {
        level: 'warn',
        message: `Run ${run.id} of "${task.name}" ended after the task was removed: ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
        time: new Date().toISOString(),
      });
    }
  }
}
