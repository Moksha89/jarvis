import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type {
  KnowledgeCitation,
  KnowledgeCorpus,
  KnowledgeHit,
  KnowledgeSearchOptions,
  KnowledgeSource,
  KnowledgeStats,
  ModelRuntimeAdapter,
} from '@jarvis/types';
import { INDEXABLE_EXTENSIONS, KNOWLEDGE_LIMITS, SKIPPED_DIRECTORIES } from '@jarvis/types';
import type { EventBus } from '@jarvis/events';
import type { PathGuard } from '@jarvis/tools';
import type { KnowledgeStore } from '../store/knowledge-store.js';
import type { JarvisSettings } from '../store/settings-store.js';
import { chunkText, looksBinary } from './text-chunker.js';

export interface KnowledgeServiceOptions {
  store: KnowledgeStore;
  runtime: ModelRuntimeAdapter;
  guard: PathGuard;
  settings: () => JarvisSettings;
  bus: EventBus;
}

/**
 * Local retrieval. Files the user points at are chunked and embedded through the same
 * model runtime as chat, and finished chat turns are embedded too so Jarvis can recall
 * what was said days ago. Nothing leaves the machine, and reading a file still goes
 * through the path guard: adding a folder here is not a way around Permissions.
 */
export class KnowledgeService {
  private readonly store: KnowledgeStore;
  private readonly runtime: ModelRuntimeAdapter;
  private readonly guard: PathGuard;
  private readonly settings: () => JarvisSettings;
  private readonly bus: EventBus;
  private readonly indexing = new Set<string>();

  constructor(options: KnowledgeServiceOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.guard = options.guard;
    this.settings = options.settings;
    this.bus = options.bus;
    // A source left "indexing" by a crash would otherwise stay stuck there forever,
    // and the UI disables its only recovery action while a source reads as indexing.
    this.store.clearStaleIndexingStatus();
  }

  listSources(): KnowledgeSource[] {
    return this.store.listSources();
  }

  listDocuments(sourceId: string) {
    return this.store.listDocuments(sourceId);
  }

  /** Registers a folder or file and starts indexing it in the background. */
  async addSource(path: string): Promise<KnowledgeSource> {
    this.guard.assert(path, 'read');
    const info = await stat(path).catch(() => {
      throw new Error(`Jarvis cannot read "${path}".`);
    });
    const source = this.store.addSource({ path, kind: info.isDirectory() ? 'folder' : 'file' });
    this.emitSource(source.id);
    void this.indexSource(source.id).catch(() => {
      // indexSource already records the failure on the source row.
    });
    return source;
  }

  removeSource(id: string): void {
    this.store.deleteSource(id);
    this.bus.emit('knowledge.source.deleted', { id });
  }

