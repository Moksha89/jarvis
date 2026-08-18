import type {
  JarvisTool,
  McpServer,
  McpServerInput,
  McpToolSummary,
  McpTrust,
  RiskLevel,
  ToolInputSchema,
  ToolParameterSchema,
  ToolResult,
} from '@jarvis/types';
import { MCP_LIMITS, RiskLevel as Risk } from '@jarvis/types';
import type { EventBus } from '@jarvis/events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolRegistry } from '@jarvis/tools';
import type { McpStore, StoredMcpServer } from '../store/mcp-store.js';

/** The slice of an MCP client Jarvis uses, so tests can supply a fake in-process server. */
export interface McpClientLike {
  listTools(): Promise<{ tools: readonly McpToolDefinition[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: readonly string[] };
}

export interface McpCallResult {
  content?: readonly { type: string; text?: string }[];
  isError?: boolean;
}

export type McpConnect = (server: StoredMcpServer) => Promise<McpClientLike>;

export interface McpManagerOptions {
  store: McpStore;
  registry: ToolRegistry;
  bus: EventBus;
  /** Defaults to a stdio connection to the configured command. */
  connect?: McpConnect;
}

interface Session {
  client?: McpClientLike;
  toolIds: string[];
  tools: McpToolSummary[];
  connected: boolean;
  error?: string;
}

/**
 * Runs the configured MCP ("skill") servers and publishes their tools into the
 * registry, so a third-party tool is classified, approved and audited exactly like
 * a built-in one. Nothing a server offers can reach the model until it is registered.
 */
export class McpManager {
  private readonly sessions = new Map<string, Session>();
  private readonly connect: McpConnect;

  constructor(private readonly options: McpManagerOptions) {
    this.connect = options.connect ?? connectOverStdio;
  }

  /** Connect every enabled server. Failures are reported per server, never thrown. */
  async start(): Promise<void> {
    await Promise.all(this.options.store.list().map((server) => this.open(server)));
  }

  list(): McpServer[] {
    return this.options.store.list().map((server) => this.describe(server));
  }

