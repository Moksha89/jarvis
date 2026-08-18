import type {
  KnowledgeCorpus,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeIndexStatus,
  KnowledgeSource,
  KnowledgeSourceKind,
} from '@jarvis/types';
import { KNOWLEDGE_LIMITS } from '@jarvis/types';
import type { JarvisDatabase } from '../db/database.js';

interface SourceRow {
  id: string;
  path: string;
  kind: string;
  status: string;
  last_indexed_at: string | null;
  error: string | null;
  created_at: string;
  document_count?: number;
  chunk_count?: number;
}

interface DocumentRow {
  id: string;
  source_id: string;
  path: string;
  title: string;
  fingerprint: string;
  size_bytes: number;
  chunk_count: number;
  indexed_at: string;
}

interface ChunkRow {
  id: string;
  corpus: string;
  document_id: string | null;
  conversation_id: string | null;
  source: string;
  title: string;
  text: string;
  embedding: Buffer;
}

export interface ChunkInput {
  corpus: KnowledgeCorpus;
  documentId?: string;
  conversationId?: string;
  /** The assistant message this memory came from, so a regenerated answer replaces it. */
  messageId?: string;
  /** Where the text came from: an absolute file path, or a conversation title. */
  source: string;
  title: string;
  ordinal: number;
  text: string;
  embedding: Float32Array;
}

export interface SearchOptions {
  model: string;
  limit?: number;
  corpus?: KnowledgeCorpus;
  minScore?: number;
}

/**
 * Vector storage on top of the same SQLite file as everything else. There is no
 * ANN index: a local index is thousands of chunks, not millions, so a streamed
 * scan with a dot product is both simpler and fast enough.
 */
export class KnowledgeStore {
  constructor(private readonly db: JarvisDatabase) {}

  // ------------------------------------------------------------------ sources

  addSource(input: { path: string; kind: KnowledgeSourceKind }): KnowledgeSource {
    const existing = this.db.prepare('SELECT * FROM knowledge_sources WHERE path = ?').get(input.path) as
      | SourceRow
      | undefined;
    if (existing) return this.getSource(existing.id) as KnowledgeSource;

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO knowledge_sources (id, path, kind, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.path, input.kind, 'idle', now);
    return this.getSource(id) as KnowledgeSource;
  }

