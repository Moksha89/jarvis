import type { AgentAdapter, ChatMessage, ChatMode, ChatStreamEvent, ModelRuntimeAdapter } from '@jarvis/types';
import type { EventBus } from '@jarvis/events';
import type { ConversationStore } from '../store/conversation-store.js';
import type { ModelRouter } from './model-router.js';
import type { TaskManager } from './task-manager.js';

const SYSTEM_PROMPTS: Record<ChatMode, string> = {
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
}

/**
 * Owns conversation state and streaming. It talks to the agent adapter when one is
 * usable and to the model runtime otherwise, so callers never choose a backend.
 */
export class ChatService {
  constructor(
    private readonly conversations: ConversationStore,
    private readonly router: ModelRouter,
    private readonly runtime: ModelRuntimeAdapter,
    private readonly tasks: TaskManager,
    private readonly bus: EventBus,
    private readonly agent?: AgentAdapter,
  ) {}

  async *send(options: SendOptions): AsyncGenerator<ChatStreamEvent> {
    if (options.retryFromMessageId) {
      this.conversations.deleteMessagesFrom(options.conversationId, options.retryFromMessageId);
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
      kind: 'chat',
      conversationId: options.conversationId,
      detail: `${options.mode} mode`,
    });

    let route: { model: string };
    try {
      route = await this.router.route({ requested: options.model ?? conversation.model, mode: options.mode });
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

    const assistant = this.conversations.addMessage({
      conversationId: options.conversationId,
      role: 'assistant',
      content: '',
      model: route.model,
      mode: options.mode,
    });
    this.tasks.update(task.id, { status: 'running' });
    yield this.emit({ type: 'start', messageId: assistant.id, model: route.model });

    const history = this.conversations
      .listMessages(options.conversationId)
      .filter((message) => message.id !== assistant.id && message.content.length > 0);

    let assembled = '';
    try {
      for await (const text of this.streamText(history, options, route.model)) {
        assembled += text;
        yield this.emit({ type: 'delta', messageId: assistant.id, text });
      }
      this.conversations.updateMessage(assistant.id, { content: assembled });
      this.tasks.update(task.id, { status: 'succeeded' });
      yield this.emit({ type: 'done', messageId: assistant.id, content: assembled });
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? 'Generation stopped.'
          : error instanceof Error
            ? error.message
            : String(error);
      this.conversations.updateMessage(assistant.id, { content: assembled, error: message });
      this.tasks.update(task.id, { status: assembled ? 'cancelled' : 'failed', error: message });
      yield this.emit({ type: 'error', messageId: assistant.id, error: message });
    }
  }

  private async *streamText(
    history: readonly ChatMessage[],
    options: SendOptions,
    model: string,
  ): AsyncGenerator<string> {
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPTS[options.mode] },
      ...history.map((message) => ({
        role: message.role === 'system' ? ('system' as const) : (message.role as 'user' | 'assistant'),
        content: message.content,
      })),
    ];

    if (this.agent && (await this.isAgentUsable())) {
      const session = await this.agent.createSession({ model });
      for await (const event of this.agent.send(session.id, options.content, options.signal)) {
        if (event.type === 'delta') yield event.text;
        if (event.type === 'error') throw new Error(event.error);
      }
      return;
    }

    for await (const chunk of this.runtime.streamChat({ model, messages }, options.signal)) {
      if (chunk.type === 'delta') yield chunk.text;
    }
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
