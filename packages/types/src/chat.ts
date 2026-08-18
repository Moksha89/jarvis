/** MVP chat modes. Agent/Build modes are deliberately out of scope for this milestone. */
export type ChatMode = 'ask' | 'plan';

export type MessageRole = 'system' | 'user' | 'assistant';

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
  | { type: 'done'; messageId: string; content: string }
  | { type: 'error'; messageId: string; error: string };
