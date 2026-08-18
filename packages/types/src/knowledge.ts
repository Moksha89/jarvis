/** Local retrieval over the user's own files and past conversations (spec ss6, ss8). */

export type KnowledgeSourceKind = 'folder' | 'file';

export type KnowledgeIndexStatus = 'idle' | 'indexing' | 'error';

/** A folder or file the user asked Jarvis to remember. */
export interface KnowledgeSource {
  id: string;
  path: string;
  kind: KnowledgeSourceKind;
  status: KnowledgeIndexStatus;
  documentCount: number;
  chunkCount: number;
  lastIndexedAt?: string;
  error?: string;
  createdAt: string;
}

export interface KnowledgeDocument {
  id: string;
  sourceId: string;
  path: string;
  title: string;
  chunkCount: number;
  sizeBytes: number;
  indexedAt: string;
}

/** Retrieval reads two corpora: indexed files, and remembered chat turns. */
export type KnowledgeCorpus = 'files' | 'conversations';

export interface KnowledgeHit {
  chunkId: string;
  corpus: KnowledgeCorpus;
  /** File path for `files`, conversation title for `conversations`. */
  source: string;
  title: string;
  text: string;
  /** Cosine similarity, 0-1. */
  score: number;
  documentId?: string;
  conversationId?: string;
}

/** What the model was actually given, kept on the answer so it stays auditable. */
export interface KnowledgeCitation {
  corpus: KnowledgeCorpus;
  source: string;
  title: string;
  score: number;
}

export interface KnowledgeStats {
  sources: number;
  documents: number;
  fileChunks: number;
  conversationChunks: number;
  /** Chunks embedded with a different model; they are ignored until reindexed. */
  staleChunks: number;
  embeddingModel: string;
  /** False when the embedding model is missing, which makes retrieval a no-op. */
  ready: boolean;
  message?: string;
}

export interface KnowledgeIndexProgress {
  sourceId: string;
  path: string;
  filesSeen: number;
  filesIndexed: number;
  chunksWritten: number;
  done: boolean;
  error?: string;
}

export interface KnowledgeSearchOptions {
  limit?: number;
  corpus?: KnowledgeCorpus;
  minScore?: number;
}

export const KNOWLEDGE_LIMITS = {
  /** Bigger files are skipped: they are usually data, not prose worth embedding. */
  maxFileBytes: 1_000_000,
  chunkChars: 1_200,
  chunkOverlapChars: 160,
  maxChunksPerDocument: 400,
  maxFilesPerSource: 5_000,
  /** Chunks embedded per request to the runtime. */
  embedBatchSize: 16,
  retrievalLimit: 6,
  /** Below this cosine score a hit is noise and is dropped. */
  minScore: 0.3,
  /** Hard cap on retrieved text handed to the model in one turn. */
  contextCharBudget: 5_000,
  /** How much of a remembered chat turn is kept. */
  memoryChunkChars: 1_500,
} as const;

/** Text-ish extensions worth embedding. Anything else in a folder is skipped. */
export const INDEXABLE_EXTENSIONS: readonly string[] = [
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.csv',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.log',
  '.html',
  '.htm',
  '.css',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.rb',
  '.php',
  '.sh',
  '.ps1',
  '.psm1',
  '.sql',
];

/** Noise folders that would otherwise dominate an index of a code folder. */
export const SKIPPED_DIRECTORIES: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
];
