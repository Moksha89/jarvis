import type {
  ChatStreamEvent,
  ToolCallRecord,
  Workflow,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepResult,
} from '@jarvis/types';
import { WORKFLOW_LIMITS } from '@jarvis/types';
import type { EventBus } from '@jarvis/events';
import type { ToolRegistry } from '@jarvis/tools';
import type { ConversationStore } from '../store/conversation-store.js';
import type { WorkflowStore } from '../store/workflow-store.js';
import { waitForApproval } from './approval-wait.js';
import type { ToolExecutor } from './tool-executor.js';

/** Runs one chat turn in a conversation, exactly as a person's turn runs. */
export interface WorkflowTurnRunner {
  (options: {
    conversationId: string;
    prompt: string;
    mode: 'ask' | 'agent';
    model?: string;
    maxSteps: number;
    signal: AbortSignal;
  }): AsyncIterable<ChatStreamEvent>;
}

export interface WorkflowRunnerOptions {
  store: WorkflowStore;
  conversations: ConversationStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  bus: EventBus;
  runTurn: WorkflowTurnRunner;
}

/**
 * Runs a workflow's steps in the order the user wrote them. Tool steps go through
 * `ToolExecutor` and prompt steps through the ordinary chat path, so scopes, risk
 * levels, approvals and the audit log apply exactly as they do to a person's request.
 * A step that fails stops the run unless it was marked as best-effort.
 */
export class WorkflowRunner {
  private readonly active = new Map<string, { workflowId: string; controller: AbortController }>();
  private stopped = false;

  constructor(private readonly options: WorkflowRunnerOptions) {}

  /** Fail runs a crash left mid-flight, so nothing shows as running forever. */
  recover(): void {
    for (const run of this.options.store.failStaleRuns()) {
      this.options.bus.emit('workflow.run.changed', run);
    }
  }

  runNow(workflowId: string, input?: string): WorkflowRun {
    const workflow = this.options.store.require(workflowId);
    if (!workflow.enabled) throw new Error(`"${workflow.name}" is turned off.`);
    if (this.isRunning(workflowId)) throw new Error(`"${workflow.name}" is already running.`);
    if (this.active.size >= WORKFLOW_LIMITS.maxConcurrentRuns) {
      throw new Error(`Jarvis runs at most ${WORKFLOW_LIMITS.maxConcurrentRuns} workflows at once. Try again shortly.`);
    }

    const conversation = this.options.conversations.create({
      title: `${workflow.name} · ${new Date().toLocaleString()}`,
      mode: 'agent',
      model: workflow.model,
    });
    const run = this.options.store.startRun(workflow.id, {
      input: input?.trim() ? input.trim() : undefined,
      conversationId: conversation.id,
    });
    const controller = new AbortController();
    this.active.set(run.id, { workflowId: workflow.id, controller });
    this.options.bus.emit('workflow.run.changed', run);
    this.options.bus.emit('workflow.changed', this.options.store.require(workflow.id));

    void this.execute(workflow, run, controller);
    return run;
  }

  cancelRun(runId: string): WorkflowRun {
    const entry = this.active.get(runId);
    if (!entry) throw new Error('That run already finished.');
    entry.controller.abort();
    return this.options.store.requireRun(runId);
  }

  /** Stops whatever a workflow is doing, so its rows can be deleted safely. */
  cancelRunsForWorkflow(workflowId: string): void {
    for (const entry of this.active.values()) {
      if (entry.workflowId === workflowId) entry.controller.abort();
    }
  }

  isRunning(workflowId: string): boolean {
    for (const entry of this.active.values()) {
      if (entry.workflowId === workflowId) return true;
    }
    return false;
  }

  /** Aborts in-flight runs; the database closes right after, so bookkeeping stands down. */
  stop(): void {
    this.stopped = true;
    for (const entry of this.active.values()) {
      entry.controller.abort();
    }
  }

