import type { ModelToolDefinition } from '@jarvis/types';
import type { AnyJarvisTool } from './registry.js';

/**
 * Tool ids are dotted (`filesystem.list`) but several local models reject dots in
 * function names, so the model sees underscores and we map back on the way in.
 */
export function functionNameForTool(toolId: string): string {
  return toolId.replace(/\./g, '_');
}

export function toolIdForFunctionName(name: string): string {
  return name.replace(/_/g, '.');
}

/** Describe a tool for a runtime's native function calling. */
export function toModelToolDefinition(tool: AnyJarvisTool): ModelToolDefinition {
  return {
    name: functionNameForTool(tool.id),
    description: tool.description,
    parameters: {
      type: 'object',
      properties: tool.inputSchema.properties,
      required: tool.inputSchema.required,
    },
  };
}

/** Some models return `arguments` as a JSON string rather than an object. */
export function normalizeToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(raw) ? raw : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
