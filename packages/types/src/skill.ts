import type { McpTrust } from './mcp.js';

/**
 * A skill Jarvis is allowed to add to itself. The catalog is curated on purpose: the
 * alternative is letting a model choose a package and a command line, which is a remote
 * code execution path dressed up as a feature.
 */
export interface SkillCatalogEntry {
  /** Stable catalog id, used to ask for this skill by name. */
  id: string;
  /** The skill server's name once added; its tools are `mcp.<name>.<tool>`. */
  name: string;
  summary: string;
  /** Plain words a request might use. This is how Jarvis decides a skill fits. */
  capabilities: readonly string[];
  command: string;
  args: readonly string[];
  /** The package and version the command runs, so it can be shown before anything runs. */
  package?: string;
  trust: McpTrust;
}

export interface SkillMatch {
  entry: SkillCatalogEntry;
  /** How well the wording matched; highest first. */
  score: number;
  /** Already added, so it wants connecting or switching on rather than installing. */
  installed: boolean;
}

export interface InstalledSkill {
  serverId: string;
  name: string;
  connected: boolean;
  toolIds: string[];
  error?: string;
}

export const SKILL_LIMITS = {
  maxMatches: 5,
  maxNeedChars: 200,
} as const;
