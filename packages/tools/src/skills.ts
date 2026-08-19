import type { InstalledSkill, JarvisTool, SkillCatalogEntry, SkillMatch } from '@jarvis/types';
import { RiskLevel, SKILL_LIMITS } from '@jarvis/types';

/** What the tools need from the installer, kept narrow so tests need no MCP process. */
export interface SkillBridge {
  entries(): readonly SkillCatalogEntry[];
  find(need: string): SkillMatch[];
  install(skillId: string): Promise<InstalledSkill>;
}

interface SkillOffer {
  skillId: string;
  name: string;
  summary: string;
  capabilities: readonly string[];
  package?: string;
  trust: string;
  installed: boolean;
}

/**
 * Lets Jarvis notice that it lacks a capability and give itself one, instead of the user
 * wiring up a skill server by hand. Only catalog entries can be installed, and installing
 * one is a high-risk action, so the first spawn of a new server is approved and audited.
 */
export function createSkillTools(bridge: SkillBridge): JarvisTool<never, unknown>[] {
  return [createFindTool(bridge), createInstallTool(bridge)] as JarvisTool<never, unknown>[];
}

function createFindTool(bridge: SkillBridge): JarvisTool<{ need: string }, { offers: SkillOffer[] }> {
  return {
    id: 'skills.find',
    name: 'Find a skill Jarvis can add',
    version: '1.0.0',
    category: 'app',
    description:
      'Look for a skill Jarvis could add to itself to do something it has no tool for. Describe the missing ability in plain words. Follow up with skills.install to add one.',
    baseRiskLevel: RiskLevel.Safe,
    reversible: true,
    inputSchema: {
      type: 'object',
      properties: { need: { type: 'string', description: 'The missing ability, in plain words.' } },
      required: ['need'],
    },
    describe: (input) => ({
      summary: `Look for a skill that can ${input.need}.`,
      riskLevel: RiskLevel.Safe,
      reversible: true,
    }),
    execute: (input) => {
      const matches = bridge.find(typeof input.need === 'string' ? input.need : '');
      const offers = matches.map(toOffer);
      return Promise.resolve({
        ok: true,
        data: { offers },
        summary:
          offers.length > 0
            ? `Found ${String(offers.length)} skill(s) that could help: ${offers.map((offer) => offer.skillId).join(', ')}.`
            : 'No skill in the catalog covers that. Jarvis only adds skills it has vetted definitions for.',
      });
    },
  };
}

function createInstallTool(bridge: SkillBridge): JarvisTool<{ skillId: string }, InstalledSkill> {
  return {
    id: 'skills.install',
    name: 'Add a skill to Jarvis',
    version: '1.0.0',
    category: 'app',
    description:
      'Add a skill from the Jarvis catalog and connect it, so its tools become available. Use the skillId reported by skills.find.',
    // Installing runs a program on this machine and downloads its package: no folder
    // scope contains it, so it is treated as a high-risk change rather than a setting.
    baseRiskLevel: RiskLevel.High,
    reversible: false,
    inputSchema: {
      type: 'object',
      properties: { skillId: { type: 'string', description: 'Catalog id of the skill, from skills.find.' } },
      required: ['skillId'],
    },
    describe: (input) => {
      const entry = bridge.entries().find((candidate) => candidate.id === input.skillId);
      const command = entry ? `${entry.command} ${entry.args.join(' ')}`.trim() : String(input.skillId);
      return {
        summary: `Add the ${entry?.name ?? String(input.skillId)} skill to Jarvis and run it: ${command}`,
        target: entry?.package ?? command,
        riskLevel: RiskLevel.High,
        reversible: false,
      };
    },
    execute: async (input) => {
      try {
        const installed = await bridge.install(String(input.skillId));
        return {
          ok: true,
          data: installed,
          summary:
            installed.toolIds.length > 0
              ? `Added the ${installed.name} skill with ${String(installed.toolIds.length)} tool(s): ${installed.toolIds.join(', ')}.`
              : `Added the ${installed.name} skill, which offered no tools.`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message, summary: `The skill was not added: ${message}` };
      }
    },
  };
}

function toOffer(match: SkillMatch): SkillOffer {
  return {
    skillId: match.entry.id,
    name: match.entry.name,
    summary: match.entry.summary.slice(0, SKILL_LIMITS.maxNeedChars),
    capabilities: match.entry.capabilities,
    package: match.entry.package,
    trust: match.entry.trust,
    installed: match.installed,
  };
}
