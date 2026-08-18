import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RiskLevel } from '@jarvis/types';
import { EventBus } from '@jarvis/events';
import { ToolRegistry } from '@jarvis/tools';
import { openDatabase, type JarvisDatabase } from '../db/database.js';
import { McpStore } from '../store/mcp-store.js';
import {
  McpManager,
  createMcpTool,
  riskForTrust,
  toToolInputSchema,
  type McpCallResult,
  type McpClientLike,
  type McpToolDefinition,
} from './mcp-manager.js';

/** An in-process stand-in for a skill server, so no child process is spawned. */
class FakeServer implements McpClientLike {
  closed = false;
  calls: { name: string; arguments: Record<string, unknown> }[] = [];

  constructor(
    private readonly tools: McpToolDefinition[],
    private readonly result: McpCallResult = { content: [{ type: 'text', text: 'done' }] },
  ) {}

  listTools(): Promise<{ tools: readonly McpToolDefinition[] }> {
    return Promise.resolve({ tools: this.tools });
  }

  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpCallResult> {
    this.calls.push(params);
    return Promise.resolve(this.result);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

describe('McpStore', () => {
  let db: JarvisDatabase;
  let store: McpStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new McpStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lowercases the name and keeps the arguments in order', () => {
    const server = store.create({
      name: 'Files',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\work'],
      trust: 'read-only',
    });
    expect(server.name).toBe('files');
    expect(store.require(server.id).args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'C:\\work']);
  });

  it('refuses a name that would make tool ids ambiguous', () => {
    for (const name of ['my files', 'files.read', '-files', '']) {
      expect(() => store.create({ name, command: 'npx', args: [], trust: 'normal' })).toThrow(/short name/i);
    }
  });

  it('requires a command', () => {
    expect(() => store.create({ name: 'files', command: '   ', args: [], trust: 'normal' })).toThrow(/command/i);
  });

  it('treats an unknown trust level as normal rather than trusting it', () => {
    const server = store.create({
      name: 'odd',
      command: 'npx',
      args: [],
      trust: 'anything' as 'normal',
    });
    expect(server.trust).toBe('normal');
  });
});

describe('McpManager', () => {
  let db: JarvisDatabase;
  let store: McpStore;
  let registry: ToolRegistry;
  let bus: EventBus;
  let server: FakeServer;
  let manager: McpManager;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new McpStore(db);
    registry = new ToolRegistry();
    bus = new EventBus();
    server = new FakeServer([{ name: 'read_file', description: 'Read a file.' }]);
    manager = new McpManager({ store, registry, bus, connect: () => Promise.resolve(server) });
  });

  afterEach(async () => {
    await manager.stop();
    db.close();
  });

  it('registers a connected server tool so the model can call it', async () => {
    const added = await manager.add({ name: 'files', command: 'fake', args: [], trust: 'read-only' });
    expect(added.connected).toBe(true);
    expect(added.tools.map((tool) => tool.id)).toEqual(['mcp.files.read_file']);
    expect(registry.get('mcp.files.read_file')).toBeDefined();
  });

  it('takes the tools away again when the server is switched off', async () => {
    const added = await manager.add({ name: 'files', command: 'fake', args: [], trust: 'read-only' });
    const off = await manager.setEnabled(added.id, false);
    expect(off.connected).toBe(false);
    expect(off.tools).toEqual([]);
    expect(registry.get('mcp.files.read_file')).toBeUndefined();
    expect(server.closed).toBe(true);
  });

  it('never registers a tool for a disabled server', async () => {
    await manager.add({ name: 'files', command: 'fake', args: [], trust: 'read-only', enabled: false });
    expect(registry.get('mcp.files.read_file')).toBeUndefined();
  });

  it('reports a server that will not start instead of failing the call', async () => {
    const broken = new McpManager({
      store,
      registry,
      bus,
      connect: () => Promise.reject(new Error('spawn failed')),
    });
    const added = await broken.add({ name: 'broken', command: 'nope', args: [], trust: 'normal' });
    expect(added.connected).toBe(false);
    expect(added.error).toBe('spawn failed');
    expect(registry.list()).toHaveLength(0);
  });

  it('forgets the server and its tools when it is removed', async () => {
    const added = await manager.add({ name: 'files', command: 'fake', args: [], trust: 'read-only' });
    const events: string[] = [];
    bus.on('mcp.server.deleted', (payload) => events.push(payload.id));
    await manager.remove(added.id);
    expect(events).toEqual([added.id]);
    expect(manager.list()).toEqual([]);
    expect(registry.get('mcp.files.read_file')).toBeUndefined();
  });

  it('reconnects to a running server without duplicating its tools', async () => {
    const added = await manager.add({ name: 'files', command: 'fake', args: [], trust: 'read-only' });
    const again = await manager.reconnect(added.id);
    expect(again.connected).toBe(true);
    expect(registry.list().filter((tool) => tool.id === 'mcp.files.read_file')).toHaveLength(1);
  });

  it('connects the stored servers on start', async () => {
    store.create({ name: 'files', command: 'fake', args: [], trust: 'read-only' });
    await manager.start();
    expect(manager.list()[0]?.connected).toBe(true);
  });
});

