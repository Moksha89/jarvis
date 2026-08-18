import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:process';
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  AgentToolDescriptor,
  ModelRuntimeAdapter,
} from '@jarvis/types';
import { RiskLevel } from '@jarvis/types';
import { parseSseData } from './sse.js';

export interface QwenAdapterOptions {
  /** Base URL of `qwen serve`. */
  endpoint?: string;
  /** Command used to launch the daemon. */
  command?: string;
  args?: readonly string[];
  /** Set false to never spawn the daemon (used by the stub fallback). */
  autoStart?: boolean;
  workspace?: string;
  healthTimeoutMs?: number;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8765';

interface QwenServeEvent {
  type?: string;
  text?: string;
  delta?: string;
  content?: string;
  call_id?: string;
  tool?: string;
  input?: unknown;
  error?: string;
}

/**
 * Talks to a `qwen serve` daemon over its local HTTP/SSE surface.
 *
 * `qwen serve` is not a stable, documented protocol yet, so this adapter is written
 * defensively: it health-checks first and reports unavailability instead of throwing.
 * When it is unavailable, Core falls back to {@link StubAgentAdapter}.
 */
export class QwenCodeAgentAdapter implements AgentAdapter {
  readonly id = 'qwen-code';
  readonly name = 'Qwen Code';
  private readonly endpoint: string;
  private readonly options: QwenAdapterOptions;
  private daemon: ChildProcess | undefined;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly inflight = new Map<string, AbortController>();

  constructor(options: QwenAdapterOptions = {}) {
    this.options = options;
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
  }

  async createSession(options: { model?: string; workspace?: string } = {}): Promise<AgentSession> {
    await this.ensureDaemon();
    const response = await fetch(`${this.endpoint}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: options.model, workspace: options.workspace ?? this.options.workspace }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`qwen serve refused a session (${response.status}).`);
    const payload = (await response.json()) as { id?: string; session_id?: string };
    const id = payload.id ?? payload.session_id;
    if (!id) throw new Error('qwen serve did not return a session id.');
    const session: AgentSession = {
      id,
      status: 'idle',
      model: options.model,
      workspace: options.workspace ?? this.options.workspace,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    return session;
  }

  async *send(sessionId: string, content: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const controller = new AbortController();
    this.inflight.set(sessionId, controller);
    signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await fetch(`${this.endpoint}/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ content, stream: true }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`qwen serve rejected the message (${response.status}).`);
      }

      let assembled = '';
      for await (const data of parseSseData(response.body)) {
        if (data === '[DONE]') break;
        let event: QwenServeEvent;
        try {
          event = JSON.parse(data) as QwenServeEvent;
        } catch {
          continue;
        }
        const text = event.delta ?? event.text;
        switch (event.type) {
          case 'tool_request':
          case 'tool-request':
            yield {
              type: 'tool-request',
              sessionId,
              callId: event.call_id ?? crypto.randomUUID(),
              toolId: event.tool ?? 'unknown',
              input: event.input,
            };
            break;
          case 'error':
            yield { type: 'error', sessionId, error: event.error ?? 'Unknown qwen serve error.' };
            return;
          case 'done':
            yield { type: 'done', sessionId, content: event.content ?? assembled };
            return;
          default:
            if (text) {
              assembled += text;
              yield { type: 'delta', sessionId, text };
            }
        }
      }
      yield { type: 'done', sessionId, content: assembled };
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.inflight.get(sessionId)?.abort();
    await fetch(`${this.endpoint}/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' }).catch(
      () => undefined,
    );
  }

  async approve(sessionId: string, callId: string): Promise<void> {
    await this.resolveToolCall(sessionId, callId, true);
  }

  async deny(sessionId: string, callId: string, reason?: string): Promise<void> {
    await this.resolveToolCall(sessionId, callId, false, reason);
  }

  async getStatus(sessionId?: string): Promise<AgentSession | { available: boolean; message: string }> {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) return session;
    }
    try {
      const response = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(2_000) });
      return response.ok
        ? { available: true, message: `qwen serve is responding on ${this.endpoint}.` }
        : { available: false, message: `qwen serve returned ${response.status}.` };
    } catch {
      return { available: false, message: `No qwen serve daemon on ${this.endpoint}.` };
    }
  }

  async listTools(): Promise<AgentToolDescriptor[]> {
    try {
      const response = await fetch(`${this.endpoint}/v1/tools`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return [];
      const payload = (await response.json()) as { tools?: { id?: string; name?: string; description?: string }[] };
      return (payload.tools ?? []).map((tool) => ({
        id: tool.id ?? tool.name ?? 'unknown',
        name: tool.name ?? tool.id ?? 'unknown',
        description: tool.description ?? '',
        // Jarvis assigns risk itself; agent-declared tools start pessimistic.
        riskLevel: RiskLevel.High,
      }));
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    this.daemon?.kill();
    this.daemon = undefined;
  }

  private async resolveToolCall(sessionId: string, callId: string, approved: boolean, reason?: string): Promise<void> {
    const response = await fetch(
      `${this.endpoint}/v1/sessions/${encodeURIComponent(sessionId)}/tool-calls/${encodeURIComponent(callId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved, reason }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(`qwen serve could not record the decision (${response.status}).`);
    }
  }

