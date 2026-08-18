import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelPullProgress, ModelStreamChunk } from '@jarvis/types';
import { OllamaAdapter } from './ollama.js';

const realFetch = globalThis.fetch;

/** Serves NDJSON exactly the way Ollama's native endpoints do, chunk by chunk. */
function ndjsonResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) =>
    handler(String(input), init),
  ) as unknown as typeof fetch;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

describe('OllamaAdapter native tool calling', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('sends tools to /api/chat and surfaces tool calls and text', async () => {
    let body: Record<string, unknown> = {};
    let calledUrl = '';
    stubFetch((url, init) => {
      calledUrl = url;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ndjsonResponse([
        `${JSON.stringify({ message: { content: 'Let me look. ' } })}\n`,
        `${JSON.stringify({
          message: { tool_calls: [{ function: { name: 'filesystem_read', arguments: { path: 'a.txt' } } }] },
        })}\n`,
        // A trailing line with no newline still has to be read.
        JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }),
      ]);
    });

    const adapter = new OllamaAdapter({ endpoint: 'http://127.0.0.1:11434/' });
    const chunks = await collect<ModelStreamChunk>(
      adapter.streamChat({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'read a.txt' }],
        tools: [
          {
            name: 'filesystem_read',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        ],
      }),
    );

    expect(calledUrl).toBe('http://127.0.0.1:11434/api/chat');
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'filesystem_read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ]);
    expect(chunks).toEqual([
      { type: 'delta', text: 'Let me look. ' },
      { type: 'tool-calls', calls: [{ name: 'filesystem_read', arguments: { path: 'a.txt' } }] },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('maps tool results onto Ollama tool messages', async () => {
    let body: { messages?: Record<string, unknown>[] } = {};
    stubFetch((_url, init) => {
      body = JSON.parse(String(init?.body)) as { messages?: Record<string, unknown>[] };
      return ndjsonResponse([`${JSON.stringify({ message: { content: 'done' }, done: true })}\n`]);
    });

    const adapter = new OllamaAdapter();
    await collect(
      adapter.streamChat({
        model: 'qwen2.5:7b',
        messages: [
          { role: 'user', content: 'read a.txt' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'filesystem_read', arguments: { path: 'a.txt' } }],
          },
          { role: 'tool', content: 'hello', toolName: 'filesystem_read' },
        ],
        tools: [
          {
            name: 'filesystem_read',
            description: 'Read a file',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        ],
      }),
    );

    expect(body.messages?.[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'filesystem_read', arguments: { path: 'a.txt' } } }],
    });
    expect(body.messages?.[2]).toEqual({ role: 'tool', content: 'hello', tool_name: 'filesystem_read' });
  });

  it('explains that the model has no tool support instead of leaking the raw 400', async () => {
    stubFetch(() => new Response('registry.ollama.ai/library/llama2 does not support tools', { status: 400 }));
    const adapter = new OllamaAdapter();
    await expect(
      collect(
        adapter.streamChat({
          model: 'llama2',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ name: 'x', description: 'x', parameters: { type: 'object', properties: {}, required: [] } }],
        }),
      ),
    ).rejects.toThrow(/no tool support/i);
  });
});

describe('OllamaAdapter model management', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('reports pull progress as a percentage and stops at success', async () => {
    stubFetch(() =>
      ndjsonResponse([
        `${JSON.stringify({ status: 'pulling manifest' })}\n`,
        `${JSON.stringify({ status: 'pulling abc', completed: 50, total: 200 })}\n`,
        `${JSON.stringify({ status: 'success' })}\n`,
        `${JSON.stringify({ status: 'ignored-after-success' })}\n`,
      ]),
    );

    const adapter = new OllamaAdapter();
    const progress = await collect<ModelPullProgress>(adapter.pullModel('qwen2.5:7b'));
    expect(progress).toEqual([
      { status: 'pulling manifest', completedBytes: undefined, totalBytes: undefined, percent: undefined, done: false },
      { status: 'pulling abc', completedBytes: 50, totalBytes: 200, percent: 25, done: false },
      { status: 'success', completedBytes: undefined, totalBytes: undefined, percent: undefined, done: true },
    ]);
  });

  it('raises the error Ollama reports mid-pull', async () => {
    stubFetch(() => ndjsonResponse([`${JSON.stringify({ error: 'file does not exist' })}\n`]));
    const adapter = new OllamaAdapter();
    await expect(collect(adapter.pullModel('nope'))).rejects.toThrow(/file does not exist/);
  });

  it('merges /api/ps VRAM figures into the model list', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/tags')) {
        return Response.json({
          models: [
            { name: 'qwen2.5:7b', size: 4_000, details: { parameter_size: '7B' } },
            { name: 'cold:1b', size: 900 },
          ],
        });
      }
      return Response.json({ models: [{ name: 'qwen2.5:7b', size_vram: 5_500, expires_at: '2026-01-01T00:05:00Z' }] });
    });

    const models = await new OllamaAdapter().listModels();
    expect(models[0]).toMatchObject({
      id: 'qwen2.5:7b',
      loaded: true,
      vramBytes: 5_500,
      expiresAt: '2026-01-01T00:05:00Z',
    });
    expect(models[1]).toMatchObject({ id: 'cold:1b', loaded: false, vramBytes: undefined });
  });

  it('still lists models when /api/ps is unavailable', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen2.5:7b' }] });
      return new Response('nope', { status: 404 });
    });
    const models = await new OllamaAdapter().listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.loaded).toBe(false);
  });
});

describe('OllamaAdapter embeddings', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('posts the whole batch to /api/embed and returns one vector per input', async () => {
    let url = '';
    let body: { model?: string; input?: string[] } = {};
    stubFetch((requestUrl, init) => {
      url = requestUrl;
      body = JSON.parse(String(init?.body)) as { model?: string; input?: string[] };
      return Response.json({ embeddings: [[1, 0], [0, 1]] });
    });

    const vectors = await new OllamaAdapter().embed({ model: 'nomic-embed-text', input: ['a', 'b'] });
    expect(url).toContain('/api/embed');
    expect(body).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
    expect(vectors).toEqual([[1, 0], [0, 1]]);
  });

  it('names the missing embedding model on a 404', async () => {
    stubFetch(() => new Response('model not found', { status: 404 }));
    await expect(new OllamaAdapter().embed({ model: 'nomic-embed-text', input: ['a'] })).rejects.toThrow(
      /is not installed/i,
    );
  });

  it('refuses a batch whose length does not match the request', async () => {
    stubFetch(() => Response.json({ embeddings: [[1, 0]] }));
    await expect(new OllamaAdapter().embed({ model: 'e', input: ['a', 'b'] })).rejects.toThrow(
      /cannot be trusted/i,
    );
  });
});
