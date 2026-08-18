import type {
  Workflow,
  WorkflowInput,
  WorkflowSource,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepInput,
  WorkflowStepResult,
} from '@jarvis/types';
import { TASK_LIMITS, WORKFLOW_LIMITS } from '@jarvis/types';
import type { JarvisDatabase } from '../db/database.js';

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  steps_json: string;
  model: string | null;
  enabled: number;
  source: string;
  goal: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  status: string;
  input: string | null;
  conversation_id: string | null;
  steps_json: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

/** Stored workflows and their run history. Validation lives here so every caller shares it. */
export class WorkflowStore {
  constructor(private readonly db: JarvisDatabase) {}

  create(input: WorkflowInput, origin: { source?: WorkflowSource; goal?: string } = {}): Workflow {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM workflows').get() as { n: number };
    if (count.n >= WORKFLOW_LIMITS.maxWorkflows) {
      throw new Error(`Jarvis keeps at most ${WORKFLOW_LIMITS.maxWorkflows} workflows. Delete one first.`);
    }
    const validated = validateWorkflow(input);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, description, steps_json, model, enabled, source, goal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        validated.name,
        validated.description ?? null,
        JSON.stringify(validated.steps),
        validated.model ?? null,
        input.enabled === false ? 0 : 1,
        origin.source ?? 'user',
        origin.goal ?? null,
        now,
        now,
      );
    return this.require(id);
  }

  /**
   * Drops the oldest plans Jarvis saved for itself, keeping `keep` of them. Only
   * planned recipes are considered, so a recipe the user wrote is never removed to make
   * room, and one that is still running is left alone.
   */
  prunePlans(keep: number): void {
    const rows = this.db
      .prepare(
        `SELECT id FROM workflows WHERE source = 'planner'
           AND id NOT IN (SELECT workflow_id FROM workflow_runs WHERE status = 'running')
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as { id: string }[];
    for (const row of rows.slice(Math.max(keep, 0))) {
      this.delete(row.id);
    }
  }

  update(id: string, input: WorkflowInput): Workflow {
    const existing = this.require(id);
    const validated = validateWorkflow(input);
    this.db
      .prepare(
        `UPDATE workflows SET name = ?, description = ?, steps_json = ?, model = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        validated.name,
        validated.description ?? null,
        JSON.stringify(validated.steps),
        validated.model ?? null,
        (input.enabled ?? existing.enabled) ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return this.require(id);
  }

  setEnabled(id: string, enabled: boolean): Workflow {
    this.require(id);
    this.db
      .prepare('UPDATE workflows SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return this.require(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workflow_runs WHERE workflow_id = ?').run(id);
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  }

  get(id: string): Workflow | undefined {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined;
    return row ? this.toWorkflow(row) : undefined;
  }

  require(id: string): Workflow {
    const workflow = this.get(id);
    if (!workflow) throw new Error(`Unknown workflow: ${id}`);
    return workflow;
  }

  list(): Workflow[] {
    const rows = this.db.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all() as WorkflowRow[];
    return rows.map((row) => this.toWorkflow(row));
  }

  startRun(workflowId: string, options: { input?: string; conversationId?: string } = {}): WorkflowRun {
    const run: WorkflowRun = {
      id: crypto.randomUUID(),
      workflowId,
      status: 'running',
      input: options.input,
      conversationId: options.conversationId,
      steps: [],
      startedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, status, input, conversation_id, steps_json, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.workflowId, run.status, run.input ?? null, run.conversationId ?? null, '[]', run.startedAt);
    return run;
  }

  /** Append a finished step so the UI can follow a long run while it happens. */
  appendStepResult(runId: string, result: WorkflowStepResult): WorkflowRun {
    const run = this.requireRun(runId);
    const steps = [...run.steps, result];
    this.db.prepare('UPDATE workflow_runs SET steps_json = ? WHERE id = ?').run(JSON.stringify(steps), runId);
    return this.requireRun(runId);
  }

  finishRun(runId: string, patch: { status: WorkflowRunStatus; error?: string }): WorkflowRun {
    this.db
      .prepare('UPDATE workflow_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(patch.status, patch.error ?? null, new Date().toISOString(), runId);
    return this.requireRun(runId);
  }

  getRun(id: string): WorkflowRun | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  requireRun(id: string): WorkflowRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`Unknown workflow run: ${id}`);
    return run;
  }

  listRuns(options: { workflowId?: string; limit?: number } = {}): WorkflowRun[] {
    const limit = Math.min(options.limit ?? 20, 100);
    const rows = options.workflowId
      ? (this.db
          .prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?')
          .all(options.workflowId, limit) as WorkflowRunRow[])
      : (this.db.prepare('SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?').all(limit) as WorkflowRunRow[]);
    return rows.map(toRun);
  }

  /** A run left `running` by a crash is not really running; mark it failed on startup. */
  failStaleRuns(): WorkflowRun[] {
    const rows = this.db.prepare("SELECT id FROM workflow_runs WHERE status = 'running'").all() as { id: string }[];
    return rows.map((row) =>
      this.finishRun(row.id, { status: 'failed', error: 'Jarvis closed while this run was in flight.' }),
    );
  }

  private toWorkflow(row: WorkflowRow): Workflow {
    const last = this.db
      .prepare(
        "SELECT status, started_at FROM workflow_runs WHERE workflow_id = ? AND status != 'running' ORDER BY started_at DESC LIMIT 1",
      )
      .get(row.id) as { status: string; started_at: string } | undefined;
    const running = this.db
      .prepare("SELECT 1 FROM workflow_runs WHERE workflow_id = ? AND status = 'running' LIMIT 1")
      .get(row.id) as unknown;
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      steps: parseSteps(row.steps_json),
      model: row.model ?? undefined,
      source: row.source === 'planner' ? 'planner' : 'user',
      goal: row.goal ?? undefined,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: last?.started_at,
      lastRunStatus: last ? (last.status as WorkflowRunStatus) : undefined,
      running: running !== undefined,
    };
  }
}

function toRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status as WorkflowRunStatus,
    input: row.input ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    steps: parseStepResults(row.steps_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
  };
}

function parseSteps(json: string): WorkflowStep[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as WorkflowStep[]) : [];
}

function parseStepResults(json: string): WorkflowStepResult[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as WorkflowStepResult[]) : [];
}

export interface ValidatedWorkflow {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  model?: string;
}

export function validateWorkflow(input: WorkflowInput): ValidatedWorkflow {
  const name = input.name?.trim() ?? '';
  if (!name) throw new Error('Give the workflow a name.');
  const steps = input.steps ?? [];
  if (steps.length === 0) throw new Error('A workflow needs at least one step.');
  if (steps.length > WORKFLOW_LIMITS.maxSteps) {
    throw new Error(`A workflow runs at most ${WORKFLOW_LIMITS.maxSteps} steps.`);
  }
  return {
    name: name.slice(0, 120),
    description: input.description?.trim() ? input.description.trim().slice(0, 500) : undefined,
    steps: steps.map((step, index) => validateStep(step, index + 1)),
    model: input.model?.trim() || undefined,
  };
}

function validateStep(step: WorkflowStepInput, position: number): WorkflowStep {
  const kind = step.kind === 'tool' ? 'tool' : 'prompt';
  const title = step.title?.trim() ?? '';
  const base: WorkflowStep = {
    id: crypto.randomUUID(),
    position,
    kind,
    title: (title || (kind === 'tool' ? (step.toolId ?? `Step ${position}`) : `Step ${position}`)).slice(0, 120),
    continueOnError: step.continueOnError === true,
  };

  if (kind === 'tool') {
    const toolId = step.toolId?.trim() ?? '';
    if (!toolId) throw new Error(`Step ${position} needs the tool it should run.`);
    if (step.input !== undefined && !isPlainRecord(step.input)) {
      throw new Error(`Step ${position} needs its tool arguments as an object.`);
    }
    return { ...base, toolId, input: step.input ?? {} };
  }

  const prompt = step.prompt?.trim() ?? '';
  if (!prompt) throw new Error(`Step ${position} needs an instruction for the model.`);
  return {
    ...base,
    prompt,
    mode: step.mode === 'agent' ? 'agent' : 'ask',
    maxSteps: Math.max(1, Math.min(TASK_LIMITS.maxSteps, Math.trunc(step.maxSteps ?? 4))),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
