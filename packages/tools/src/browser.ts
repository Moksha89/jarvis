import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserPageInfo, BrowserShot, BrowserSnapshot, JarvisTool } from '@jarvis/types';
import { RiskLevel } from '@jarvis/types';
import type { BrowserBridge } from './browser-bridge.js';
import { PlaywrightBrowserBridge } from './browser-bridge.js';
import { defaultScreenshotDir } from './desktop.js';

const MAX_CHARS = 20_000;
const MAX_LINKS = 200;
const MAX_TEXT_LENGTH = 2_000;

export interface BrowserToolOptions {
  /**
   * Whether Jarvis may act on a page (click, type). Opening and reading pages is
   * always available; acting is opt-in, because a click on a page can spend money
   * or send mail and no folder scope can contain it.
   */
  controlEnabled: () => boolean;
  screenshotDir?: string;
  bridge?: BrowserBridge;
}

export function createBrowserTools(options: BrowserToolOptions): JarvisTool<never, unknown>[] {
  const bridge = options.bridge ?? new PlaywrightBrowserBridge();
  const shots = options.screenshotDir ?? defaultScreenshotDir();
  return [
    createOpenTool(bridge),
    createReadTool(bridge),
    createScreenshotTool(bridge, shots),
    createClickTool(bridge, options.controlEnabled),
    createTypeTool(bridge, options.controlEnabled),
    createCloseTool(bridge),
  ] as JarvisTool<never, unknown>[];
}

function createOpenTool(bridge: BrowserBridge): JarvisTool<{ url: string }, BrowserPageInfo> {
  return {
    id: 'browser.open',
    name: 'Open a page',
    version: '1.0.0',
    category: 'network',
    description: 'Open a web page in the Jarvis browser window. Use browser.read afterwards to see what is on it.',
    baseRiskLevel: RiskLevel.Low,
    reversible: true,
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http or https URL.' } },
      required: ['url'],
    },
    describe: (input) => ({
      summary: `Open ${input.url} in the browser.`,
      target: input.url,
      // Fetching a page reaches the network and reveals the machine's address.
      riskLevel: RiskLevel.Low,
      reversible: true,
    }),
    async execute(input) {
      const url = webUrl(input.url);
      if (!url) {
        return {
          ok: false,
          error: 'Give an absolute http:// or https:// URL. Other schemes, including file://, are not opened.',
          summary: 'Nothing opened.',
        };
      }
      const page = await bridge.open({ url });
      return { ok: true, data: page, summary: `Opened "${page.title}".` };
    },
  };
}

function createReadTool(bridge: BrowserBridge): JarvisTool<{ maxChars?: number }, BrowserSnapshot> {
  return {
    id: 'browser.read',
    name: 'Read the page',
    version: '1.0.0',
    category: 'network',
    description:
      'Read the current page: its visible text, its links, and the buttons and fields that can be clicked or filled in.',
    baseRiskLevel: RiskLevel.Low,
    reversible: true,
    inputSchema: {
      type: 'object',
      properties: { maxChars: { type: 'number', description: 'How much text to return.', default: 6000 } },
      required: [],
    },
    describe: () => ({
      summary: 'Read what is on the open page.',
      riskLevel: RiskLevel.Low,
      reversible: true,
    }),
    async execute(input) {
      const snapshot = await bridge.read({
        maxChars: clampNumber(input.maxChars ?? 6_000, 200, MAX_CHARS),
        maxLinks: MAX_LINKS,
      });
      return {
        ok: true,
        data: snapshot,
        summary: `Read ${String(snapshot.text.length)} characters and ${String(snapshot.links.length)} link(s) from "${snapshot.title}".`,
      };
    },
  };
}

function createScreenshotTool(bridge: BrowserBridge, screenshotDir: string): JarvisTool<{ fullPage?: boolean }, BrowserShot> {
  return {
    id: 'browser.screenshot',
    name: 'Capture the page',
    version: '1.0.0',
    category: 'network',
    description: 'Save a PNG of the open page into the Jarvis screenshots folder.',
    baseRiskLevel: RiskLevel.Low,
    reversible: true,
    inputSchema: {
      type: 'object',
      properties: { fullPage: { type: 'boolean', description: 'Capture the whole scrollable page.', default: false } },
      required: [],
    },
    describe: () => ({
      // The capture writes a file, so this is never Safe.
      summary: 'Save a picture of the open page.',
      riskLevel: RiskLevel.Low,
      reversible: true,
    }),
    async execute(input) {
      mkdirSync(screenshotDir, { recursive: true });
      const path = join(screenshotDir, `page-${String(Date.now())}.png`);
      const shot = await bridge.screenshot({ path, fullPage: input.fullPage ?? false });
      return { ok: true, data: shot, summary: `Saved the page to ${shot.path}.` };
    },
  };
}

