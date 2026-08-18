import type { RiskLevel } from './risk.js';
import type { PermissionDecision } from './permission.js';

export type ToolCategory = 'filesystem' | 'shell' | 'system' | 'network' | 'app';

/** Minimal JSON-Schema subset used to describe and validate tool input (spec ss54). */
export interface ToolParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: readonly string[];
  items?: ToolParameterSchema;
  default?: string | number | boolean;
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, ToolParameterSchema>;
  required: readonly string[];
}

/** What a tool call intends to do, resolved before the permission engine runs. */
export interface ToolIntent {
  summary: string;
  target?: string;
  riskLevel: RiskLevel;
  reversible: boolean;
  paths?: readonly { path: string; mode: 'read' | 'read-write' }[];
}

export interface ToolExecutionContext {
  callId: string;
  taskId?: string;
  conversationId?: string;
  signal?: AbortSignal;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Short human-readable outcome recorded in the audit log. */
  summary: string;
}

/** The common tool contract every capability implements (spec ss54). */
export interface JarvisTool<TInput = Record<string, unknown>, TOutput = unknown> {
  id: string;
  name: string;
  version: string;
  category: ToolCategory;
  description: string;
  /** Baseline risk before per-call classification. */
  baseRiskLevel: RiskLevel;
  reversible: boolean;
  inputSchema: ToolInputSchema;
  /** Resolve the concrete intent (risk, target, paths) for a specific input. */
  describe(input: TInput): ToolIntent;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}

export interface ToolCallRecord {
  id: string;
  toolId: string;
  action: string;
  input: unknown;
  intent: ToolIntent;
  decision: PermissionDecision;
  status: 'pending-approval' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  result?: ToolResult;
}
