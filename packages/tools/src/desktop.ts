import { mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { DesktopElement, DesktopShot, DesktopWindow, JarvisTool, MouseButton } from '@jarvis/types';
import { RiskLevel } from '@jarvis/types';
import type { DesktopBridge } from './desktop-bridge.js';
import { WindowsDesktopBridge } from './desktop-bridge.js';

const MAX_ELEMENTS = 400;
const MAX_TEXT_LENGTH = 2_000;

export interface DesktopToolOptions {
  /**
   * Whether synthetic input (clicking, typing, focusing) is allowed. Reading the
   * screen is always available; driving it is opt-in because a click lands
   * wherever it lands, outside any folder scope.
   */
  controlEnabled: () => boolean;
  /** Folder screenshots are written to. Defaults to the per-user Jarvis folder. */
  screenshotDir?: string;
  bridge?: DesktopBridge;
}

interface WindowSelector {
  handle?: string;
  title?: string;
}

export function createDesktopTools(options: DesktopToolOptions): JarvisTool<never, unknown>[] {
  const bridge = options.bridge ?? new WindowsDesktopBridge();
  const shots = options.screenshotDir ?? defaultScreenshotDir();
  return [
    createListWindowsTool(bridge),
    createInspectTool(bridge),
    createScreenshotTool(bridge, shots),
    createFocusTool(bridge, options.controlEnabled),
    createClickTool(bridge, options.controlEnabled),
    createTypeTool(bridge, options.controlEnabled),
    createKeysTool(bridge, options.controlEnabled),
  ] as JarvisTool<never, unknown>[];
}

function createListWindowsTool(bridge: DesktopBridge): JarvisTool<Record<string, never>, DesktopWindow[]> {
  return {
    id: 'desktop.windows',
    name: 'List open windows',
    version: '1.0.0',
    category: 'system',
    description: 'List the visible top-level windows with their titles, owning process and screen position.',
    baseRiskLevel: RiskLevel.Safe,
    reversible: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    describe: () => ({
      summary: 'Look at which windows are open.',
      riskLevel: RiskLevel.Safe,
      reversible: true,
    }),
    async execute() {
      const windows = await bridge.listWindows();
      return { ok: true, data: windows, summary: `Found ${windows.length} open window(s).` };
    },
  };
}

function createInspectTool(
  bridge: DesktopBridge,
): JarvisTool<WindowSelector & { maxDepth?: number; limit?: number }, DesktopElement[]> {
  return {
    id: 'desktop.inspect',
    name: 'Read a window',
    version: '1.0.0',
    category: 'system',
    description:
      'Read the accessibility tree of one window: the buttons, fields and text it exposes, with their positions. Use this to find what to click instead of guessing coordinates.',
    baseRiskLevel: RiskLevel.Low,
    reversible: true,
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Window handle from desktop.windows.' },
        title: { type: 'string', description: 'Part of the window title, if the handle is unknown.' },
        maxDepth: { type: 'number', description: 'How deep to walk the tree.', default: 6 },
        limit: { type: 'number', description: 'Maximum number of elements to return.', default: 120 },
      },
      required: [],
    },
    describe: (input) => ({
      summary: `Read the contents of the window ${describeSelector(input)}.`,
      target: input.handle ?? input.title,
      // Reading a window can expose whatever is on screen, including another app's data.
      riskLevel: RiskLevel.Low,
      reversible: true,
    }),
    async execute(input) {
      const elements = await bridge.inspect({
        handle: input.handle,
        title: input.title,
        maxDepth: clampNumber(input.maxDepth ?? 6, 1, 12),
        limit: clampNumber(input.limit ?? 120, 1, MAX_ELEMENTS),
      });
      return { ok: true, data: elements, summary: `Read ${elements.length} element(s) from the window.` };
    },
  };
}