  private async ensureDaemon(): Promise<void> {
    const status = await this.getStatus();
    if ('available' in status && status.available) return;
    if (this.options.autoStart === false) {
      throw new Error(`qwen serve is not running on ${this.endpoint} and auto-start is disabled.`);
    }

    const command = this.options.command ?? (platform === 'win32' ? 'qwen.cmd' : 'qwen');
    const args = [...(this.options.args ?? ['serve'])];
    this.daemon = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: false });
    this.daemon.on('error', () => {
      this.daemon = undefined;
    });

    const deadline = Date.now() + (this.options.healthTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      const health = await this.getStatus();
      if ('available' in health && health.available) return;
      await delay(500);
    }
    throw new Error(`qwen serve did not become healthy on ${this.endpoint}.`);
  }
}

/**
 * Interface-compatible stand-in used when `qwen serve` is unavailable. Chat is
 * answered by the model runtime instead, so end-to-end streaming still works and
 * no caller needs to know which path is active.
 */
export class StubAgentAdapter implements AgentAdapter {
  readonly id = 'qwen-code-stub';
  readonly name = 'Qwen Code (unavailable)';
  private readonly sessions = new Map<string, AgentSession>();

  constructor(
    private readonly runtime: ModelRuntimeAdapter,
    private readonly getModel: () => string | undefined,
    private readonly message = 'Qwen Code is not available, so chat is answered directly by the local model runtime.',
  ) {}

  async createSession(options: { model?: string; workspace?: string } = {}): Promise<AgentSession> {
    const session: AgentSession = {
      id: crypto.randomUUID(),
      status: 'idle',
      model: options.model ?? this.getModel(),
      workspace: options.workspace,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async *send(sessionId: string, content: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const model = this.sessions.get(sessionId)?.model ?? this.getModel();
    if (!model) {
      yield { type: 'error', sessionId, error: 'No model selected. Pick one on the Models page.' };
      return;
    }
    yield { type: 'status', sessionId, status: 'thinking' };
    let assembled = '';
    for await (const chunk of this.runtime.streamChat({ model, messages: [{ role: 'user', content }] }, signal)) {
      if (chunk.type === 'delta') {
        assembled += chunk.text;
        yield { type: 'delta', sessionId, text: chunk.text };
      }
    }
    yield { type: 'done', sessionId, content: assembled };
  }

  async cancel(): Promise<void> {}
  async approve(): Promise<void> {}
  async deny(): Promise<void> {}

  async getStatus(sessionId?: string): Promise<AgentSession | { available: boolean; message: string }> {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    return session ?? { available: false, message: this.message };
  }

  async listTools(): Promise<AgentToolDescriptor[]> {
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
