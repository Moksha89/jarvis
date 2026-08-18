import type { McpServerInput, McpTrust } from '@jarvis/types';
import { MCP_LIMITS } from '@jarvis/types';
import type { JarvisDatabase } from '../db/database.js';

/** A configured skill server, without the live connection state the manager adds. */
export interface StoredMcpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  trust: McpTrust;
  enabled: boolean;
  createdAt: string;
}

interface McpServerRow {
  id: string;
  name: string;
  command: string;
  args_json: string;
  trust: string;
  enabled: number;
  created_at: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export class McpStore {
  constructor(private readonly db: JarvisDatabase) {}

  create(input: McpServerInput): StoredMcpServer {
    if (this.list().length >= MCP_LIMITS.maxServers) {
      throw new Error(`Jarvis keeps at most ${MCP_LIMITS.maxServers} skill servers.`);
    }
    const validated = validateServer(input);
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, command, args_json, trust, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        validated.name,
        validated.command,
        JSON.stringify(validated.args),
        validated.trust,
        input.enabled === false ? 0 : 1,
        new Date().toISOString(),
      );
    return this.require(id);
  }

  setEnabled(id: string, enabled: boolean): StoredMcpServer {
    this.require(id);
    this.db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.require(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }

  get(id: string): StoredMcpServer | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
    return row ? toServer(row) : undefined;
  }

  require(id: string): StoredMcpServer {
    const server = this.get(id);
    if (!server) throw new Error(`Unknown skill server: ${id}`);
    return server;
  }

  list(): StoredMcpServer[] {
    const rows = this.db.prepare('SELECT * FROM mcp_servers ORDER BY name ASC').all() as McpServerRow[];
    return rows.map(toServer);
  }
}

function toServer(row: McpServerRow): StoredMcpServer {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: parseArgs(row.args_json),
    trust: normaliseTrust(row.trust),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function parseArgs(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
}

function normaliseTrust(raw: string): McpTrust {
  return raw === 'read-only' || raw === 'sensitive' ? raw : 'normal';
}

/**
 * The name becomes part of every tool id (`mcp.<name>.<tool>`), so it is kept to a
 * slug: a name with a dot or space would make tool ids ambiguous to permission rules.
 */
export function validateServer(input: McpServerInput): {
  name: string;
  command: string;
  args: string[];
  trust: McpTrust;
} {
  const name = input.name?.trim().toLowerCase() ?? '';
  if (!NAME_PATTERN.test(name)) {
    throw new Error('Use a short name with lowercase letters, numbers or dashes, for example "files".');
  }
  const command = input.command?.trim() ?? '';
  if (!command) throw new Error('Give the command that starts the server, for example "npx".');
  const args = (input.args ?? [])
    .map((arg) => String(arg).trim())
    .filter((arg) => arg.length > 0)
    .slice(0, 32);
  return { name: name.slice(0, 40), command, args, trust: normaliseTrust(input.trust) };
}