  /**
   * Re-reads a source. Files whose size and mtime are unchanged keep their existing
   * chunks, so a folder of thousands of files is only embedded once.
   */
  async indexSource(id: string): Promise<KnowledgeSource> {
    const source = this.store.getSource(id);
    if (!source) throw new Error(`Unknown knowledge source: ${id}`);
    if (this.indexing.has(id)) throw new Error(`"${source.path}" is already being indexed.`);

    this.indexing.add(id);
    this.store.setSourceStatus(id, 'indexing', { error: undefined });
    this.emitSource(id);

    const model = this.settings().embeddingModel;
    let filesSeen = 0;
    let filesIndexed = 0;
    let chunksWritten = 0;

    try {
      this.guard.assert(source.path, 'read');
      const files = source.kind === 'folder' ? await collectFiles(source.path) : [source.path];
      const seen = new Set<string>();

      for (const file of files) {
        filesSeen += 1;
        seen.add(file);
        const written = await this.indexFile(id, file, model);
        if (written !== undefined) {
          filesIndexed += 1;
          chunksWritten += written;
        }
        this.bus.emit('knowledge.index.progress', {
          sourceId: id,
          path: source.path,
          filesSeen,
          filesIndexed,
          chunksWritten,
          done: false,
        });
      }

      // Files that disappeared should stop answering questions.
      for (const document of this.store.listDocuments(id)) {
        if (!seen.has(document.path)) this.store.deleteDocument(document.id);
      }

      this.store.setSourceStatus(id, 'idle', { indexedAt: new Date().toISOString() });
      this.bus.emit('knowledge.index.progress', {
        sourceId: id,
        path: source.path,
        filesSeen,
        filesIndexed,
        chunksWritten,
        done: true,
      });
      return this.emitSource(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setSourceStatus(id, 'error', { error: message });
      this.bus.emit('knowledge.index.progress', {
        sourceId: id,
        path: source.path,
        filesSeen,
        filesIndexed,
        chunksWritten,
        done: true,
        error: message,
      });
      this.emitSource(id);
      throw error;
    } finally {
      this.indexing.delete(id);
    }
  }

  async search(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeHit[]> {
    const text = query.trim();
    if (!text) return [];
    const model = this.settings().embeddingModel;
    const [embedding] = await this.runtime.embed({ model, input: [text] });
    if (!embedding) return [];
    const hits = this.store.search(Float32Array.from(embedding), {
      model,
      limit: options.limit,
      corpus: options.corpus,
      minScore: options.minScore,
    });
    return this.dropUnreadable(hits);
  }

  /**
   * Chunk text is stored verbatim, so a passage indexed while a folder was in scope
   * would keep answering questions after that scope is revoked. Retrieval re-checks the
   * guard and forgets what it may no longer read, so Permissions stays the single answer
   * to "can Jarvis see this file".
   */
  private dropUnreadable(hits: readonly KnowledgeHit[]): KnowledgeHit[] {
    const allowed: KnowledgeHit[] = [];
    for (const hit of hits) {
      if (hit.corpus !== 'files') {
        allowed.push(hit);
        continue;
      }
      try {
        this.guard.assert(hit.source, 'read');
        allowed.push(hit);
      } catch {
        if (hit.documentId) this.store.deleteDocument(hit.documentId);
        this.warn(`Forgot passages from "${hit.source}": it is no longer inside an allowed path.`);
      }
    }
    return allowed;
  }

  /**
   * Retrieval for a chat turn. Returns the system message to prepend and the citations
   * to keep on the answer. Retrieval never fails a turn: a missing embedding model just
   * means the model answers on its own, which is what it did before this existed.
   */
  async contextFor(query: string): Promise<{ prompt?: string; citations: KnowledgeCitation[] }> {
    if (!this.settings().memoryEnabled) return { citations: [] };
    let hits: KnowledgeHit[];
    try {
      hits = await this.search(query, { limit: KNOWLEDGE_LIMITS.retrievalLimit });
    } catch (error) {
      this.warn(`Retrieval skipped: ${error instanceof Error ? error.message : String(error)}`);
      return { citations: [] };
    }
    if (hits.length === 0) return { citations: [] };

    const citations: KnowledgeCitation[] = [];
    const blocks: string[] = [];
    let budget = KNOWLEDGE_LIMITS.contextCharBudget;
    for (const hit of hits) {
      const body = hit.text.slice(0, Math.max(0, budget));
      if (!body) break;
      budget -= body.length;
      blocks.push(`[${blocks.length + 1}] ${label(hit)}\n${body}`);
      citations.push({ corpus: hit.corpus, source: hit.source, title: hit.title, score: hit.score });
    }

    return {
      prompt: [
        'Context retrieved from the user\'s own files and past conversations on this PC:',
        '',
        blocks.join('\n\n'),
        '',
        'Use this context when it answers the question, and cite the numbered source you used.',
        'If it does not answer the question, say so and answer from your own knowledge instead;',
        'never invent file contents.',
      ].join('\n'),
      citations,
    };
  }

  /**
   * Embeds a finished turn so a later conversation can recall it. Best effort: failing
   * to remember must not fail the answer the user already has.
   */
  async remember(input: {
    conversationId: string;
    messageId: string;
    title: string;
    question: string;
    answer: string;
  }): Promise<void> {
    const settings = this.settings();
    if (!settings.rememberConversations) return;
    const text = `Q: ${input.question.trim()}\nA: ${input.answer.trim()}`.slice(
      0,
      KNOWLEDGE_LIMITS.memoryChunkChars,
    );
    if (input.answer.trim().length === 0) return;
    try {
      const [embedding] = await this.runtime.embed({ model: settings.embeddingModel, input: [text] });
      if (!embedding) return;
      // A regenerated answer replaces what was remembered, so the discarded answer
      // cannot be quoted back to the user later.
      this.store.deleteMessageChunks([input.messageId]);
      this.store.insertChunk(
        {
          corpus: 'conversations',
          conversationId: input.conversationId,
          messageId: input.messageId,
          source: input.title,
          title: input.title,
          ordinal: Date.now(),
          text,
          embedding: Float32Array.from(embedding),
        },
        settings.embeddingModel,
      );
    } catch (error) {
      this.warn(`Could not remember this turn: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  forgetConversation(conversationId: string): void {
    this.store.deleteConversationChunks(conversationId);
  }

  /** Called when a retry drops messages: their memory goes with them. */
  forgetMessages(messageIds: readonly string[]): void {
    this.store.deleteMessageChunks(messageIds);
  }

  async stats(): Promise<KnowledgeStats> {
    const model = this.settings().embeddingModel;
    const installed = await this.runtime
      .listModels()
      .then((models) => models.some((entry) => entry.id === model || entry.id.startsWith(`${model}:`)))
      .catch(() => false);
    return {
      sources: this.store.listSources().length,
      documents: this.store.countDocuments(),
      fileChunks: this.store.countChunks({ corpus: 'files', model }),
      conversationChunks: this.store.countChunks({ corpus: 'conversations', model }),
      staleChunks: this.store.countChunks({ otherModel: model }),
      embeddingModel: model,
      ready: installed,
      message: installed
        ? undefined
        : `Embedding model "${model}" is not installed. Pull it on the Models page, then reindex.`,
    };
  }

  /** Returns the chunk count, or undefined when the file was skipped or unchanged. */
  private async indexFile(sourceId: string, path: string, model: string): Promise<number | undefined> {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size === 0 || info.size > KNOWLEDGE_LIMITS.maxFileBytes) return undefined;

    const fingerprint = `${info.size}:${info.mtimeMs}:${model}`;
    if (this.store.getDocumentFingerprint(sourceId, path)?.fingerprint === fingerprint) return undefined;

    const buffer = await readFile(path);
    if (looksBinary(buffer)) return undefined;
    const chunks = chunkText(buffer.toString('utf8'));
    if (chunks.length === 0) return undefined;

    const embeddings = await this.embedBatched(chunks, model);
    this.store.replaceDocument(
      { sourceId, path, title: basename(path), fingerprint, sizeBytes: info.size, model },
      embeddings.map((embedding, ordinal) => ({
        ordinal,
        text: chunks[ordinal] as string,
        embedding,
      })),
    );
    return chunks.length;
  }

  private async embedBatched(chunks: readonly string[], model: string): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < chunks.length; start += KNOWLEDGE_LIMITS.embedBatchSize) {
      const batch = chunks.slice(start, start + KNOWLEDGE_LIMITS.embedBatchSize);
      const embeddings = await this.runtime.embed({ model, input: batch });
      for (const embedding of embeddings) vectors.push(Float32Array.from(embedding));
    }
    return vectors;
  }

  private emitSource(id: string): KnowledgeSource {
    const source = this.store.getSource(id);
    if (!source) throw new Error(`Unknown knowledge source: ${id}`);
    this.bus.emit('knowledge.source.changed', source);
    return source;
  }

  private warn(message: string): void {
    this.bus.emit('core.log', { level: 'warn', message, time: new Date().toISOString() });
  }
}

function label(hit: KnowledgeHit): string {
  const kind: Record<KnowledgeCorpus, string> = { files: 'file', conversations: 'past conversation' };
  return `${kind[hit.corpus]}: ${hit.source}`;
}

/** Walks a folder for text-ish files, skipping build output and version control. */
async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && files.length < KNOWLEDGE_LIMITS.maxFilesPerSource) {
    const directory = queue.shift() as string;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(entry.name) || entry.name.startsWith('.')) continue;
        queue.push(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!INDEXABLE_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue;
      files.push(join(directory, entry.name));
      if (files.length >= KNOWLEDGE_LIMITS.maxFilesPerSource) break;
    }
  }
  return files;
}
