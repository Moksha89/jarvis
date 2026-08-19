import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SkillCatalogEntry } from '@jarvis/types';
import { EventBus } from '@jarvis/events';
import { ToolRegistry } from '@jarvis/tools';
import { openDatabase, type JarvisDatabase } from '../db/database.js';
import { McpStore } from '../store/mcp-store.js';
import { McpManager, type McpCallResult, type McpClientLike, type McpToolDefinition } from './mcp-manager.js';
import { SkillInstaller } from './skill-installer.js';
import { SKILL_CATALOG } from './skill-catalog.js';

class FakeServer implements McpClientLike {
  closed = false;

  constructor(private readonly tools: McpToolDefinition[]) {}

  listTools(): Promise<{ tools: readonly McpToolDefinition[] }> {
    return Promise.resolve({ tools: this.tools });
  }

  callTool(): Promise<McpCallResult> {
    return Promise.resolve({ content: [{ type: 'text', text: 'done' }] });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const catalog: readonly SkillCatalogEntry[] = [
  {
    id: 'memory',
    name: 'memory',
    summary: 'Remembers things between conversations.',
    capabilities: ['remember', 'recall'],
    command: 'node',
    args: ['fake-memory.js'],
    package: 'fake-memory@1.0.0',
    trust: 'normal',
  },
  {
    id: 'reasoning',
    name: 'reasoning',
    summary: 'Thinks a problem through in steps.',
    capabilities: ['step by step', 'reason'],
    command: 'node',
    args: ['fake-reasoning.js'],
    trust: 'read-only',
  },
];

describe('SkillInstaller', () => {
  let db: JarvisDatabase;
  let registry: ToolRegistry;
  let manager: McpManager;
  let installer: SkillInstaller;
  let failNext: string | undefined;

  beforeEach(() => {
    db = openDatabase(':memory:');
    registry = new ToolRegistry();
    failNext = undefined;
    manager = new McpManager({
      store: new McpStore(db),
      registry,
      bus: new EventBus(),
      connect: (server) => {
        if (failNext === server.name) return Promise.reject(new Error('the package could not be fetched'));
        return Promise.resolve(new FakeServer([{ name: 'store', description: 'Store a fact.' }]));
      },
    });
    installer = new SkillInstaller({ manager, catalog });
  });

  afterEach(async () => {
    await manager.stop();
    db.close();
  });

  it('matches a described need and ignores the rest of the catalog', () => {
    const matches = installer.find('please remember what I tell you');
    expect(matches.map((match) => match.entry.id)).toEqual(['memory']);
    expect(matches[0]?.installed).toBe(false);
  });

  it('needs the whole phrase for a multi-word capability', () => {
    expect(installer.find('reason about this').map((match) => match.entry.id)).toEqual(['reasoning']);
    expect(installer.find('do it step by step').map((match) => match.entry.id)).toEqual(['reasoning']);
  });

  it('offers nothing when the catalog does not cover the need', () => {
    expect(installer.find('send a fax to the bank')).toEqual([]);
  });

  it('lists the whole catalog when nothing in particular is asked for', () => {
    expect(installer.find('').map((match) => match.entry.id)).toEqual(['memory', 'reasoning']);
  });

  it('will not install anything outside the catalog', async () => {
    await expect(installer.install('arbitrary-command')).rejects.toThrow(/no skill "arbitrary-command"/i);
    expect(manager.list()).toEqual([]);
  });

  it('installs a catalog skill and registers its tools like any other tool', async () => {
    const installed = await installer.install('memory');
    expect(installed.connected).toBe(true);
    expect(installed.toolIds).toEqual(['mcp.memory.store']);
    // The tool is in the ordinary registry, so it is classified, gated and audited.
    expect(registry.get('mcp.memory.store')?.baseRiskLevel).toBe(2);
    expect(manager.list().map((server) => `${server.command} ${server.args.join(' ')}`)).toEqual([
      'node fake-memory.js',
    ]);
  });

  it('marks an installed skill so it is not offered again', async () => {
    await installer.install('memory');
    expect(installer.find('remember this')[0]?.installed).toBe(true);
  });

  it('reconnects a skill it already has instead of adding it twice', async () => {
    const first = await installer.install('memory');
    const second = await installer.install('memory');
    expect(second.serverId).toBe(first.serverId);
    expect(manager.list()).toHaveLength(1);
    expect(second.connected).toBe(true);
  });

  it('switches a skill back on when it was disabled', async () => {
    const first = await installer.install('memory');
    await manager.setEnabled(first.serverId, false);
    const again = await installer.install('memory');
    expect(again.connected).toBe(true);
    expect(manager.list()[0]?.enabled).toBe(true);
  });

  it('reports a skill that could not start, keeping its definition to retry', async () => {
    failNext = 'memory';
    await expect(installer.install('memory')).rejects.toThrow(/did not start/i);
    expect(manager.list()).toHaveLength(1);
    expect(registry.get('mcp.memory.store')).toBeUndefined();
  });
});

describe('the curated catalog', () => {
  it('pins every skill to a version, so an approval covers what will run', () => {
    for (const entry of SKILL_CATALOG) {
      expect(entry.package).toMatch(/@\d/);
      expect(entry.args.join(' ')).toContain(entry.package ?? '');
    }
  });

  it('offers no skill that would read files outside the allowed folders', () => {
    for (const entry of SKILL_CATALOG) {
      expect(entry.package ?? '').not.toContain('server-filesystem');
    }
  });
});
