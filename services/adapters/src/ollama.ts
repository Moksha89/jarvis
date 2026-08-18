import { execFile } from 'node:child_process';
import { platform } from 'node:process';
import { promisify } from 'node:util';
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  EmbeddingRequest,
  ModelInfo,
  ModelPullProgress,
  ModelRuntimeAdapter,
  ModelRuntimeInfo,
  ModelStreamChunk,
  ModelToolCall,
} from '@jarvis/types';
import { parseSseData } from './sse.js';

const run = promisify(execFile);

export interface OllamaAdapterOptions {
  /** Base URL of the local Ollama server. */
  endpoint?: string;
  requestTimeoutMs?: number;
}

interface OllamaTag {
  name: string;
  size?: number;
  modified_at?: string;
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
}

interface OllamaChatChoiceDelta {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
}

interface OllamaRunningModel {
  name: string;
  size_vram?: number;
  expires_at?: string;
}

interface OllamaNativeChunk {
  message?: {
    content?: string;
    tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

interface OllamaPullChunk {
  status?: string;
  completed?: number;
  total?: number;
  error?: string;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

/**
 * The only place in Jarvis that talks to Ollama. Chat streaming uses Ollama's
 * OpenAI-compatible `/v1/chat/completions` endpoint; model management uses its
 * native `/api/*` endpoints.
 */
export class OllamaAdapter implements ModelRuntimeAdapter {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaAdapterOptions = {}) {
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.timeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  async status(): Promise<ModelRuntimeInfo> {
    try {
      const response = await this.fetchJson<{ version: string }>('/api/version');
      return {
        id: this.id,
        name: this.name,
        status: 'ready',
        endpoint: this.endpoint,
        version: response.version,
        message: `Ollama ${response.version} is running.`,
      };
    } catch (error) {
      const installed = await this.isInstalled();
      if (!installed) {
        return {
          id: this.id,
          name: this.name,
          status: 'not-installed',
          endpoint: this.endpoint,
          message: 'Ollama was not found on this machine. Install it from ollama.com, then reopen Jarvis.',
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isConnectionRefused(message)) {
        return {
          id: this.id,
          name: this.name,
          status: 'not-running',
          endpoint: this.endpoint,
          message: `Ollama is installed but not responding on ${this.endpoint}. Start it with "ollama serve".`,
        };
      }
      return { id: this.id, name: this.name, status: 'error', endpoint: this.endpoint, message };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const [tags, running] = await Promise.all([
      this.fetchJson<{ models?: OllamaTag[] }>('/api/tags'),
      this.fetchJson<{ models?: OllamaRunningModel[] }>('/api/ps').catch(() => ({ models: [] })),
    ]);
    const loaded = new Map((running.models ?? []).map((model) => [model.name, model]));
    return (tags.models ?? []).map((model) => {
      const live = loaded.get(model.name);
      return {
        id: model.name,
        name: model.name,
        parameterSize: model.details?.parameter_size,
        quantization: model.details?.quantization_level,
        family: model.details?.family,
        sizeBytes: model.size,
        modifiedAt: model.modified_at,
        loaded: live !== undefined,
        vramBytes: live?.size_vram,
        expiresAt: live?.expires_at,
      };
    });
  }

  /** Streams Ollama's own pull progress; the caller decides how to show it. */
  async *pullModel(model: string, signal?: AbortSignal): AsyncIterable<ModelPullProgress> {
    const response = await fetch(`${this.endpoint}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama could not pull ${model} (${response.status}): ${detail.slice(0, 300)}`);
    }

    for await (const line of readNdjson<OllamaPullChunk>(response.body)) {
      if (line.error) throw new Error(line.error);
      const status = line.status ?? 'pulling';
      const done = status === 'success';
      yield {
        status,
        completedBytes: line.completed,
        totalBytes: line.total,
        percent:
          line.total && line.total > 0 && line.completed !== undefined
            ? Math.round((line.completed / line.total) * 100)
            : undefined,
        done,
      };
      if (done) return;
    }
    yield { status: 'success', done: true };
  }

  async deleteModel(model: string): Promise<void> {
    const response = await fetch(`${this.endpoint}/api/delete`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama could not delete ${model} (${response.status}): ${detail.slice(0, 300)}`);
    }
  }

  /**
   * Embeds a batch in one request. Ollama answers with `embeddings` on `/api/embed`;
   * a missing model comes back as a 404, which is worth naming for the user because
   * an embedding model has to be pulled separately from the chat model.
   */
  async embed(request: EmbeddingRequest, signal?: AbortSignal): Promise<number[][]> {
    const response = await fetch(`${this.endpoint}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: request.model, input: request.input }),
      signal: signal ?? AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 404) {
        throw new Error(
          `Embedding model "${request.model}" is not installed. Pull it on the Models page (for example nomic-embed-text), then index again.`,
        );
      }
      throw new Error(`Ollama could not embed with ${request.model} (${response.status}): ${detail.slice(0, 300)}`);
    }
    const payload = (await response.json()) as { embeddings?: number[][]; error?: string };
    if (payload.error) throw new Error(payload.error);
    const embeddings = payload.embeddings ?? [];
    if (embeddings.length !== request.input.length) {
      throw new Error(
        `Ollama returned ${embeddings.length} embeddings for ${request.input.length} inputs; the batch cannot be trusted.`,
      );
    }
    return embeddings;
  }

  async loadModel(model: string): Promise<void> {
    // An empty generate request with a keep-alive window warms the model into memory.
    await this.postJson('/api/generate', { model, prompt: '', keep_alive: '10m' });
  }

  async unloadModel(model: string): Promise<void> {
    await this.postJson('/api/generate', { model, prompt: '', keep_alive: 0 });
  }

  async *streamChat(request: ChatCompletionRequest, signal?: AbortSignal): AsyncIterable<ModelStreamChunk> {
    // Tool calling needs Ollama's native endpoint: the OpenAI-compatible one does
    // not stream partial tool calls back.
    if (request.tools?.length) {
      yield* this.streamNativeChat(request, signal);
      return;
    }

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
      }),
      signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama chat failed (${response.status}): ${detail.slice(0, 500)}`);
    }

    for await (const data of parseSseData(response.body)) {
      if (data === '[DONE]') {
        yield { type: 'done' };
        return;
      }
      let parsed: OllamaChatChoiceDelta;
      try {
        parsed = JSON.parse(data) as OllamaChatChoiceDelta;
      } catch {
        continue;
      }
      const choice = parsed.choices?.[0];
      const text = choice?.delta?.content;
      if (text) yield { type: 'delta', text };
      if (choice?.finish_reason) {
        yield { type: 'done', finishReason: choice.finish_reason };
        return;
      }
    }
    yield { type: 'done' };
  }

  private async *streamNativeChat(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamChunk> {
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toNativeMessage),
        stream: true,
        tools: request.tools?.map((tool) => ({ type: 'function', function: tool })),
        options: request.temperature === undefined ? undefined : { temperature: request.temperature },
      }),
      signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      const hint = /does not support tools/i.test(detail)
        ? ' This model has no tool support — switch Chat back to Ask, or pull a tool-capable model such as qwen2.5:7b.'
        : '';
      throw new Error(`Ollama chat failed (${response.status}): ${detail.slice(0, 300)}${hint}`);
    }

    for await (const chunk of readNdjson<OllamaNativeChunk>(response.body)) {
      if (chunk.error) throw new Error(chunk.error);
      const text = chunk.message?.content;
      if (text) yield { type: 'delta', text };
      const calls = (chunk.message?.tool_calls ?? [])
        .map((call): ModelToolCall | undefined => {
          const name = call.function?.name;
          return name ? { name, arguments: call.function?.arguments ?? {} } : undefined;
        })
        .filter((call): call is ModelToolCall => call !== undefined);
      if (calls.length > 0) yield { type: 'tool-calls', calls };
      if (chunk.done) {
        yield { type: 'done', finishReason: chunk.done_reason };
        return;
      }
    }
    yield { type: 'done' };
  }

  private async isInstalled(): Promise<boolean> {
    const probe = platform === 'win32' ? ['where', ['ollama.exe']] : ['which', ['ollama']];
    try {
      await run(probe[0] as string, probe[1] as string[]);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.endpoint}${path}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Ollama ${path} returned ${response.status}`);
    return (await response.json()) as T;
  }

  private async postJson(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama ${path} returned ${response.status}: ${detail.slice(0, 300)}`);
    }
  }
}

function isConnectionRefused(message: string): boolean {
  return /econnrefused|fetch failed|connect|timeout|aborted/i.test(message);
}

function toNativeMessage(message: ChatCompletionMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.toolName) base.tool_name = message.toolName;
  if (message.toolCalls?.length) {
    base.tool_calls = message.toolCalls.map((call) => ({
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return base;
}

/** Ollama's native endpoints stream newline-delimited JSON rather than SSE. */
async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            yield JSON.parse(line) as T;
          } catch {
            // A partial or non-JSON line is not worth tearing the stream down for.
          }
        }
        index = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as T;
      } catch {
        // A truncated trailing line is not worth tearing the stream down for.
      }
    }
  } finally {
    reader.releaseLock();
  }
}
