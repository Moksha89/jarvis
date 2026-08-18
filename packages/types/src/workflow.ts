/**
 * A workflow is an ordered recipe the user wrote: each step either calls one tool with
 * arguments they chose, or asks the model to do something. Unlike an agent run, the
 * sequence is fixed, so the same steps happen in the same order every time.
 */
export type WorkflowStepKind = 'tool' | 'prompt';

export interface WorkflowStepInput {
  kind: WorkflowStepKind;
  /** What this step is for, shown in the run trail. */
  title: string;
  /** For `tool` steps: the tool id, e.g. `filesystem.read`. */
  toolId?: string;
  /**
   * For `tool` steps: the arguments, whose string values may contain placeholders.
   * For `prompt` steps: use `prompt` instead.
   */
  input?: Record<string, unknown>;
  /** For `prompt` steps: the instruction, which may contain placeholders. */
  prompt?: string;
  /** For `prompt` steps: whether the model may use tools while answering. */
  mode?: 'ask' | 'agent';
  maxSteps?: number;
  /** Keep going when this step fails, for optional or best-effort steps. */
  continueOnError?: boolean;
}

export interface WorkflowStep extends WorkflowStepInput {
  id: string;
  /** 1-based, so `{{step1}}` in a later step reads the same way the UI lists it. */
  position: number;
}

export interface WorkflowInput {
  name: string;
  description?: string;
  steps: readonly WorkflowStepInput[];
  model?: string;
  enabled?: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  model?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: WorkflowRunStatus;
  /** True while a run of this workflow is in flight. */
  running: boolean;
}

export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkflowStepResult {
  stepId: string;
  position: number;
  title: string;
  ok: boolean;
  /** One line for the trail: the tool's summary, or the model's first words. */
  summary: string;
  /** What later steps see as `{{stepN}}`, capped. */
  output: string;
  /** The tool call this step made, so the audit trail can be followed. */
  callId?: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  /** The text the run was started with, available to every step as `{{input}}`. */
  input?: string;
  /** Holds the transcript of the run's prompt steps. */
  conversationId?: string;
  steps: WorkflowStepResult[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/** Limits enforced in Core, so a runaway recipe cannot exhaust the machine. */
export const WORKFLOW_LIMITS = {
  maxWorkflows: 64,
  maxSteps: 20,
  /** Per-step output kept for later steps and the trail. */
  maxOutputChars: 8_000,
  maxConcurrentRuns: 2,
} as const;
