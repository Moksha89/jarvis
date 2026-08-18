import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RiskLevel, type BrowserPageInfo, type BrowserShot, type BrowserSnapshot, type JarvisTool } from '@jarvis/types';
import type { BrowserBridge } from './browser-bridge.js';
import { createBrowserTools } from './browser.js';

class FakeBridge implements BrowserBridge {
  opened: string[] = [];
  clicked: string[] = [];
  typed: { target?: string; text: string; submit: boolean }[] = [];
  closed = false;
  page: BrowserPageInfo = { url: 'https://example.test/', title: 'Example' };

  open(options: { url: string }): Promise<BrowserPageInfo> {
    this.opened.push(options.url);
    return Promise.resolve(this.page);
  }
  read(options: { maxChars: number; maxLinks: number }): Promise<BrowserSnapshot> {
    return Promise.resolve({
      ...this.page,
      text: 'x'.repeat(options.maxChars),
      truncated: true,
      links: [{ text: 'Docs', href: 'https://example.test/docs' }],
      controls: [{ role: 'button', name: 'Sign in' }],
    });
  }
  click(options: { target: string }): Promise<BrowserPageInfo> {
    this.clicked.push(options.target);
    return Promise.resolve(this.page);
  }
  type(options: { target?: string; text: string; submit: boolean }): Promise<BrowserPageInfo> {
    this.typed.push(options);
    return Promise.resolve(this.page);
  }
  screenshot(options: { path: string; fullPage: boolean }): Promise<BrowserShot> {
    writeFileSync(options.path, 'png', 'utf8');
    return Promise.resolve({ path: options.path, bytes: 3 });
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

describe('browser tools', () => {
  let bridge: FakeBridge;
  let workspace: string;
  let controlEnabled: boolean;

  const toolsFor = (): Map<string, JarvisTool<never, unknown>> =>
    new Map(
      createBrowserTools({
        bridge,
        screenshotDir: workspace,
        controlEnabled: () => controlEnabled,
      }).map((tool) => [tool.id, tool]),
    );

  const call = async (id: string, input: unknown) => {
    const tool = toolsFor().get(id);
    if (!tool) throw new Error(`No tool ${id}`);
    return await tool.execute(input as never, { callId: 'test' });
  };

  beforeEach(() => {
    bridge = new FakeBridge();
    workspace = mkdtempSync(join(tmpdir(), 'jarvis-browser-'));
    controlEnabled = true;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('classifies reading below acting', () => {
    const tools = toolsFor();
    expect(tools.get('browser.open')?.baseRiskLevel).toBe(RiskLevel.Low);
    expect(tools.get('browser.read')?.baseRiskLevel).toBe(RiskLevel.Low);
    expect(tools.get('browser.click')?.baseRiskLevel).toBe(RiskLevel.Medium);
    expect(tools.get('browser.type')?.baseRiskLevel).toBe(RiskLevel.Medium);
  });

  it('opens an http url', async () => {
    const result = await call('browser.open', { url: 'https://example.test/start' });
    expect(result.ok).toBe(true);
    expect(bridge.opened).toEqual(['https://example.test/start']);
  });

  it('refuses schemes other than http and https', async () => {
    for (const url of ['file:///C:/Users/me/secrets.txt', 'javascript:alert(1)', 'not a url']) {
      const result = await call('browser.open', { url });
      expect(result.ok).toBe(false);
    }
    expect(bridge.opened).toEqual([]);
  });

  it('caps how much page text it returns', async () => {
    const result = await call('browser.read', { maxChars: 10_000_000 });
    const snapshot = result.data as BrowserSnapshot;
    expect(snapshot.text.length).toBe(20_000);
  });

  it('reads pages while control is off but refuses to act', async () => {
    controlEnabled = false;

    expect((await call('browser.open', { url: 'https://example.test/' })).ok).toBe(true);
    expect((await call('browser.read', {})).ok).toBe(true);

    const click = await call('browser.click', { target: 'Sign in' });
    const type = await call('browser.type', { text: 'hello' });
    expect(click.ok).toBe(false);
    expect(type.ok).toBe(false);
    expect(bridge.clicked).toEqual([]);
    expect(bridge.typed).toEqual([]);
  });

  it('clicks and fills by visible name', async () => {
    await call('browser.click', { target: '  Sign in  ' });
    await call('browser.type', { target: 'Search', text: 'jarvis', submit: true });
    expect(bridge.clicked).toEqual(['Sign in']);
    expect(bridge.typed).toEqual([{ target: 'Search', text: 'jarvis', submit: true }]);
  });

  it('types where the cursor is when no field is named', async () => {
    await call('browser.type', { text: 'jarvis' });
    expect(bridge.typed).toEqual([{ target: undefined, text: 'jarvis', submit: false }]);
  });

  it('refuses more text than a field should take at once', async () => {
    const result = await call('browser.type', { text: 'x'.repeat(2_001) });
    expect(result.ok).toBe(false);
    expect(bridge.typed).toEqual([]);
  });

  it('writes captures into the screenshot folder and closes the session', async () => {
    const shot = await call('browser.screenshot', { fullPage: true });
    expect((shot.data as BrowserShot).path.startsWith(workspace)).toBe(true);

    await call('browser.close', {});
    expect(bridge.closed).toBe(true);
  });
});
