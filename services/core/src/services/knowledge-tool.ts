import type { JarvisTool, KnowledgeHit } from '@jarvis/types';
import { KNOWLEDGE_LIMITS, RiskLevel } from '@jarvis/types';
import type { KnowledgeService } from './knowledge-service.js';

export interface KnowledgeSearchInput {
  query: string;
  limit?: number;
}

/** Text handed back to the model per hit, so a long document cannot flood the context. */
const HIT_CAP = 1_200;

/**
 * Retrieval as a tool, so an agent run searches memory through the same audited,
 * permission-gated path as every other capability instead of a private back channel.
 */
export function createKnowledgeSearchTool(service: KnowledgeService): JarvisTool<KnowledgeSearchInput, KnowledgeHit[]> {
  return {
    id: 'knowledge.search',
    name: 'Search indexed knowledge',
    version: '1.0.0',
    category: 'system',
    description:
      'Search the files you indexed and past conversations for passages relevant to a question. Read-only.',
    baseRiskLevel: RiskLevel.Safe,
    reversible: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in the user\'s own words.' },
        limit: { type: 'number', description: 'How many passages to return.', default: KNOWLEDGE_LIMITS.retrievalLimit },
      },
      required: ['query'],
    },
    describe: (input) => ({
      summary: `Search indexed knowledge for "${input.query}".`,
      target: input.query,
      riskLevel: RiskLevel.Safe,
      reversible: true,
    }),
    execute: async (input) => {
      const hits = await service.search(input.query, { limit: input.limit });
      if (hits.length === 0) {
        return { ok: true, data: [], summary: `No indexed passage matches "${input.query}".` };
      }
      return {
        ok: true,
        data: hits.map((hit) => ({ ...hit, text: hit.text.slice(0, HIT_CAP) })),
        summary: `${hits.length} passage${hits.length === 1 ? '' : 's'} from ${
          new Set(hits.map((hit) => hit.source)).size
        } source${new Set(hits.map((hit) => hit.source)).size === 1 ? '' : 's'}.`,
      };
    },
  };
}
