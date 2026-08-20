import type { SkillCatalogEntry } from '@jarvis/types';

/**
 * The skills Jarvis may add without a human choosing the command line. Versions are
 * pinned so an approval covers exactly what will run, and every entry is a local stdio
 * server that needs no account or key.
 *
 * Deliberately absent: a filesystem skill server. Its tools would run in their own
 * process and read outside the folders you allowed, which is precisely the boundary
 * Jarvis's own file tools exist to keep.
 */
export const SKILL_CATALOG: readonly SkillCatalogEntry[] = [
  {
    id: 'memory',
    name: 'memory',
    summary: 'Remembers facts, people and preferences between conversations as a knowledge graph.',
    capabilities: [
      'remember',
      'memory',
      'recall',
      'forget',
      'note',
      'notes',
      'knowledge graph',
      'entity',
      'relation',
      'preference',
    ],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory@2026.7.4'],
    package: '@modelcontextprotocol/server-memory@2026.7.4',
    trust: 'normal',
  },
  {
    id: 'reasoning',
    name: 'reasoning',
    summary: 'Works a hard problem through in numbered steps, revising earlier steps as it goes.',
    capabilities: [
      'think',
      'reason',
      'reasoning',
      'plan carefully',
      'step by step',
      'analyse',
      'analyze',
      'break down',
      'decompose',
      'brainstorm',
    ],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2026.7.4'],
    package: '@modelcontextprotocol/server-sequential-thinking@2026.7.4',
    trust: 'read-only',
  },
  {
    id: 'library-docs',
    name: 'library-docs',
    summary: "Looks up a code library's current documentation and API, so answers are not from memory.",
    capabilities: [
      'documentation',
      'docs',
      'api reference',
      'library',
      'package',
      'framework',
      'sdk',
      'how do i use',
      'code example',
      'version',
    ],
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@4.0.2'],
    package: '@upstash/context7-mcp@4.0.2',
    trust: 'read-only',
  },
];
