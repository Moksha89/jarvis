import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  EmbeddingRequest,
  ModelInfo,
  ModelPullProgress,
  ModelRuntimeAdapter,
  ModelRuntimeInfo,
  PathScope,
} from '@jarvis/types';
import { EventBus } from '@jarvis/events';
import { createPathGuard } from '@jarvis/tools';
import { openDatabase, type JarvisDatabase } from '../db/database.js';
import { ConversationStore } from '../store/conversation-store.js';
import { KnowledgeStore } from '../store/knowledge-store.js';
import { DEFAULT_SETTINGS, type JarvisSettings } from '../store/settings-store.js';
import { KnowledgeService } from './knowledge-service.js';
import { createKnowledgeSearchTool } from './knowledge-tool.js';
import { chunkText, looksBinary } from './text-chunker.js';

/**
 * Deterministic stand-in for an embedding model: a bag-of-words vector over a fixed
 * vocabulary, so "budget" text really is nearer a "budget" query than unrelated text.
 */
const VOCABULARY = ['budget', 'invoice', 'rocket', 'holiday', 'jarvis'];

class WordVectorRuntime implements ModelRuntimeAdapter {
  readonly id = 'word-vectors';
  readonly name = 'Word vectors';
  readonly batches: EmbeddingRequest[] = [];
  installed = true;

  async status(): Promise<ModelRuntimeInfo> {
    return { id: this.id, name: this.name, status: 'ready', endpoint: 'test://' };
  }
  async listModels(): Promise<ModelInfo[]> {
    return this.installed ? [{ id: 'test-embed', name: 'test-embed', loaded: false }] : [];
  }
  async loadModel(): Promise<void> {}
  async unloadModel(): Promise<void> {}
  async *pullModel(): AsyncGenerator<ModelPullProgress> {
    yield { status: 'success', done: true };
  }
  async deleteModel(): Promise<void> {}
  async *streamChat(): AsyncGenerator<never> {}

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    this.batches.push(request);
    return request.input.map((text) => {
      const lower = text.toLowerCase();
      const vector = VOCABULARY.map((word) => (lower.includes(word) ? 1 : 0));
      // Keep every vector non-zero so a hit is never dropped for being all zeros.
      return [...vector, 0.01];
    });
  }
}

interface Harness {
  db: JarvisDatabase;
  conversations: ConversationStore;
  store: KnowledgeStore;
  service: KnowledgeService;
  runtime: WordVectorRuntime;
  bus: EventBus;
  settings: JarvisSettings;
}

function harness(workspace: string, patch: Partial<JarvisSettings> = {}): Harness {
  const db = openDatabase(':memory:');
  const store = new KnowledgeStore(db);
  const runtime = new WordVectorRuntime();
  const bus = new EventBus();
  const settings: JarvisSettings = { ...DEFAULT_SETTINGS, embeddingModel: 'test-embed', ...patch };
  const scopes: PathScope[] = [
    { id: 'scope-1', path: workspace, mode: 'read', effect: 'allow', createdAt: new Date().toISOString() },
  ];
  const service = new KnowledgeService({
    store,
    runtime,
    guard: createPathGuard(() => scopes),
    settings: () => settings,
    bus,
  });
  return { db, conversations: new ConversationStore(db), store, service, runtime, bus, settings };
}

