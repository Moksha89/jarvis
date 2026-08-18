import type {
  ChatCompletionMessage,
  ChatStreamEvent,
  ModelRuntimeAdapter,
  ModelToolCall,
  ToolCallRecord,
  ToolStepRecord,
} from '@jarvis/types';
import { TASK_LIMITS } from '@jarvis/types';
import type { EventBus } from '@jarvis/events';
import { normalizeToolArguments, toModelToolDefinition, toolIdForFunctionName } from '@jarvis/tools';
import type { ToolRegistry } from '@jarvis/tools';
import type { ToolExecutor } from './tool-executor.js';

/** Tool output handed back to the model, capped so small local models keep their context. */
const TOOL_RESULT_CAP = 12_000;
/** Result text stored on the transcript card the user sees. */
const PREVIEW_CAP = 2_000;

export const AGENT_SYSTEM_PROMPT = `You are Jarvis, a local Windows assistant running on the user's own machine.

You can act on this computer only through the tools you are given. Never claim you did
something unless a tool call returned a successful result. Some calls need the user's
approval first; if a call comes back denied, tell the user plainly and stop that approach
instead of retrying it.

Work in small steps: call one tool, read its result, then decide the next step. When you
have what you need, answer in plain language and do not call more tools. Prefer paths the
user named. Be concise.

Never write out tool calls or tool results as text: they only count when made through the
tool interface. If you cannot use a tool, say so rather than describing what it would have
returned, and never invent file names, contents or command output.`;

export interface AgentRunOptions {
  conversationId: string;
  model: string;
  /** Prior turns, oldest first, already trimmed by the caller. */
  history: readonly ChatCompletionMessage[];
  maxSteps: number;
  messageId: string;
  taskId?: string;
  signal?: AbortSignal;
  /** Nobody is watching, so a pending approval fails closed after a timeout. */
  unattended?: boolean;
  approvalTimeoutMs?: number;
}

export interface AgentRunResult {
  content: string;
  stepsUsed: number;
  steps: readonly ToolStepRecord[];
}

/**
 * The multi-step tool-calling loop. It never touches the filesystem or shell itself:
 * every step goes through `ToolExecutor`, so scopes, risk levels, approvals and the
 * audit log all still apply to autonomous work.
 */
export class AgentRunner {
  constructor(
    private readonly runtime: ModelRuntimeAdapter,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly bus: EventBus,
  ) {}

  async *run(options: AgentRunOptions): AsyncGenerator<ChatStreamEvent, AgentRunResult> {
    const tools = this.registry.list().map(toModelToolDefinition);
    const transcript: ChatCompletionMessage[] = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      ...options.history,
    ];
    const steps: ToolStepRecord[] = [];
    let answer = '';

    for (let step = 1; step <= options.maxSteps; step += 1) {
      options.signal?.throwIfAborted();
      yield { type: 'step', messageId: options.messageId, step, maxSteps: options.maxSteps };

      let text = '';
      const calls: ModelToolCall[] = [];
      for await (const chunk of this.runtime.streamChat(
        { model: options.model, messages: transcript, tools },
        options.signal,
      )) {
        if (chunk.type === 'delta') {
          text += chunk.text;
          yield { type: 'delta', messageId: options.messageId, text: chunk.text };
        } else if (chunk.type === 'tool-calls') {
          calls.push(...chunk.calls);
        }
      }

      if (calls.length === 0) {
        answer = text.trim();
        return { content: answer, stepsUsed: step, steps };
      }

      // Prose the model wrote alongside its tool calls was streamed to the user, so keep
      // it: if the step budget runs out, it is the only explanation the transcript has.
      if (text.trim()) answer = answer ? `${answer}\n\n${text.trim()}` : text.trim();
      transcript.push({ role: 'assistant', content: text, toolCalls: calls });

      for (const call of calls) {
        options.signal?.throwIfAborted();
        const outcome = yield* this.runOneCall(call, options);
        steps.push(outcome.step);
        transcript.push({
          role: 'tool',
          toolName: call.name,
          content: outcome.modelText.slice(0, TOOL_RESULT_CAP),
        });
      }
    }

