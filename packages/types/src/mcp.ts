/**
 * How much a server's tools are trusted. It decides the risk level its tools
 * carry, because Jarvis cannot see what a third-party tool does before it runs.
 */
export type McpTrust = 'read-only' | 'normal' | 'sensitive';

export interface McpServerInput {
  name: string;
  command: string;
  args: readonly string[];
  trust: McpTrust;
  enabled?: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  trust: McpTrust;
  enabled: boolean;
  createdAt: string;
  /** Live connection state, filled in by the manager rather than the store. */
  connected: boolean;
  error?: string;
  tools: McpToolSummary[];
}

export interface McpToolSummary {
  /** The Jarvis tool id the server's tool is registered under. */
  id: string;
  name: string;
  description: string;
}

export const MCP_LIMITS = {
  maxServers: 16,
  maxToolsPerServer: 64,
  connectTimeoutMs: 20_000,
  callTimeoutMs: 120_000,
  maxResultChars: 20_000,
} as const;