function createScreenshotTool(bridge: DesktopBridge, screenshotDir: string): JarvisTool<WindowSelector, DesktopShot> {
  return {
    id: 'desktop.screenshot',
    name: 'Take a screenshot',
    version: '1.0.0',
    category: 'system',
    description: 'Capture the whole screen, or one window, to a PNG file inside the Jarvis screenshots folder.',
    baseRiskLevel: RiskLevel.Low,
    reversible: true,
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Capture only this window.' },
        title: { type: 'string', description: 'Capture only the window whose title contains this text.' },
      },
      required: [],
    },
    describe: (input) => ({
      summary:
        input.handle === undefined && input.title === undefined
          ? 'Take a picture of the whole screen.'
          : `Take a picture of the window ${describeSelector(input)}.`,
      target: input.handle ?? input.title,
      // A screenshot copies whatever is on screen into a file, so it is never Safe.
      riskLevel: RiskLevel.Low,
      reversible: true,
    }),
    async execute(input) {
      mkdirSync(screenshotDir, { recursive: true });
      const path = join(screenshotDir, `shot-${Date.now()}.png`);
      const shot = await bridge.screenshot({ handle: input.handle, title: input.title, path });
      return { ok: true, data: shot, summary: `Saved a ${shot.width}x${shot.height} screenshot to ${shot.path}.` };
    },
  };
}

function createFocusTool(bridge: DesktopBridge, controlEnabled: () => boolean): JarvisTool<WindowSelector, DesktopWindow> {
  return {
    id: 'desktop.focus',
    name: 'Bring a window to the front',
    version: '1.0.0',
    category: 'system',
    description: 'Restore and focus a window so the next click or keystroke goes to it.',
    baseRiskLevel: RiskLevel.Low,
    reversible: true,
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Window handle from desktop.windows.' },
        title: { type: 'string', description: 'Part of the window title.' },
      },
      required: [],
    },
    describe: (input) => ({
      summary: `Bring the window ${describeSelector(input)} to the front.`,
      target: input.handle ?? input.title,
      riskLevel: RiskLevel.Low,
      reversible: true,
    }),
    async execute(input) {
      const refusal = refuseWhenDisabled(controlEnabled);
      if (refusal) return refusal;
      const window = await bridge.focus({ handle: input.handle, title: input.title });
      return { ok: true, data: window, summary: `Focused "${window.title}".` };
    },
  };
}

interface ClickInput extends WindowSelector {
  x?: number;
  y?: number;
  element?: string;
  button?: MouseButton;
}

function createClickTool(
  bridge: DesktopBridge,
  controlEnabled: () => boolean,
): JarvisTool<ClickInput, { x: number; y: number; button: MouseButton; element?: string }> {
  return {
    id: 'desktop.click',
    name: 'Click on screen',
    version: '1.0.0',
    category: 'system',
    description:
      'Click a named element inside a window, or a screen coordinate. Naming an element is safer: its position is read from the accessibility tree at click time.',
    baseRiskLevel: RiskLevel.Medium,
    reversible: false,
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Name or automation id of the element to click.' },
        handle: { type: 'string', description: 'Window the element belongs to.' },
        title: { type: 'string', description: 'Part of the title of the window the element belongs to.' },
        x: { type: 'number', description: 'Screen x coordinate, when no element is named.' },
        y: { type: 'number', description: 'Screen y coordinate, when no element is named.' },
        button: { type: 'string', description: 'Which click to send.', enum: ['left', 'right', 'double'], default: 'left' },
      },
      required: [],
    },
    describe: (input) => ({
      summary:
        input.element !== undefined
          ? `${clickLabel(input.button)} "${input.element}" in the window ${describeSelector(input)}.`
          : `${clickLabel(input.button)} the screen at ${String(input.x)}, ${String(input.y)}.`,
      target: input.element ?? `${String(input.x)},${String(input.y)}`,
      // A click acts on whatever is under it, so it is treated as a recoverable
      // change to the machine rather than an observation.
      riskLevel: RiskLevel.Medium,
      reversible: false,
    }),
    async execute(input) {
      const refusal = refuseWhenDisabled(controlEnabled);
      if (refusal) return refusal;
      const button = input.button ?? 'left';

      if (input.element !== undefined) {
        const elements = await bridge.inspect({
          handle: input.handle,
          title: input.title,
          maxDepth: 12,
          limit: MAX_ELEMENTS,
        });
        const match = findElement(elements, input.element);
        if (!match) {
          return { ok: false, error: `That window has no element called "${input.element}".`, summary: 'Nothing to click.' };
        }
        if (!match.enabled) {
          return { ok: false, error: `"${match.name}" is disabled right now.`, summary: 'Nothing to click.' };
        }
        const bounds = match.bounds;
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
          return { ok: false, error: `"${match.name}" is not visible on screen.`, summary: 'Nothing to click.' };
        }
        const x = Math.round(bounds.x + bounds.width / 2);
        const y = Math.round(bounds.y + bounds.height / 2);
        await bridge.click({ x, y, button });
        return { ok: true, data: { x, y, button, element: match.name }, summary: `Clicked "${match.name}".` };
      }

      if (typeof input.x !== 'number' || typeof input.y !== 'number') {
        return { ok: false, error: 'Give either an element name or both x and y.', summary: 'Nothing to click.' };
      }
      await bridge.click({ x: input.x, y: input.y, button });
      return {
        ok: true,
        data: { x: input.x, y: input.y, button },
        summary: `Clicked at ${String(input.x)}, ${String(input.y)}.`,
      };
    },
  };
}