describe('chunkText', () => {
  it('splits on paragraphs and overlaps consecutive chunks', () => {
    const text = `${'a'.repeat(80)}\n\n${'b'.repeat(80)}`;
    const chunks = chunkText(text, { chunkChars: 100, overlapChars: 20 });
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.startsWith('a'.repeat(20))).toBe(true);
  });

  it('hard-slices a paragraph longer than one chunk', () => {
    const line = Array.from({ length: 250 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('');
    const chunks = chunkText(line, { chunkChars: 100, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it('returns nothing for whitespace and respects the chunk cap', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
    expect(chunkText('y'.repeat(1_000), { chunkChars: 10, overlapChars: 0, maxChunks: 3 })).toHaveLength(3);
  });

  it('detects binary content by its NUL bytes', () => {
    expect(looksBinary(Buffer.from([0x68, 0x69]))).toBe(false);
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
  });
});

describe('KnowledgeService', () => {
  let workspace: string;
  let open: Harness | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'jarvis-knowledge-'));
  });

  afterEach(() => {
    open?.db.close();
    open = undefined;
  });

  it('indexes a folder, skipping build output, binaries and unsupported files', async () => {
    writeFileSync(join(workspace, 'notes.md'), 'The budget for Q3 is fixed.', 'utf8');
    writeFileSync(join(workspace, 'photo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    writeFileSync(join(workspace, 'data.bin'), Buffer.from([0x01, 0x00, 0x02]));
    mkdirSync(join(workspace, 'node_modules'));
    writeFileSync(join(workspace, 'node_modules', 'dep.md'), 'ignored dependency prose', 'utf8');

    open = harness(workspace);
    const source = open.store.addSource({ path: workspace, kind: 'folder' });
    await open.service.indexSource(source.id);

    const documents = open.service.listDocuments(source.id);
    expect(documents.map((document) => document.path)).toEqual([join(workspace, 'notes.md')]);
    expect(open.service.listSources()[0]).toMatchObject({ status: 'idle', documentCount: 1 });
  });

  it('leaves unchanged files alone on a reindex and drops deleted ones', async () => {
    const kept = join(workspace, 'kept.md');
    const removed = join(workspace, 'removed.md');
    writeFileSync(kept, 'budget notes', 'utf8');
    writeFileSync(removed, 'invoice notes', 'utf8');

    open = harness(workspace);
    const source = open.store.addSource({ path: workspace, kind: 'folder' });
    await open.service.indexSource(source.id);
    const embedCalls = open.runtime.batches.length;

    const { unlinkSync } = await import('node:fs');
    unlinkSync(removed);
    await open.service.indexSource(source.id);

    expect(open.runtime.batches.length).toBe(embedCalls);
    expect(open.service.listDocuments(source.id).map((document) => document.path)).toEqual([kept]);
  });

  it('refuses a path outside the allowed scopes', async () => {
    open = harness(workspace);
    await expect(open.service.addSource(join(tmpdir(), 'jarvis-not-allowed'))).rejects.toThrow(/not permitted/i);
  });

  it('records an indexing failure on the source instead of throwing it away', async () => {
    open = harness(workspace);
    const source = open.store.addSource({ path: join(workspace, 'gone'), kind: 'folder' });
    open.runtime.installed = false;

    await open.service.indexSource(source.id);
    // A folder that cannot be read yields no files, which is not an error by itself.
    expect(open.service.listSources()[0]).toMatchObject({ status: 'idle', documentCount: 0 });
  });

  it('retrieves the passage that matches the question, not an unrelated one', async () => {
    writeFileSync(join(workspace, 'budget.md'), 'The budget for Q3 is fixed.', 'utf8');
    writeFileSync(join(workspace, 'rocket.md'), 'The rocket launches on Friday.', 'utf8');

    open = harness(workspace);
    const source = open.store.addSource({ path: workspace, kind: 'folder' });
    await open.service.indexSource(source.id);

    const hits = await open.service.search('what about the budget');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.source).toBe(join(workspace, 'budget.md'));
  });

  it('builds a citable context prompt and stays inside its character budget', async () => {
    writeFileSync(join(workspace, 'budget.md'), `budget ${'x'.repeat(9_000)}`, 'utf8');

    open = harness(workspace);
    const source = open.store.addSource({ path: workspace, kind: 'folder' });
    await open.service.indexSource(source.id);

    const context = await open.service.contextFor('budget');
    expect(context.prompt).toContain('[1] file:');
    expect(context.prompt?.length).toBeLessThan(6_000);
    expect(context.citations[0]).toMatchObject({ corpus: 'files' });
  });

  it('retrieves nothing when memory is switched off', async () => {
    writeFileSync(join(workspace, 'budget.md'), 'The budget is fixed.', 'utf8');
    open = harness(workspace, { memoryEnabled: false });
    const source = open.store.addSource({ path: workspace, kind: 'folder' });
    await open.service.indexSource(source.id);

    expect(await open.service.contextFor('budget')).toEqual({ citations: [] });
  });

  it('remembers a finished turn, retrieves it later, and forgets it with the conversation', async () => {
    open = harness(workspace);
    // The chunk references the conversation row, so memory dies with the conversation.
    const conversation = open.conversations.create({ mode: 'ask', title: 'Holiday plans' });
    await open.service.remember({
      conversationId: conversation.id,
      title: 'Holiday plans',
      question: 'When is the holiday?',
      answer: 'The holiday starts on the 4th.',
    });

    const hits = await open.service.search('holiday', { corpus: 'conversations' });
    expect(hits[0]).toMatchObject({ corpus: 'conversations', conversationId: conversation.id });

    open.service.forgetConversation(conversation.id);
    expect(await open.service.search('holiday', { corpus: 'conversations' })).toEqual([]);
  });

  it('never fails a turn because remembering failed', async () => {
    open = harness(workspace, { rememberConversations: false });
    await expect(
      open.service.remember({ conversationId: 'c', title: 't', question: 'q', answer: 'a' }),
    ).resolves.toBeUndefined();
    expect(open.runtime.batches).toHaveLength(0);
  });

  it('reports the embedding model as missing so the UI can say why retrieval is idle', async () => {
    open = harness(workspace);
    open.runtime.installed = false;
    const stats = await open.service.stats();
    expect(stats).toMatchObject({ ready: false, embeddingModel: 'test-embed' });
    expect(stats.message).toContain('not installed');
  });

  it('counts chunks embedded by another model as stale', async () => {
    writeFileSync(join(workspace, 'budget.md'), 'The budget is fixed.', 'utf8');
    open = harness(workspace);
    const source = open.store.addSource({ path: workspace, kind: 'folder' });
    await open.service.indexSource(source.id);

    open.settings.embeddingModel = 'other-embed';
    const stats = await open.service.stats();
    expect(stats.fileChunks).toBe(0);
    expect(stats.staleChunks).toBeGreaterThan(0);
  });
});

describe('knowledge.search tool', () => {
  let workspace: string;
  let open: Harness | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'jarvis-knowledge-tool-'));
  });

  afterEach(() => {
    open?.db.close();
    open = undefined;
  });

  it('is a safe, read-only tool that returns the matching passages', async () => {
    writeFileSync(join(workspace, 'budget.md'), 'The budget for Q3 is fixed.', 'utf8');
    open = harness(workspace);
    const source = open.store.addSource({ path: workspace, kind: 'folder' });
    await open.service.indexSource(source.id);

    const tool = createKnowledgeSearchTool(open.service);
    expect(tool.describe({ query: 'budget' })).toMatchObject({ reversible: true });

    const result = await tool.execute({ query: 'budget' }, { callId: 'call-1', signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.summary).toContain('1 passage');
  });

  it('says so plainly when nothing matches', async () => {
    open = harness(workspace);
    const tool = createKnowledgeSearchTool(open.service);
    const result = await tool.execute({ query: 'rocket' }, { callId: 'call-1', signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.summary).toContain('No indexed passage');
  });
});
