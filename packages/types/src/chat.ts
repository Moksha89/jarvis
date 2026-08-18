import type { KnowledgeCitation } from './knowledge.js';

/**
 * Chat modes. Ask and Plan answer from the model alone; Agent lets the model
 * drive tools, one permission-gated step at a time.
 */
export type ChatMode = 'ask' | 'plan' | 'agent';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** What one agent tool step did, kept alongside the `tool` message that shows it. */
export interface ToolStepRecord {
  toolId: string;
  callId: string;
  ok: boolean;
  summary: string;
  /** Truncated result text, for the collapsed card in the transcript. */
  preview?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  model?: string;
  mode?: ChatMode;
  /** Set when generation was stopped or failed. */
  error?: string;
  /** Present on `tool` messages produced by an agent run. */
  step?: ToolStepRecord;
  /** Files or past turns that were retrieved and given to the model for this answer. */
  citations?: readonly KnowledgeCitation[];
}

export interface Conversation {
  id: string;
  title: string;
  mode: ChatMode;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRequest {
  conversationId: string;
  content: string;
  mode: ChatMode;
  model?: string;
}

export type ChatStreamEvent =
  | { type: 'start'; messageId: string; model: string }
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'context'; messageId: string; citations: readonly KnowledgeCitation[] }
  | { type: 'step'; messageId: string; step: number; maxSteps: number }
  | { type: 'tool-call'; messageId: string; toolId: string; callId: string; summary: string }
  | { type: 'awaiting-approval'; messageId: string; callId: string; approvalId: string; summary: string }
  | {
      type: 'tool-result';
      messageId: string;
      toolId: string;
      callId: string;
      ok: boolean;
      summary: string;
      preview?: string;
    }
  | { type: 'done'; messageId: string; content: string }
  | { type: 'error'; messageId: string; error: string };
