import type {
  AgentAdapter,
  ChatCompletionMessage,
  ChatMessage,
  ChatMode,
  ChatStreamEvent,
  KnowledgeCitation,
  ModelRuntimeAdapter,
  Task,
} from '@jarvis/types';
import { TASK_LIMITS } from '@jarvis/types';
import type { EventBus } from '@jarvis/events';
import type { ConversationStore } from '../store/conversation-store.js';
import type { AgentRunner } from './agent-runner.js';
import type { KnowledgeService } from './knowledge-service.js';
import type { ModelRouter } from './model-router.js';
import type { TaskManager } from './task-manager.js';

const SYSTEM_PROMPTS: Record<'ask' | 'plan', string> = {
  ask: 'You are Jarvis, a local assistant running on the user\'s Windows PC. Answer directly and concisely. Use Markdown for structure and fenced code blocks with a language tag for code.',
  plan: 'You are Jarvis in Plan mode. Do not perform actions. Produce a short numbered plan, then list the risks and what you would need permission to touch. Keep it under 200 words unless asked otherwise.',
};

export interface SendOptions {
  conversationId: string;
  content: string;
  mode: ChatMode;
  model?: string;
  /** Regenerate: drop this message and everything after it before answering. */
  retryFromMessageId?: string;
  signal?: AbortSignal;
  /** Agent mode only: how many tool steps the run may take. */
  maxSteps?: number;
  /** Agent mode only: no one is watching, so pending approvals fail closed. */
  unattended?: boolean;
}

/**
 * Owns conversation state and streaming. Ask and Plan answer from the model alone;
 * Agent hands the turn to `AgentRunner`, which drives tools through the executor.
 */
export class ChatService {
  constructor(
    private readonly conversations: ConversationStore,
    private readonly router: ModelRouter,
    private readonly runtime: ModelRuntimeAdapter,
    private readonly tasks: TaskManager,
    private readonly bus: EventBus,
    private readonly agentRunner: AgentRunner,
    private readonly knowledge?: KnowledgeService,
    private readonly agent?: AgentAdapter,
  ) {}

  async *send(options: SendOptions): AsyncGenerator<ChatStreamEvent> {
    if (options.retryFromMessageId) {
      // The memory of a discarded answer goes with the answer, so a retry cannot be
      // quoted back later from what the user threw away.
      const dropped = this.droppedMessageIds(options.conversationId, options.retryFromMessageId);
      this.conversations.deleteMessagesFrom(options.conversationId, options.retryFromMessageId);
      this.knowledge?.forgetMessages(dropped);
    }

    const conversation = this.conversations.get(options.conversationId);
    if (!conversation) throw new Error(`Unknown conversation: ${options.conversationId}`);

    this.conversations.addMessage({
      conversationId: options.conversationId,
      role: 'user',
      content: options.content,
      mode: options.mode,
    });
    if (conversation.title === 'New conversation') {
      this.conversations.rename(options.conversationId, options.content.slice(0, 60));
    }

    const task = this.tasks.create({
      title: options.content.slice(0, 80),
      kind: options.mode === 'agent' ? 'agent' : 'chat',
      conversationId: options.conversationId,
      detail: `${options.mode} mode`,
    });

    let model: string;
    try {
      model = (await this.router.route({ requested: options.model ?? conversation.model, mode: options.mode })).model;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.tasks.update(task.id, { status: 'failed', error: message });
      const failed = this.conversations.addMessage({
        conversationId: options.conversationId,
        role: 'assistant',
        content: '',
        mode: options.mode,
        error: message,
      });
      yield this.emit({ type: 'error', messageId: failed.id, error: message });
      return;
    }

    const context = (await this.knowledge?.contextFor(options.content)) ?? { citations: [] };

    if (options.mode === 'agent') {
      yield* this.runAgent(options, model, task, context);
      return;
    }

    const assistant = this.conversations.addMessage({
      conversationId: options.conversationId,
      role: 'assistant',
      content: '',
      model,
      mode: options.mode,
    });
    this.tasks.update(task.id, { status: 'running' });
    yield this.emit({ type: 'start', messageId: assistant.id, model });
    if (context.citations.length > 0) {
      this.conversations.updateMessage(assistant.id, { citations: context.citations });
      yield this.emit({ type: 'context', messageId: assistant.id, citations: context.citations });
    }

    const history = this.conversations
      .listMessages(options.conversationId)
      .filter((message) => message.id !== assistant.id && message.content.length > 0);

    let assembled = '';
    try {
      for await (const text of this.streamText(history, options, model, context.prompt)) {
        assembled += text;
        yield this.emit({ type: 'delta', messageId: assistant.id, text });
      }
      this.conversations.updateMessage(assistant.id, { content: assembled });
      this.tasks.update(task.id, { status: 'succeeded' });
      void this.remember(options, assistant.id, assembled);
      yield this.emit({ type: 'done', messageId: assistant.id, content: assembled });
    } catch (error) {
      const message = toMessage(error);
      this.conversations.updateMessage(assistant.id, { content: assembled, error: message });
      this.tasks.update(task.id, { status: assembled ? 'cancelled' : 'failed', error: message });
      yield this.emit({ type: 'error', messageId: assistant.id, error: message });
    }
  }