describe('skill server tools', () => {
  const stored = {
    id: 'id',
    name: 'files',
    command: 'fake',
    args: [],
    trust: 'normal' as const,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  it('derives risk from trust, because the tool itself cannot be inspected', () => {
    expect(riskForTrust('read-only')).toBe(RiskLevel.Low);
    expect(riskForTrust('normal')).toBe(RiskLevel.Medium);
    expect(riskForTrust('sensitive')).toBe(RiskLevel.High);
  });

  it('treats only a read-only server as reversible', () => {
    const definition: McpToolDefinition = { name: 'read_file' };
    expect(createMcpTool({ ...stored, trust: 'read-only' }, definition, new FakeServer([])).reversible).toBe(true);
    expect(createMcpTool({ ...stored, trust: 'sensitive' }, definition, new FakeServer([])).reversible).toBe(false);
  });

  it('passes the arguments through and returns the text the server produced', async () => {
    const client = new FakeServer([]);
    const tool = createMcpTool(stored, { name: 'read_file' }, client);
    const result = await tool.execute({ path: 'C:\\work\\a.txt' } as never, { callId: 'call-1' });
    expect(client.calls).toEqual([{ name: 'read_file', arguments: { path: 'C:\\work\\a.txt' } }]);
    expect(result.ok).toBe(true);
  });

  it('surfaces a server-side error as a failed call', async () => {
    const client = new FakeServer([], { isError: true, content: [{ type: 'text', text: 'no such file' }] });
    const tool = createMcpTool(stored, { name: 'read_file' }, client);
    const result = await tool.execute({} as never, { callId: 'call-1' });
    expect(result.ok).toBe(false);
  });

  it('keeps a huge result from filling the context window', async () => {
    const client = new FakeServer([], { content: [{ type: 'text', text: 'x'.repeat(80_000) }] });
    const tool = createMcpTool(stored, { name: 'read_file' }, client);
    const result = await tool.execute({} as never, { callId: 'call-1' });
    expect(result.ok).toBe(true);
    expect((result as { data: { text: string } }).data.text).toHaveLength(20_000);
  });

  it('narrows a JSON Schema down to the shapes the approval dialog can render', () => {
    const schema = toToolInputSchema({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Where to read' },
        depth: { type: 'integer' },
        recursive: { type: ['boolean', 'null'] },
        mode: { type: 'string', enum: ['text', 'binary', 7] },
        names: { type: 'array', items: { type: 'string' } },
        weird: 'not a schema',
      },
      required: ['path', 'missing'],
    });
    expect(schema.properties.path?.type).toBe('string');
    expect(schema.properties.depth?.type).toBe('number');
    expect(schema.properties.recursive?.type).toBe('boolean');
    expect(schema.properties.mode?.enum).toEqual(['text', 'binary']);
    expect(schema.properties.names?.items?.type).toBe('string');
    expect(schema.properties.weird?.type).toBe('string');
    // A required key nobody described would be impossible to fill in.
    expect(schema.required).toEqual(['path']);
  });
});
