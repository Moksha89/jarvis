import { execFile } from 'node:child_process';
import { platform } from 'node:process';
import { promisify } from 'node:util';
import type {
  ChatCompletionRequest,
  ModelInfo,
  ModelRuntimeAdapter,
  ModelRuntimeInfo,
  ModelStreamChunk,
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
      this.fetchJson<{ models?: { name: string }[] }>('/api/ps').catch(() => ({ models: [] })),
    ]);
    const loaded = new Set((running.models ?? []).map((model) => model.name));
    return (tags.models ?? []).map((model) => ({
      id: model.name,
      name: model.name,
      parameterSize: model.details?.parameter_size,
      quantization: model.details?.quantization_level,
      family: model.details?.family,
      sizeBytes: model.size,
      modifiedAt: model.modified_at,
      loaded: loaded.has(model.name),
    }));
  }

  async loadModel(model: string): Promise<void> {
    // An empty generate request with a keep-alive window warms the model into memory.
    await this.postJson('/api/generate', { model, prompt: '', keep_alive: '10m' });
  }

  async unloadModel(model: string): Promise<void> {
    await this.postJson('/api/generate', { model, prompt: '', keep_alive: 0 });
  }

  async *streamChat(request: ChatCompletionRequest, signal?: AbortSignal): AsyncIterable<ModelStreamChunk> {
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
