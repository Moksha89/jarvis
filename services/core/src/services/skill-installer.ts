import type { InstalledSkill, McpServer, SkillCatalogEntry, SkillMatch } from '@jarvis/types';
import { MCP_LIMITS, SKILL_LIMITS } from '@jarvis/types';
import type { McpManager } from './mcp-manager.js';
import { SKILL_CATALOG } from './skill-catalog.js';

export interface SkillInstallerOptions {
  manager: McpManager;
  /** Overridable so tests need not spawn the real packages. */
  catalog?: readonly SkillCatalogEntry[];
}

/**
 * Lets Jarvis give itself a capability it does not have, without letting a model decide
 * what runs: it may only pick an entry out of the curated catalog, and the pick still
 * goes through the ordinary tool gate, so the first spawn of a server is approved and
 * audited like any other high-risk action.
 */
export class SkillInstaller {
  private readonly catalog: readonly SkillCatalogEntry[];

  constructor(private readonly options: SkillInstallerOptions) {
    this.catalog = options.catalog ?? SKILL_CATALOG;
  }

  entries(): readonly SkillCatalogEntry[] {
    return this.catalog;
  }

  /** Matches for a described need, or the whole catalog when nothing in particular is asked for. */
  find(need: string): SkillMatch[] {
    const words = wordsOf(need.slice(0, SKILL_LIMITS.maxNeedChars));
    const installedNames = new Set(this.options.manager.list().map((server) => server.name));
    return this.catalog
      .map((entry) => ({ entry, score: scoreEntry(entry, words), installed: installedNames.has(entry.name) }))
      .filter((match) => words.size === 0 || match.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, SKILL_LIMITS.maxMatches);
  }

  /**
   * Adds a catalog skill and connects it. A skill that is already there is reconnected
   * instead of added twice, so a request repeated in a later conversation is harmless.
   */
  async install(skillId: string): Promise<InstalledSkill> {
    const entry = this.catalog.find((candidate) => candidate.id === skillId);
    if (!entry) {
      const known = this.catalog.map((candidate) => candidate.id).join(', ');
      throw new Error(`No skill "${skillId}" in the catalog. Jarvis can add: ${known}.`);
    }
    const existing = this.options.manager.list().find((server) => server.name === entry.name);
    if (existing) return this.describe(await this.reuse(existing));
    if (this.options.manager.list().length >= MCP_LIMITS.maxServers) {
      throw new Error(`Jarvis already runs ${String(MCP_LIMITS.maxServers)} skill servers. Remove one first.`);
    }
    const server = await this.options.manager.add({
      name: entry.name,
      command: entry.command,
      args: entry.args,
      trust: entry.trust,
    });
    if (!server.connected) {
      // The definition is kept: the usual cause is a slow first package download, and
      // the Skills page can reconnect it without asking for approval again.
      throw new Error(
        `The ${entry.name} skill was added but did not start${server.error ? `: ${server.error}` : '.'} Reconnect it from the Skills page to try again.`,
      );
    }
    return this.describe(server);
  }

  private async reuse(server: McpServer): Promise<McpServer> {
    if (!server.enabled) return await this.options.manager.setEnabled(server.id, true);
    return server.connected ? server : await this.options.manager.reconnect(server.id);
  }

  private describe(server: McpServer): InstalledSkill {
    return {
      serverId: server.id,
      name: server.name,
      connected: server.connected,
      toolIds: server.tools.map((tool) => tool.id),
      error: server.error,
    };
  }
}

function scoreEntry(entry: SkillCatalogEntry, words: Set<string>): number {
  let score = 0;
  if (words.has(entry.id) || words.has(entry.name)) score += 3;
  for (const capability of entry.capabilities) {
    const parts = wordsOf(capability);
    // A multi-word capability counts only when the whole phrase is asked for, so
    // "plan carefully" does not match every mention of a plan.
    if (parts.size > 0 && [...parts].every((part) => words.has(part))) score += 1;
  }
  return score;
}

function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
}
