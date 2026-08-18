import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RiskLevel, type DesktopElement, type DesktopShot, type DesktopWindow, type JarvisTool, type MouseButton } from '@jarvis/types';
import type { DesktopBridge } from './desktop-bridge.js';
import { escapeSendKeys } from './desktop-bridge.js';
import { createDesktopTools } from './desktop.js';

class FakeBridge implements DesktopBridge {
  clicks: { x: number; y: number; button: MouseButton }[] = [];
  typed: string[] = [];
  keys: string[] = [];
  focused: string[] = [];
  elements: DesktopElement[] = [
    { name: 'Save', role: 'Button', automationId: 'btnSave', enabled: true, depth: 2, bounds: { x: 100, y: 200, width: 40, height: 20 } },
    { name: 'Discard', role: 'Button', automationId: 'btnDiscard', enabled: false, depth: 2, bounds: { x: 200, y: 200, width: 40, height: 20 } },
    { name: 'Hidden', role: 'Button', automationId: 'btnHidden', enabled: true, depth: 2 },
  ];

  async listWindows(): Promise<DesktopWindow[]> {
    return [
      {
        handle: '4242',
        title: 'Untitled - Notepad',
        process: 'notepad',
        pid: 7,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        foreground: true,
      },
    ];
  }

  async inspect(query: { maxDepth: number; limit: number }): Promise<DesktopElement[]> {
    return this.elements.slice(0, query.limit);
  }

  async screenshot(options: { path: string }): Promise<DesktopShot> {
    return { path: options.path, width: 800, height: 600, bytes: 1024 };
  }

  async focus(query: { handle?: string; title?: string }): Promise<DesktopWindow> {
    this.focused.push(query.handle ?? query.title ?? '');
    const [window] = await this.listWindows();
    if (!window) throw new Error('unreachable');
    return window;
  }

  async click(options: { x: number; y: number; button: MouseButton }): Promise<void> {
    this.clicks.push(options);
  }

  async typeText(options: { text: string }): Promise<void> {
    this.typed.push(options.text);
  }

  async pressKeys(options: { keys: string }): Promise<void> {
    this.keys.push(options.keys);
  }
}

const CONTEXT = { callId: 'call-1' };

describe('desktop tools', () => {
  let bridge: FakeBridge;
  let workspace: string;
  let control: boolean;
  let tools: Map<string, JarvisTool<never, unknown>>;

  beforeEach(() => {
    bridge = new FakeBridge();
    workspace = mkdtempSync(join(tmpdir(), 'jarvis-shots-'));
    control = true;
    tools = new Map(
      createDesktopTools({ bridge, screenshotDir: workspace, controlEnabled: () => control }).map((tool) => [tool.id, tool]),
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function tool(id: string): JarvisTool<never, unknown> {
    const found = tools.get(id);
    if (!found) throw new Error(`missing tool ${id}`);
    return found;
  }

  function call(id: string, input: unknown) {
    return tool(id).execute(input as never, CONTEXT);
  }

  it('lists windows without any risk', async () => {
    const listing = tool('desktop.windows');
    expect(listing.describe({} as never).riskLevel).toBe(RiskLevel.Safe);
    const result = await call('desktop.windows', {});
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(1);
  });

  it('rates reading a window and capturing the screen above safe', () => {
    expect(tool('desktop.inspect').describe({ title: 'Notepad' } as never).riskLevel).toBe(RiskLevel.Low);
    expect(tool('desktop.screenshot').describe({} as never).riskLevel).toBe(RiskLevel.Low);
  });

  it('rates input as a recoverable change so it needs approval', () => {
    expect(tool('desktop.click').describe({ element: 'Save' } as never).riskLevel).toBe(RiskLevel.Medium);
    expect(tool('desktop.type').describe({ text: 'hello' } as never).riskLevel).toBe(RiskLevel.Medium);
    expect(tool('desktop.keys').describe({ keys: '^s' } as never).riskLevel).toBe(RiskLevel.Medium);
  });

  it('refuses every input tool while desktop control is off', async () => {
    control = false;
    for (const [id, input] of [
      ['desktop.click', { x: 1, y: 2 }],
      ['desktop.type', { text: 'hello' }],
      ['desktop.keys', { keys: '^s' }],
      ['desktop.focus', { title: 'Notepad' }],
    ] as const) {
      const result = await call(id, input);
      expect(result.ok, id).toBe(false);
      expect(result.error, id).toContain('Desktop control is switched off');
    }
    expect(bridge.clicks).toEqual([]);
    expect(bridge.typed).toEqual([]);
    expect(bridge.keys).toEqual([]);
    expect(bridge.focused).toEqual([]);
  });

  it('still reads the screen while desktop control is off', async () => {
    control = false;
    expect((await call('desktop.windows', {})).ok).toBe(true);
    expect((await call('desktop.inspect', { title: 'Notepad' })).ok).toBe(true);
    expect((await call('desktop.screenshot', {})).ok).toBe(true);
  });

  it('clicks the centre of a named element', async () => {
    const result = await call('desktop.click', { element: 'save', title: 'Notepad' });
    expect(result.ok).toBe(true);
    expect(bridge.clicks).toEqual([{ x: 120, y: 210, button: 'left' }]);
  });

  it('refuses to click a disabled or invisible element', async () => {
    const disabled = await call('desktop.click', { element: 'Discard', title: 'Notepad' });
    expect(disabled.ok).toBe(false);
    expect(disabled.error).toContain('disabled');

    const invisible = await call('desktop.click', { element: 'Hidden', title: 'Notepad' });
    expect(invisible.ok).toBe(false);
    expect(invisible.error).toContain('not visible');

    const missing = await call('desktop.click', { element: 'Publish', title: 'Notepad' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('no element called');
    expect(bridge.clicks).toEqual([]);
  });

  it('needs a full coordinate pair when no element is named', async () => {
    const result = await call('desktop.click', { x: 10 });
    expect(result.ok).toBe(false);
    expect(bridge.clicks).toEqual([]);
  });

  it('caps how much text one call can type', async () => {
    const result = await call('desktop.type', { text: 'x'.repeat(2_001) });
    expect(result.ok).toBe(false);
    expect(bridge.typed).toEqual([]);
  });

  it('writes screenshots into the Jarvis folder', async () => {
    const result = await call('desktop.screenshot', { title: 'Notepad' });
    expect(result.ok).toBe(true);
    expect((result.data as DesktopShot).path.startsWith(workspace)).toBe(true);
  });
});

describe('escapeSendKeys', () => {
  it('escapes the characters SendKeys treats as syntax', () => {
    expect(escapeSendKeys('50% (a+b)')).toBe('50{%} {(}a{+}b{)}');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeSendKeys('hello world')).toBe('hello world');
  });
});