function createClickTool(
  bridge: BrowserBridge,
  controlEnabled: () => boolean,
): JarvisTool<{ target: string }, BrowserPageInfo> {
  return {
    id: 'browser.click',
    name: 'Click on the page',
    version: '1.0.0',
    category: 'network',
    description:
      'Click a button, link or field on the open page by its visible name, for example "Sign in". A CSS selector also works.',
    baseRiskLevel: RiskLevel.Medium,
    reversible: false,
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Visible name, label or CSS selector.' } },
      required: ['target'],
    },
    describe: (input) => ({
      // A click can buy, send or delete something on the far side, so it is a
      // recoverable-at-best change rather than an observation.
      summary: `Click "${input.target}" on the open page.`,
      target: input.target,
      riskLevel: RiskLevel.Medium,
      reversible: false,
    }),
    async execute(input) {
      const refusal = refuseWhenDisabled(controlEnabled);
      if (refusal) return refusal;
      if (input.target.trim().length === 0) {
        return { ok: false, error: 'Say what to click.', summary: 'Nothing clicked.' };
      }
      const page = await bridge.click({ target: input.target.trim() });
      return { ok: true, data: page, summary: `Clicked "${input.target}"; now on "${page.title}".` };
    },
  };
}

function createTypeTool(
  bridge: BrowserBridge,
  controlEnabled: () => boolean,
): JarvisTool<{ text: string; target?: string; submit?: boolean }, BrowserPageInfo> {
  return {
    id: 'browser.type',
    name: 'Fill in a field',
    version: '1.0.0',
    category: 'network',
    description: 'Type text into a named field on the open page, optionally pressing Enter afterwards.',
    baseRiskLevel: RiskLevel.Medium,
    reversible: false,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type.' },
        target: { type: 'string', description: 'Field name, label or placeholder. Omit to type where the cursor is.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.', default: false },
      },
      required: ['text'],
    },
    describe: (input) => ({
      summary:
        input.target === undefined
          ? `Type "${truncate(input.text)}" into the open page.`
          : `Type "${truncate(input.text)}" into "${input.target}".`,
      target: input.target ?? truncate(input.text),
      riskLevel: RiskLevel.Medium,
      reversible: false,
    }),
    async execute(input) {
      const refusal = refuseWhenDisabled(controlEnabled);
      if (refusal) return refusal;
      if (input.text.length === 0) return { ok: false, error: 'There is no text to type.', summary: 'Nothing typed.' };
      if (input.text.length > MAX_TEXT_LENGTH) {
        return {
          ok: false,
          error: `That is ${String(input.text.length)} characters; type at most ${String(MAX_TEXT_LENGTH)} at a time.`,
          summary: 'Nothing typed.',
        };
      }
      const page = await bridge.type({
        target: input.target?.trim() === '' ? undefined : input.target?.trim(),
        text: input.text,
        submit: input.submit ?? false,
      });
      return { ok: true, data: page, summary: `Typed into "${page.title}".` };
    },
  };
}

function createCloseTool(bridge: BrowserBridge): JarvisTool<Record<string, never>, { closed: boolean }> {
  return {
    id: 'browser.close',
    name: 'Close the browser',
    version: '1.0.0',
    category: 'network',
    description: 'Close the Jarvis browser window and end the browsing session.',
    baseRiskLevel: RiskLevel.Low,
    reversible: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    describe: () => ({ summary: 'Close the browser window.', riskLevel: RiskLevel.Low, reversible: true }),
    async execute() {
      await bridge.close();
      return { ok: true, data: { closed: true }, summary: 'Closed the browser.' };
    },
  };
}

function refuseWhenDisabled(controlEnabled: () => boolean): { ok: false; error: string; summary: string } | undefined {
  if (!controlEnabled()) {
    return {
      ok: false,
      error: 'Browser control is switched off. Turn it on in Settings to let Jarvis click and fill in pages.',
      summary: 'Refused: browser control is off.',
    };
  }
  return undefined;
}

/**
 * Only http(s): `file://` would turn the browser into a way around the path scopes.
 * Stricter than the bridge's `isWebUrl`, which also tolerates the blank page the
 * session may sit on — nobody gets to *ask* for a page that is not on the web.
 * The bridge re-checks wherever the session ends up, because a link or a submitted
 * form can navigate off the web on its own.
 */
function webUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}
