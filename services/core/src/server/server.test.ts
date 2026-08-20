import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeSource, KnowledgeStats } from '@jarvis/types';
import { createServer, type ServerHandle } from './server.js';

/**
 * Core has no authentication, so the origin check is the only thing standing between a
 * web page the user happens to visit and the tool loop. These tests pin that gate.
 */
describe('Core HTTP origin gate', () => {
  let handle: ServerHandle;
  let base: string;

  beforeEach(async () => {
    handle = await createServer({
      databaseFile: ':memory:',
      enableAgent: false,
      enableScheduler: false,
      port: 0,
    });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.close();
  });

  it('serves a native client that sends no Origin at all', async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves the Tauri webview and echoes its origin back', async () => {
    for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:1420']) {
      const response = await fetch(`${base}/api/health`, { headers: { origin } });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('vary')).toBe('origin');
    }
  });

  it('refuses a random web page, preflight included', async () => {
    const origin = 'https://evil.example';
    const response = await fetch(`${base}/api/health`, { headers: { origin } });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await fetch(`${base}/api/chat`, { method: 'OPTIONS', headers: { origin } });
    expect(preflight.status).toBe(403);
  });

  it('honours an explicit allow-list over the defaults', async () => {
    const custom = await createServer({
      databaseFile: ':memory:',
      enableAgent: false,
      enableScheduler: false,
      port: 0,
      allowedOrigins: ['http://localhost:5173'],
    });
    try {
      const allowed = await fetch(`http://127.0.0.1:${custom.port}/api/health`, {
        headers: { origin: 'http://localhost:5173' },
      });
      const denied = await fetch(`http://127.0.0.1:${custom.port}/api/health`, {
        headers: { origin: 'tauri://localhost' },
      });
      expect(allowed.status).toBe(200);
      expect(denied.status).toBe(403);
    } finally {
      await custom.close();
    }
  });
});

describe('Core knowledge routes', () => {
  let handle: ServerHandle;
  let base: string;
  let workspace: string;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'jarvis-routes-'));
    writeFileSync(join(workspace, 'notes.md'), 'budget notes', 'utf8');
    handle = await createServer({
      databaseFile: ':memory:',
      enableAgent: false,
      enableScheduler: false,
      port: 0,
    });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.close();
  });

  it('starts with no sources and reports why retrieval is not ready', async () => {
    const sources = (await (await fetch(`${base}/api/knowledge/sources`)).json()) as KnowledgeSource[];
    expect(sources).toEqual([]);

    const stats = (await (await fetch(`${base}/api/knowledge/stats`)).json()) as KnowledgeStats;
    // No Ollama in the test environment, so the embedding model can never be ready.
    expect(stats).toMatchObject({ sources: 0, documents: 0, ready: false });
  });

  it('rejects a source outside the permitted scopes with the reason', async () => {
    const response = await fetch(`${base}/api/knowledge/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: workspace }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/not permitted/i);
  });

  it('404s an unknown source instead of pretending it worked', async () => {
    const response = await fetch(`${base}/api/knowledge/sources/nope/reindex`, { method: 'POST' });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('serves the skill catalog and narrows it to a described need', async () => {
    const all = (await (await fetch(`${base}/api/skills/catalog`)).json()) as { entry: { id: string } }[];
    expect(all.length).toBeGreaterThan(0);

    const matched = (await (
      await fetch(`${base}/api/skills/catalog?need=${encodeURIComponent('remember what I said')}`)
    ).json()) as { entry: { id: string } }[];
    expect(matched.map((match) => match.entry.id)).toEqual(['memory']);
  });

  it('says what is wrong with a malformed planning request', async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    for (const [path, body, expected] of [
      ['/api/plan', {}, /"goal" must be text/i],
      ['/api/do', { goal: 7 }, /"goal" must be text/i],
      ['/api/plan', { goal: 'tidy up', model: 3 }, /"model" must be text/i],
      ['/api/plan/run', { goal: 'tidy up' }, /"steps" must be a list/i],
      ['/api/plan/run', 'not a plan', /must be an object/i],
    ] as const) {
      const response = await post(path, body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error?: string }).error).toMatch(expected);
    }
  });

  it('requires a query on search', async () => {
    const response = await fetch(`${base}/api/knowledge/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });
});
