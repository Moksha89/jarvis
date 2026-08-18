import { KNOWLEDGE_LIMITS } from '@jarvis/types';

export interface ChunkOptions {
  chunkChars?: number;
  overlapChars?: number;
  maxChunks?: number;
}

/**
 * Splits text on paragraph boundaries first, falling back to hard slices for long
 * runs (minified files, single-line logs). Consecutive chunks overlap so a sentence
 * cut in half is still retrievable from at least one side.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const chunkChars = options.chunkChars ?? KNOWLEDGE_LIMITS.chunkChars;
  const overlap = Math.min(options.overlapChars ?? KNOWLEDGE_LIMITS.chunkOverlapChars, Math.floor(chunkChars / 2));
  const maxChunks = options.maxChunks ?? KNOWLEDGE_LIMITS.maxChunksPerDocument;

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let current = '';

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = overlap > 0 ? trimmed.slice(-overlap) : '';
  };

  for (const paragraph of normalized.split(/\n{2,}/)) {
    for (const piece of splitLong(paragraph.trim(), chunkChars)) {
      if (!piece) continue;
      if (current && current.length + piece.length + 2 > chunkChars) {
        push();
        if (chunks.length >= maxChunks) return chunks;
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current.trim()) {
    const trimmed = current.trim();
    // The overlap tail alone is not new content; only keep it if it adds something.
    if (chunks.length === 0 || !chunks[chunks.length - 1]?.endsWith(trimmed)) chunks.push(trimmed);
  }
  return chunks.slice(0, maxChunks);
}

function splitLong(paragraph: string, chunkChars: number): string[] {
  if (paragraph.length <= chunkChars) return [paragraph];
  const pieces: string[] = [];
  for (let index = 0; index < paragraph.length; index += chunkChars) {
    pieces.push(paragraph.slice(index, index + chunkChars));
  }
  return pieces;
}

/** True when a buffer looks like binary content and should not be embedded. */
export function looksBinary(sample: Buffer): boolean {
  const length = Math.min(sample.length, 4_096);
  for (let index = 0; index < length; index += 1) {
    if (sample[index] === 0) return true;
  }
  return false;
}