  /**
   * Agent turns write the tool trail to the conversation as they go, then store the
   * final answer last so the transcript reads in the order the work happened.
   */
  private async *runAgent(
    options: SendOptions,
    model: string,
    task: Task,
    context: { prompt?: string; citations: readonly KnowledgeCitation[] },
  ): AsyncGenerator<ChatStreamEvent> {
    const messageId = crypto.randomUUID();
    this.tasks.update(task.id, { status: 'running' });
    yield this.emit({ type: 'start', messageId, model });
    if (context.citations.length > 0) {
      yield this.emit({ type: 'context', messageId, citations: context.citations });
    }

    const history = this.conversations
      .listMessages(options.conversationId)
      .filter((message) => message.content.length > 0)
      .map(toCompletionMessage);
    // Retrieved context rides in front of the turn; the agent can also call
    // `knowledge.search` itself when it needs more than this.
    if (context.prompt) history.unshift({ role: 'system', content: context.prompt });
    const maxSteps = clampSteps(options.maxSteps ?? TASK_LIMITS.maxSteps);

    try {
      const run = this.agentRunner.run({
        conversationId: options.conversationId,
        model,
        history,
        maxSteps,
        messageId,
        taskId: task.id,
        signal: options.signal,
        unattended: options.unattended,
      });

      for (;;) {
        const next = await run.next();
        if (next.done) {
          this.conversations.addMessage({
            id: messageId,
            conversationId: options.conversationId,
            role: 'assistant',
            content: next.value.content,
            model,
            mode: 'agent',
            citations: context.citations.length > 0 ? context.citations : undefined,
          });
          void this.remember(options, messageId, next.value.content);
          this.tasks.update(task.id, {
            status: 'succeeded',
            detail: `agent mode · ${next.value.steps.length} tool ${next.value.steps.length === 1 ? 'call' : 'calls'}`,
          });
          yield this.emit({ type: 'done', messageId, content: next.value.content });
          return;
        }

        const event = next.value;
        if (event.type === 'tool-result') {
          this.conversations.addMessage({
            conversationId: options.conversationId,
            role: 'tool',
            content: event.summary,
            mode: 'agent',
            step: {
              toolId: event.toolId,
              callId: event.callId,
              ok: event.ok,
              summary: event.summary,
              preview: event.preview,
            },
          });
        } else if (event.type === 'awaiting-approval') {
          this.tasks.update(task.id, { status: 'awaiting-approval', detail: event.summary });
        }
        yield this.emit(event);
      }
    } catch (error) {
      const message = toMessage(error);
      this.conversations.addMessage({
        id: messageId,
        conversationId: options.conversationId,
        role: 'assistant',
        content: '',
        model,
        mode: 'agent',
        error: message,
      });
      const stopped = message === 'Generation stopped.';
      this.tasks.update(task.id, { status: stopped ? 'cancelled' : 'failed', error: message });
      yield this.emit({ type: 'error', messageId, error: message });
    }
  }

  private async *streamText(
    history: readonly ChatMessage[],
    options: SendOptions,
    model: string,
    context?: string,
  ): AsyncGenerator<string> {
    const mode = options.mode === 'plan' ? 'plan' : 'ask';
    const messages: ChatCompletionMessage[] = [
      { role: 'system', content: SYSTEM_PROMPTS[mode] },
      ...(context ? [{ role: 'system' as const, content: context }] : []),
      ...history.map(toCompletionMessage),
    ];

    if (this.agent && (await this.isAgentUsable())) {
      const session = await this.agent.createSession({ model });
      // The agent session takes a single prompt, so retrieved passages ride in front of
      // the question: an answer must never be cited with sources it never saw.
      const prompt = context ? `${context}\n\n${options.content}` : options.content;
      for await (const event of this.agent.send(session.id, prompt, options.signal)) {
        if (event.type === 'delta') yield event.text;
        if (event.type === 'error') throw new Error(event.error);
      }
      return;
    }

    for await (const chunk of this.runtime.streamChat({ model, messages }, options.signal)) {
      if (chunk.type === 'delta') yield chunk.text;
    }
  }

  /** Message ids from the retry point onward, whose memory is about to be invalid. */
  private droppedMessageIds(conversationId: string, fromMessageId: string): string[] {
    const messages = this.conversations.listMessages(conversationId);
    const start = messages.findIndex((message) => message.id === fromMessageId);
    if (start < 0) return [];
    return messages.slice(start).map((message) => message.id);
  }

  /** Fire-and-forget: remembering a turn must never fail the answer the user has. */
  private remember(options: SendOptions, messageId: string, answer: string): Promise<void> {
    if (!this.knowledge || !answer.trim()) return Promise.resolve();
    const conversation = this.conversations.get(options.conversationId);
    return this.knowledge.remember({
      conversationId: options.conversationId,
      messageId,
      title: conversation?.title ?? 'Conversation',
      question: options.content,
      answer,
    });
  }

  private async isAgentUsable(): Promise<boolean> {
    if (!this.agent) return false;
    const status = await this.agent.getStatus();
    return 'available' in status ? status.available : true;
  }

  private emit(event: ChatStreamEvent): ChatStreamEvent {
    this.bus.emit('chat.stream', event);
    return event;
  }
}

function toCompletionMessage(message: ChatMessage): ChatCompletionMessage {
  if (message.role === 'tool') {
    // Replay a past tool step as narration. Phrased as prose on purpose: a transcript that
    // looks like tool syntax teaches small models to fake tool traces instead of calling.
    return {
      role: 'assistant',
      content: `Earlier in this conversation I used ${message.step?.toolId ?? 'a tool'} and it reported: ${message.content}`,
    };
  }
  return { role: message.role, content: message.content };
}

function clampSteps(steps: number): number {
  return Math.max(1, Math.min(TASK_LIMITS.maxSteps, Math.trunc(steps)));
}

function toMessage(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'Generation stopped.';
  }
  return error instanceof Error ? error.message : String(error);
}