  async add(input: McpServerInput): Promise<McpServer> {
    const created = this.options.store.create(input);
    await this.open(created);
    return this.publish(created.id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServer> {
    const server = this.options.store.setEnabled(id, enabled);
    await this.close(id);
    if (enabled) await this.open(server);
    return this.publish(id);
  }

  async reconnect(id: string): Promise<McpServer> {
    const server = this.options.store.require(id);
    await this.close(id);
    await this.open(server);
    return this.publish(id);
  }

  async remove(id: string): Promise<void> {
    await this.close(id);
    this.options.store.delete(id);
    this.sessions.delete(id);
    this.options.bus.emit('mcp.server.deleted', { id });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private async open(server: StoredMcpServer): Promise<void> {
    if (!server.enabled) {
      this.sessions.set(server.id, { toolIds: [], tools: [], connected: false });
      return;
    }
    try {
      const client = await this.connect(server);
      const listed = await client.listTools();
      const definitions = listed.tools.slice(0, MCP_LIMITS.maxToolsPerServer);
      const toolIds: string[] = [];
      const tools: McpToolSummary[] = [];
      for (const definition of definitions) {
        const tool = createMcpTool(server, definition, client);
        // A rename or a clash with a built-in id must not take the whole server down.
        if (this.options.registry.get(tool.id)) continue;
        this.options.registry.register(tool);
        toolIds.push(tool.id);
        tools.push({ id: tool.id, name: definition.name, description: tool.description });
      }
      this.sessions.set(server.id, { client, toolIds, tools, connected: true });
    } catch (error) {
      this.sessions.set(server.id, {
        toolIds: [],
        tools: [],
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const toolId of session.toolIds) {
      this.options.registry.unregister(toolId);
    }
    this.sessions.set(id, { toolIds: [], tools: [], connected: false });
    if (!session.client) return;
    try {
      await session.client.close();
    } catch {
      // A server that died on its own is already closed as far as Jarvis cares.
    }
  }

  private describe(server: StoredMcpServer): McpServer {
    const session = this.sessions.get(server.id);
    return {
      ...server,
      connected: session?.connected ?? false,
      error: session?.error,
      tools: session?.tools ?? [],
    };
  }

  private publish(id: string): McpServer {
    const described = this.describe(this.options.store.require(id));
    this.options.bus.emit('mcp.server.changed', described);
    return described;
  }
}

/** Trust decides the risk level, because Jarvis cannot inspect what a server's tool does. */
export function riskForTrust(trust: McpTrust): RiskLevel {
  if (trust === 'read-only') return Risk.Low;
  return trust === 'sensitive' ? Risk.High : Risk.Medium;
}

export function createMcpTool(
  server: StoredMcpServer,
  definition: McpToolDefinition,
  client: McpClientLike,
): JarvisTool<never, unknown> {
  const id = `mcp.${server.name}.${definition.name}`;
  const riskLevel = riskForTrust(server.trust);
  const reversible = server.trust === 'read-only';
  const description = (definition.description ?? `Tool ${definition.name} from the ${server.name} skill server.`).slice(
    0,
    500,
  );
  return {
    id,
    name: `${server.name}: ${definition.name}`,
    version: '1.0.0',
    category: 'app',
    description,
    baseRiskLevel: riskLevel,
    reversible,
    inputSchema: toToolInputSchema(definition.inputSchema),
    describe: () => ({
      summary: `Run ${definition.name} on the ${server.name} skill server.`,
      target: id,
      riskLevel,
      reversible,
    }),
    execute: async (input): Promise<ToolResult<unknown>> => {
      const args = isRecord(input) ? input : {};
      try {
        const result = await client.callTool({ name: definition.name, arguments: args });
        const text = textFrom(result);
        if (result.isError) {
          return { ok: false, error: text || `${definition.name} reported an error.`, summary: `${id} failed.` };
        }
        return { ok: true, data: { text }, summary: `${id} returned ${text.length} characters.` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message, summary: `${id} could not run: ${message}` };
      }
    },
  };
}

function textFrom(result: McpCallResult): string {
  const parts = (result.content ?? [])
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text ?? '');
  return parts.join('\n').slice(0, MCP_LIMITS.maxResultChars);
}

/**
 * MCP tools describe input with full JSON Schema; Jarvis uses a small subset so the
 * approval dialog can always render it. Anything richer degrades to a string field.
 */
export function toToolInputSchema(schema: McpToolDefinition['inputSchema']): ToolInputSchema {
  const properties: Record<string, ToolParameterSchema> = {};
  const source = isRecord(schema?.properties) ? schema.properties : {};
  for (const [key, raw] of Object.entries(source)) {
    properties[key] = toParameter(raw);
  }
  const required = (schema?.required ?? []).filter((key): key is string => typeof key === 'string' && key in properties);
  return { type: 'object', properties, required };
}

function toParameter(raw: unknown): ToolParameterSchema {
  if (!isRecord(raw)) return { type: 'string', description: '' };
  const type = parameterType(raw.type);
  const parameter: ToolParameterSchema = {
    type,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 300) : '',
  };
  if (Array.isArray(raw.enum)) {
    const values = raw.enum.filter((value): value is string => typeof value === 'string');
    if (values.length > 0) parameter.enum = values;
  }
  if (type === 'array') parameter.items = toParameter(raw.items);
  return parameter;
}

function parameterType(raw: unknown): ToolParameterSchema['type'] {
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === 'string') : raw;
  switch (value) {
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

function isTextish(entry: unknown): entry is { type: string; text: string } {
  return isRecord(entry) && typeof entry.type === 'string' && typeof entry.text === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The real transport: the server runs as a local child process speaking MCP over stdio. */
async function connectOverStdio(server: StoredMcpServer): Promise<McpClientLike> {
  const client = new Client({ name: 'jarvis', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    stderr: 'ignore',
  });
  await client.connect(transport, { timeout: MCP_LIMITS.connectTimeoutMs });
  return {
    listTools: async () => await client.listTools(),
    callTool: async (params) => {
      // The protocol also allows a result with no `content` at all, so both fields
      // are read defensively rather than trusted to be there.
      const result = await client.callTool(params, undefined, { timeout: MCP_LIMITS.callTimeoutMs });
      const content = Array.isArray(result.content)
        ? result.content.filter(isTextish).map((entry) => ({ type: entry.type, text: entry.text }))
        : [];
      return { content, isError: result.isError === true };
    },
    close: async () => await client.close(),
  };
}
