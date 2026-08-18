import type { RiskLevel } from './risk.js';

export type AgentSessionStatus = 'starting' | 'idle' | 'thinking' | 'awaiting-approval' | 'error' | 'closed';

export interface AgentSession {
  id: string;
  status: AgentSessionStatus;
  model?: string;
  workspace?: string;
  createdAt: string;
}

export interface AgentToolDescriptor {
  id: string;
  name: string;
  description: string;
  riskLevel: RiskLevel;
}

export type AgentEvent =
  | { type: 'status'; sessionId: string; status: AgentSessionStatus }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'tool-request'; sessionId: string; callId: string; toolId: string; input: unknown }
  | { type: 'tool-result'; sessionId: string; callId: string; ok: boolean; summary: string }
  | { type: 'done'; sessionId: string; content: string }
  | { type: 'error'; sessionId: string; error: string };

/** Coding-agent backends (Qwen Code today) are reached through this interface only. */
export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  createSession(options?: { model?: string; workspace?: string }): Promise<AgentSession>;
  send(sessionId: string, content: string, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
  approve(sessionId: string, callId: string): Promise<void>;
  deny(sessionId: string, callId: string, reason?: string): Promise<void>;
  getStatus(sessionId?: string): Promise<AgentSession | { available: boolean; message: string }>;
  listTools(): Promise<AgentToolDescriptor[]>;
}