  private async execute(workflow: Workflow, run: WorkflowRun, controller: AbortController): Promise<void> {
    const outputs = new Map<number, string>();
    let error: string | undefined;

    try {
      for (const step of workflow.steps) {
        controller.signal.throwIfAborted();
        const result = await this.runStep(workflow, run, step, outputs, controller.signal);
        outputs.set(step.position, result.output);
        if (!this.stopped) {
          const updated = this.options.store.appendStepResult(run.id, result);
          this.options.bus.emit('workflow.run.changed', updated);
        }
        if (!result.ok && step.continueOnError !== true) {
          error = `Step ${step.position} (${step.title}) failed: ${result.error ?? result.summary}`;
          break;
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      this.active.delete(run.id);
      this.record(workflow, run, controller.signal.aborted, error);
    }
  }

  private async runStep(
    workflow: Workflow,
    run: WorkflowRun,
    step: WorkflowStep,
    outputs: Map<number, string>,
    signal: AbortSignal,
  ): Promise<WorkflowStepResult> {
    const startedAt = new Date().toISOString();
    const render = (raw: string): string => renderTemplate(raw, run.input, outputs);
    const base = { stepId: step.id, position: step.position, title: step.title, startedAt };

    try {
      if (step.kind === 'tool') {
        const record = await this.runToolStep(step, run, render, signal);
        const result = record.result;
        const ok = record.status === 'succeeded' && result?.ok === true;
        return {
          ...base,
          ok,
          callId: record.id,
          summary: result?.summary ?? record.intent.summary,
          output: cap(ok ? describeData(result?.data) : (result?.error ?? statusText(record))),
          error: ok ? undefined : (result?.error ?? statusText(record)),
          finishedAt: new Date().toISOString(),
        };
      }

      const answer = await this.runPromptStep(step, run, render, workflow.model, signal);
      return {
        ...base,
        ok: answer.error === undefined,
        summary: answer.error ?? firstLine(answer.text) ?? 'The model answered with nothing.',
        output: cap(answer.text),
        error: answer.error,
        finishedAt: new Date().toISOString(),
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // An abort has to surface as a cancelled run, not a failed step.
      if (signal.aborted) throw caught;
      return { ...base, ok: false, summary: message, output: '', error: message, finishedAt: new Date().toISOString() };
    }
  }

  private async runToolStep(
    step: WorkflowStep,
    run: WorkflowRun,
    render: (raw: string) => string,
    signal: AbortSignal,
  ): Promise<ToolCallRecord> {
    const toolId = step.toolId ?? '';
    if (!this.options.registry.get(toolId)) {
      throw new Error(`There is no tool called "${toolId}".`);
    }
    const input = renderValue(step.input ?? {}, render);
    let record = await this.options.executor.call(toolId, input, {
      conversationId: run.conversationId,
    });

    if (record.status === 'pending-approval') {
      const approval = this.options.executor.pendingApprovalForCall(record.id);
      if (!approval) return this.options.executor.getCall(record.id) ?? record;
      record = await waitForApproval(this.options.executor, this.options.bus, record, approval.id, { signal });
    }
    return record;
  }

  private async runPromptStep(
    step: WorkflowStep,
    run: WorkflowRun,
    render: (raw: string) => string,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<{ text: string; error?: string }> {
    let text = '';
    let error: string | undefined;
    const stream = this.options.runTurn({
      conversationId: run.conversationId ?? '',
      prompt: render(step.prompt ?? ''),
      mode: step.mode === 'agent' ? 'agent' : 'ask',
      model,
      maxSteps: step.maxSteps ?? 4,
      signal,
    });
    for await (const event of stream) {
      if (event.type === 'delta') text += event.text;
      if (event.type === 'error') error = event.error;
    }
    return { text: text.trim(), error };
  }

  /**
   * Records the outcome of a fire-and-forget run. Nothing awaits `execute`, so a throw
   * here would be an unhandled rejection: the workflow can be deleted mid-run, and on
   * shutdown the database is already closed.
   */
  private record(workflow: Workflow, run: WorkflowRun, cancelled: boolean, error: string | undefined): void {
    if (this.stopped) return;
    try {
      const finished = this.options.store.finishRun(run.id, {
        status: cancelled ? 'cancelled' : error ? 'failed' : 'succeeded',
        error: cancelled ? 'You stopped this run.' : error,
      });
      this.options.bus.emit('workflow.run.changed', finished);
      this.options.bus.emit('workflow.changed', this.options.store.require(workflow.id));
    } catch (caught) {
      this.options.bus.emit('core.log', {
        level: 'warn',
        message: `Run ${run.id} of "${workflow.name}" ended after the workflow was removed: ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
        time: new Date().toISOString(),
      });
    }
  }
}

/**
 * Fills `{{input}}`, `{{stepN}}` and `{{previous}}` from what the run has produced so
 * far. An unknown placeholder becomes empty text rather than being left in place: a
 * literal `{{step9}}` reaching a shell command would be worse than nothing.
 */
export function renderTemplate(raw: string, input: string | undefined, outputs: Map<number, string>): string {
  return raw.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const key = name.toLowerCase();
    if (key === 'input') return input ?? '';
    if (key === 'previous') {
      const positions = [...outputs.keys()];
      const last = positions.length > 0 ? Math.max(...positions) : undefined;
      return last === undefined ? '' : (outputs.get(last) ?? '');
    }
    const step = /^step(\d+)$/.exec(key);
    if (step) return outputs.get(Number(step[1])) ?? '';
    return '';
  });
}

/** Renders placeholders inside stored tool arguments, at any depth. */
function renderValue(value: unknown, render: (raw: string) => string): unknown {
  if (typeof value === 'string') return render(value);
  if (Array.isArray(value)) return value.map((entry) => renderValue(entry, render));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = renderValue(entry, render);
    }
    return out;
  }
  return value;
}

function describeData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}

function statusText(record: ToolCallRecord): string {
  if (record.status === 'denied') return 'You denied this step.';
  return `The step ended as ${record.status}.`;
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n').find((entry) => entry.trim().length > 0);
  return line ? line.trim().slice(0, 200) : undefined;
}

function cap(text: string): string {
  return text.slice(0, WORKFLOW_LIMITS.maxOutputChars);
}
