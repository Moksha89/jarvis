import { statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { BrowserPageInfo, BrowserShot, BrowserSnapshot } from '@jarvis/types';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';

/** Everything the browser tools need, kept behind an interface so they can be tested. */
export interface BrowserBridge {
  open(options: { url: string }): Promise<BrowserPageInfo>;
  read(options: { maxChars: number; maxLinks: number }): Promise<BrowserSnapshot>;
  click(options: { target: string }): Promise<BrowserPageInfo>;
  type(options: { target?: string; text: string; submit: boolean }): Promise<BrowserPageInfo>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<BrowserShot>;
  close(): Promise<void>;
}

/**
 * The handful of page-side members the read script touches. They are declared
 * here rather than pulling the whole DOM library into a package that otherwise
 * runs on Node, where a stray `document` would be a bug.
 */
interface PageElement {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly href?: string;
  getAttribute(name: string): string | null;
}

interface PageDocument {
  readonly body: { readonly innerText: string } | null;
  querySelectorAll(selector: string): readonly PageElement[];
}

declare const document: PageDocument;

const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

/** Channels tried in order, so an installed browser is reused before a bundled one. */
const CHANNELS = ['msedge', 'chrome'] as const;

/**
 * Drives a visible Chromium-family browser through Playwright.
 *
 * It runs in its own profile rather than the user's, so an automated session
 * cannot reach the cookies and saved passwords of their everyday browsing, and
 * it stays headed: the user can watch what Jarvis does and take over.
 */
export class PlaywrightBrowserBridge implements BrowserBridge {
  private context?: BrowserContext;
  private page?: Page;

  constructor(private readonly profileDir: string = defaultProfileDir()) {}

  async open(options: { url: string }): Promise<BrowserPageInfo> {
    const page = await this.livePage();
    await page.goto(options.url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    return await info(page);
  }

  async read(options: { maxChars: number; maxLinks: number }): Promise<BrowserSnapshot> {
    const page = await this.livePage();
    const harvest = await page.evaluate(
      ({ maxChars, maxLinks }) => {
        const text = document.body?.innerText ?? '';
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map((node) => ({
            text: (node.textContent ?? '').trim().slice(0, 120),
            href: node.getAttribute('href') ?? '',
          }))
          .filter((link) => link.text.length > 0)
          .slice(0, maxLinks);
        const controls = Array.from(
          document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="link"]'),
        )
          .map((node) => {
            const role = node.getAttribute('role') ?? node.tagName.toLowerCase();
            const name = (
              node.getAttribute('aria-label') ??
              node.getAttribute('placeholder') ??
              node.getAttribute('name') ??
              node.textContent ??
              ''
            )
              .trim()
              .slice(0, 120);
            return { role, name };
          })
          .filter((control) => control.name.length > 0)
          .slice(0, maxLinks);
        return { text: text.slice(0, maxChars), truncated: text.length > maxChars, links, controls };
      },
      { maxChars: options.maxChars, maxLinks: options.maxLinks },
    );
    const base = page.url();
    return {
      ...(await info(page)),
      ...harvest,
      links: harvest.links.map((link) => ({ ...link, href: absolute(link.href, base) })),
    };
  }

  async click(options: { target: string }): Promise<BrowserPageInfo> {
    const page = await this.livePage();
    const locator = await this.resolve(page, options.target);
    await locator.click({ timeout: ACTION_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
    return await info(page);
  }

  async type(options: { target?: string; text: string; submit: boolean }): Promise<BrowserPageInfo> {
    const page = await this.livePage();
    if (options.target === undefined) {
      await page.keyboard.type(options.text, { delay: 15 });
    } else {
      const locator = await this.resolve(page, options.target);
      await locator.fill(options.text, { timeout: ACTION_TIMEOUT_MS });
    }
    if (options.submit) {
      await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
    }
    return await info(page);
  }

  async screenshot(options: { path: string; fullPage: boolean }): Promise<BrowserShot> {
    const page = await this.livePage();
    await page.screenshot({ path: options.path, fullPage: options.fullPage });
    return { path: options.path, bytes: statSync(options.path).size };
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    await context?.close();
  }

  /** The one page Jarvis works in, launching the browser on first use. */
  private async livePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.context) this.context = await this.launch();
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    return this.page;
  }

  private async launch(): Promise<BrowserContext> {
    const failures: string[] = [];
    for (const channel of [...CHANNELS, undefined]) {
      try {
        return await chromium.launchPersistentContext(this.profileDir, {
          channel,
          headless: false,
          viewport: null,
          args: ['--start-maximized'],
        });
      } catch (error) {
        failures.push(`${channel ?? 'bundled chromium'}: ${(error as Error).message}`);
      }
    }
    throw new Error(`No browser could be started. Tried ${failures.join('; ')}`);
  }

  /**
   * Finds what the caller meant by a plain-language target: an accessible name
   * first, then placeholder or label text, then visible text, and only last a raw
   * CSS selector — so a model can say "Search" instead of guessing at the DOM.
   */
  private async resolve(page: Page, target: string): Promise<Locator> {
    const candidates: Locator[] = [
      page.getByRole('button', { name: target }),
      page.getByRole('link', { name: target }),
      page.getByRole('textbox', { name: target }),
      page.getByPlaceholder(target),
      page.getByLabel(target),
      page.getByText(target, { exact: false }),
    ];
    if (looksLikeSelector(target)) candidates.push(page.locator(target));

    for (const candidate of candidates) {
      const found = candidate.first();
      if ((await candidate.count()) > 0 && (await found.isVisible())) return found;
    }
    throw new Error(`Nothing called "${target}" is visible on ${page.url()}.`);
  }
}

async function info(page: Page): Promise<BrowserPageInfo> {
  return { url: page.url(), title: await page.title() };
}

/** Page hrefs are often relative, and a caller needs a link it can open as it stands. */
function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function looksLikeSelector(target: string): boolean {
  return /^[#.]/.test(target) || /^[a-z]+[.#[]/.test(target);
}

export function defaultProfileDir(): string {
  const base =
    platform() === 'win32'
      ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : join(homedir(), '.local', 'share');
  return join(base, 'Jarvis', 'browser-profile');
}
