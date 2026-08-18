export type TaskStatus = 'queued' | 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'cancelled';

/** One unit of work Jarvis performed: a chat turn, a tool call or an agent run. */
export interface Task {
  id: string;
  title: string;
  kind: 'chat' | 'tool' | 'agent';
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  conversationId?: string;
  detail?: string;
  error?: string;
}

export type ScheduleKind = 'manual' | 'interval' | 'daily';

export interface TaskSchedule {
  kind: ScheduleKind;
  /** For `interval`: minutes between runs (>= 5). */
  intervalMinutes?: number;
  /** For `daily`: local wall-clock time as HH:MM (24h). */
  dailyTime?: string;
  timeZone?: string;
}

/** Limits that apply to every saved task, enforced in Core. */
export const TASK_LIMITS = {
  maxSteps: 16,
  minIntervalMinutes: 5,
  maxConcurrentRuns: 2,
  /** An approval nobody answers in this long fails closed so a run cannot hang. */
  unattendedApprovalTimeoutMs: 120_000,
} as const;

/** A saved prompt that can be run on demand or on a schedule. */
export interface SavedTask {
  id: string;
  name: string;
  prompt: string;
  /** Agent runs use tools; ask runs are a plain single-shot answer. */
  mode: 'ask' | 'agent';
  model?: string;
  maxSteps: number;
  schedule: TaskSchedule;
  enabled: boolean;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: TaskRunStatus;
  /** True while a run of this task is in flight. */
  running: boolean;
}

export type TaskRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface TaskRun {
  id: string;
  taskId: string;
  /** The conversation holding the run's full trail; absent for skipped runs. */
  conversationId?: string;
  status: TaskRunStatus;
  trigger: 'manual' | 'schedule';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  stepsUsed?: number;
}

export interface SavedTaskInput {
  name: string;
  prompt: string;
  /** Defaults to a plain `ask` run, which cannot touch tools. */
  mode?: 'ask' | 'agent';
  model?: string;
  maxSteps?: number;
  schedule: TaskSchedule;
  enabled?: boolean;
}