function createTypeTool(
  bridge: DesktopBridge,
  controlEnabled: () => boolean,
): JarvisTool<{ text: string }, { characters: number }> {
  return {
    id: 'desktop.type',
    name: 'Type text',
    version: '1.0.0',
    category: 'system',
    description: 'Type literal text into whichever window has focus. Focus the intended window first.',
    baseRiskLevel: RiskLevel.Medium,
    reversible: false,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to type.' } },
      required: ['text'],
    },
    describe: (input) => ({
      summary: `Type "${truncate(input.text)}" into the focused window.`,
      target: truncate(input.text),
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
      await bridge.typeText({ text: input.text });
      return { ok: true, data: { characters: input.text.length }, summary: `Typed ${String(input.text.length)} character(s).` };
    },
  };
}

function createKeysTool(
  bridge: DesktopBridge,
  controlEnabled: () => boolean,
): JarvisTool<{ keys: string }, { keys: string }> {
  return {
    id: 'desktop.keys',
    name: 'Press keys',
    version: '1.0.0',
    category: 'system',
    description:
      'Send a key combination to the focused window using SendKeys notation, for example "^s" for Ctrl+S or "{ENTER}".',
    baseRiskLevel: RiskLevel.Medium,
    reversible: false,
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string', description: 'Keys in SendKeys notation.' } },
      required: ['keys'],
    },
    describe: (input) => ({
      summary: `Press ${input.keys} in the focused window.`,
      target: input.keys,
      riskLevel: RiskLevel.Medium,
      reversible: false,
    }),
    async execute(input) {
      const refusal = refuseWhenDisabled(controlEnabled);
      if (refusal) return refusal;
      if (input.keys.length === 0 || input.keys.length > 100) {
        return { ok: false, error: 'Give between 1 and 100 characters of SendKeys notation.', summary: 'No keys sent.' };
      }
      await bridge.pressKeys({ keys: input.keys });
      return { ok: true, data: { keys: input.keys }, summary: `Pressed ${input.keys}.` };
    },
  };
}

function refuseWhenDisabled(controlEnabled: () => boolean): { ok: false; error: string; summary: string } | undefined {
  if (!controlEnabled()) {
    return {
      ok: false,
      error: 'Desktop control is switched off. Turn it on in Settings to let Jarvis click and type.',
      summary: 'Refused: desktop control is off.',
    };
  }
  return undefined;
}

/** Prefers an exact name or automation id, then a case-insensitive contains. */
function findElement(elements: readonly DesktopElement[], wanted: string): DesktopElement | undefined {
  const needle = wanted.trim().toLowerCase();
  return (
    elements.find((element) => element.name.toLowerCase() === needle || element.automationId.toLowerCase() === needle) ??
    elements.find((element) => element.name.toLowerCase().includes(needle))
  );
}

function describeSelector(selector: WindowSelector): string {
  if (selector.handle !== undefined) return `with handle ${selector.handle}`;
  if (selector.title !== undefined) return `titled like "${selector.title}"`;
  return 'in focus';
}

function clickLabel(button: MouseButton | undefined): string {
  if (button === 'right') return 'Right-click';
  if (button === 'double') return 'Double-click';
  return 'Click';
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

export function defaultScreenshotDir(): string {
  const base =
    platform() === 'win32'
      ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : join(homedir(), '.local', 'share');
  return join(base, 'Jarvis', 'screenshots');
}