  listSources(): KnowledgeSource[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM knowledge_documents d WHERE d.source_id = s.id) AS document_count,
                (SELECT COALESCE(SUM(d.chunk_count), 0) FROM knowledge_documents d WHERE d.source_id = s.id) AS chunk_count
         FROM knowledge_sources s
         ORDER BY s.created_at ASC`,
      )
      .all() as SourceRow[];
    return rows.map(toSource);
  }

  getSource(id: string): KnowledgeSource | undefined {
    const row = this.db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM knowledge_documents d WHERE d.source_id = s.id) AS document_count,
                (SELECT COALESCE(SUM(d.chunk_count), 0) FROM knowledge_documents d WHERE d.source_id = s.id) AS chunk_count
         FROM knowledge_sources s WHERE s.id = ?`,
      )
      .get(id) as SourceRow | undefined;
    return row ? toSource(row) : undefined;
  }

  setSourceStatus(id: string, status: KnowledgeIndexStatus, options: { error?: string; indexedAt?: string } = {}): void {
    this.db
      .prepare('UPDATE knowledge_sources SET status = ?, error = ?, last_indexed_at = COALESCE(?, last_indexed_at) WHERE id = ?')
      .run(status, options.error ?? null, options.indexedAt ?? null, id);
  }

  /** Deletes children explicitly: the database is opened without `PRAGMA foreign_keys`. */
  deleteSource(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM knowledge_chunks WHERE document_id IN (SELECT id FROM knowledge_documents WHERE source_id = ?)')
        .run(id);
      this.db.prepare('DELETE FROM knowledge_documents WHERE source_id = ?').run(id);
      this.db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);
    })();
  }

  // ---------------------------------------------------------------- documents

  listDocuments(sourceId: string): KnowledgeDocument[] {
    const rows = this.db
      .prepare('SELECT * FROM knowledge_documents WHERE source_id = ? ORDER BY path ASC')
      .all(sourceId) as DocumentRow[];
    return rows.map(toDocument);
  }

  /** Fingerprint of the last indexed version of a file, used to skip unchanged files. */
  getDocumentFingerprint(sourceId: string, path: string): { id: string; fingerprint: string } | undefined {
    return this.db
      .prepare('SELECT id, fingerprint FROM knowledge_documents WHERE source_id = ? AND path = ?')
      .get(sourceId, path) as { id: string; fingerprint: string } | undefined;
  }

  deleteDocument(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(id);
      this.db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id);
    })();
  }

  /**
   * Replaces a file's chunks atomically: a half-reindexed document would silently
   * answer questions from a mix of old and new text.
   */
  replaceDocument(
    input: {
      sourceId: string;
      path: string;
      title: string;
      fingerprint: string;
      sizeBytes: number;
      model: string;
    },
    chunks: readonly Omit<ChunkInput, 'corpus' | 'documentId' | 'source' | 'title'>[],
  ): KnowledgeDocument {
    const now = new Date().toISOString();
    const existing = this.getDocumentFingerprint(input.sourceId, input.path);
    const id = existing?.id ?? crypto.randomUUID();

    this.db.transaction(() => {
      if (existing) {
        this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(id);
        this.db
          .prepare(
            `UPDATE knowledge_documents
             SET title = ?, fingerprint = ?, size_bytes = ?, chunk_count = ?, indexed_at = ?
             WHERE id = ?`,
          )
          .run(input.title, input.fingerprint, input.sizeBytes, chunks.length, now, id);
      } else {
        this.db
          .prepare(
            `INSERT INTO knowledge_documents
               (id, source_id, path, title, fingerprint, size_bytes, chunk_count, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.sourceId, input.path, input.title, input.fingerprint, input.sizeBytes, chunks.length, now);
      }
      for (const chunk of chunks) {
        this.insertChunk(
          {
            ...chunk,
            corpus: 'files',
            documentId: id,
            source: input.path,
            title: input.title,
          },
          input.model,
        );
      }
    })();

    return {
      id,
      sourceId: input.sourceId,
      path: input.path,
      title: input.title,
      chunkCount: chunks.length,
      sizeBytes: input.sizeBytes,
      indexedAt: now,
    };
  }

  // ------------------------------------------------------------------- chunks

  insertChunk(chunk: ChunkInput, model: string): string {
    const id = crypto.randomUUID();
    const normalized = normalize(chunk.embedding);
    this.db
      .prepare(
        `INSERT INTO knowledge_chunks
           (id, corpus, document_id, conversation_id, message_id, source, title, ordinal, text, embedding, dimensions, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        chunk.corpus,
        chunk.documentId ?? null,
        chunk.conversationId ?? null,
        chunk.messageId ?? null,
        chunk.source,
        chunk.title,
        chunk.ordinal,
        chunk.text,
        Buffer.from(normalized.buffer, normalized.byteOffset, normalized.byteLength),
        normalized.length,
        model,
        new Date().toISOString(),
      );
    return id;
  }

  /**
   * Brute-force cosine search. Chunks embedded by a different model are excluded
   * rather than compared: their vectors live in an unrelated space.
   */
  search(query: Float32Array, options: SearchOptions): KnowledgeHit[] {
    const limit = Math.max(1, options.limit ?? KNOWLEDGE_LIMITS.retrievalLimit);
    const minScore = options.minScore ?? KNOWLEDGE_LIMITS.minScore;
    const probe = normalize(query);

    const sql = options.corpus
      ? 'SELECT * FROM knowledge_chunks WHERE model = ? AND dimensions = ? AND corpus = ?'
      : 'SELECT * FROM knowledge_chunks WHERE model = ? AND dimensions = ?';
    const params: unknown[] = [options.model, probe.length];
    if (options.corpus) params.push(options.corpus);

    const hits: KnowledgeHit[] = [];
    for (const row of this.db.prepare(sql).iterate(...params) as Iterable<ChunkRow>) {
      const score = dot(probe, toFloat32(row.embedding));
      if (score < minScore) continue;
      hits.push({
        chunkId: row.id,
        corpus: row.corpus as KnowledgeCorpus,
        source: row.source,
        title: row.title,
        text: row.text,
        score,
        documentId: row.document_id ?? undefined,
        conversationId: row.conversation_id ?? undefined,
      });
    }
    return hits.sort((left, right) => right.score - left.score).slice(0, limit);
  }

  countChunks(options: { corpus?: KnowledgeCorpus; model?: string; otherModel?: string } = {}): number {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.corpus) {
      clauses.push('corpus = ?');
      params.push(options.corpus);
    }
    if (options.model) {
      clauses.push('model = ?');
      params.push(options.model);
    }
    if (options.otherModel) {
      clauses.push('model <> ?');
      params.push(options.otherModel);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM knowledge_chunks${where}`).get(...params) as {
      total: number;
    };
    return row.total;
  }

  countDocuments(): number {
    return (this.db.prepare('SELECT COUNT(*) AS total FROM knowledge_documents').get() as { total: number }).total;
  }

  /** Used when a conversation turn is re-remembered, so a retry cannot duplicate it. */
  deleteConversationChunks(conversationId: string): void {
    this.db.prepare("DELETE FROM knowledge_chunks WHERE corpus = 'conversations' AND conversation_id = ?").run(conversationId);
  }

  /** Drops the memory of specific turns, e.g. the answers a retry threw away. */
  deleteMessageChunks(messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    const statement = this.db.prepare('DELETE FROM knowledge_chunks WHERE message_id = ?');
    this.db.transaction(() => {
      for (const messageId of messageIds) statement.run(messageId);
    })();
  }

  /**
   * Sources are marked "indexing" in the database while a pass runs, so a crash leaves
   * that mark behind with no pass to clear it. Nothing is indexing at construction time.
   */
  clearStaleIndexingStatus(): void {
    this.db.prepare("UPDATE knowledge_sources SET status = 'idle' WHERE status = 'indexing'").run();
  }
}

function toSource(row: SourceRow): KnowledgeSource {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind as KnowledgeSourceKind,
    status: row.status as KnowledgeIndexStatus,
    documentCount: row.document_count ?? 0,
    chunkCount: row.chunk_count ?? 0,
    lastIndexedAt: row.last_indexed_at ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
  };
}

function toDocument(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    sourceId: row.source_id,
    path: row.path,
    title: row.title,
    chunkCount: row.chunk_count,
    sizeBytes: row.size_bytes,
    indexedAt: row.indexed_at,
  };
}

/** Unit vectors let the search hot loop be a dot product instead of a cosine. */
function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (length === 0) return vector;
  const result = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    result[index] = (vector[index] as number) / length;
  }
  return result;
}

function dot(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += (left[index] as number) * (right[index] as number);
  }
  return total;
}

function toFloat32(buffer: Buffer): Float32Array {
  // Copy: the buffer SQLite hands back is not guaranteed to be 4-byte aligned.
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return new Float32Array(copy);
}