    // Out of budget: say so rather than pretending the work finished.
    answer = answer.trim();
    const notice = `I used all ${options.maxSteps} allowed steps without finishing. Raise the step budget or narrow the request.`;
    yield { type: 'delta', messageId: options.messageId, text: `\n\n${notice}` };
    return { content: answer ? `${answer}\n\n${notice}` : notice, stepsUsed: options.maxSteps, steps };
  }

  private async *runOneCall(
    call: ModelToolCall,
    options: AgentRunOptions,
  ): AsyncGenerator<ChatStreamEvent, { step: ToolStepRecord; modelText: string }> {
    const toolId = toolIdForFunctionName(call.name);
    const input = normalizeToolArguments(call.arguments);

    if (!this.registry.get(toolId)) {
      const error = `There is no tool called "${call.name}".`;
      return {
        step: { toolId, callId: '', ok: false, summary: error },
        modelText: JSON.stringify({ ok: false, error }),
      };
    }

    let record = await this.executor.call(toolId, input, {
      conversationId: options.conversationId,
      taskId: options.taskId,
    });
    yield {
      type: 'tool-call',
      messageId: options.messageId,
      toolId,
      callId: record.id,
      summary: record.intent.summary,
    };

    if (record.status === 'pending-approval') {
      const approval = this.executor.pendingApprovalForCall(record.id);
      if (!approval) {
        // Already settled (or gone) while we were emitting: trust the stored row.
        record = this.executor.getCall(record.id) ?? record;
      } else {
        yield {
          type: 'awaiting-approval',
          messageId: options.messageId,
          callId: record.id,
          approvalId: approval.id,
          summary: record.intent.summary,
        };
      }
      record = await this.waitForApproval(record, approval?.id, options);
    }

    const ok = record.status === 'succeeded';
    const summary = record.result?.summary ?? record.intent.summary;
    const preview = describeResult(record).slice(0, PREVIEW_CAP);
    yield {
      type: 'tool-result',
      messageId: options.messageId,
      toolId,
      callId: record.id,
      ok,
      summary,
      preview,
    };
    return {
      step: { toolId, callId: record.id, ok, summary, preview },
      modelText: describeResult(record),
    };
  }

  /** Block until the user (or the timeout) settles the approval this call is waiting on. */
  private async waitForApproval(
    record: ToolCallRecord,
    approvalId: string | undefined,
    options: AgentRunOptions,
  ): Promise<ToolCallRecord> {
    if (!approvalId) {
      return record;
    }
    const timeoutMs = options.unattended
      ? (options.approvalTimeoutMs ?? TASK_LIMITS.unattendedApprovalTimeoutMs)
      : undefined;

    return await new Promise<ToolCallRecord>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (value: ToolCallRecord): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        options.signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };

      const unsubscribe = this.bus.on('tool.call.changed', (changed) => {
        if (changed.id !== record.id) return;
        if (changed.status === 'pending-approval' || changed.status === 'running') return;
        finish(changed);
      });

      const onAbort = (): void => {
        void this.executor
          .deny(approvalId, 'The run was stopped before you answered.')
          .then(finish)
          .catch(() => finish(this.executor.getCall(record.id) ?? record));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          void this.executor
            .deny(approvalId, `Nobody answered this approval within ${Math.round(timeoutMs / 1000)}s, so it was denied.`)
            .then(finish)
            .catch(() => finish(this.executor.getCall(record.id) ?? record));
        }, timeoutMs);
      }
    });
  }
}

/** JSON the model can act on: outcome plus either the data or the reason it failed. */
function describeResult(record: ToolCallRecord): string {
  const result = record.result;
  if (!result) {
    return JSON.stringify({ ok: false, error: 'The tool produced no result.' });
  }
  return JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    error: result.error,
    data: result.data,
  });
}
