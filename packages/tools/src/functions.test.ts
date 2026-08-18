import { describe, expect, it } from 'vitest';
import {
  functionNameForTool,
  normalizeToolArguments,
  toModelToolDefinition,
  toolIdForFunctionName,
} from './functions.js';
import { createFilesystemTools } from './filesystem.js';

describe('model function names', () => {
  it('round-trips a dotted tool id through a model-safe name', () => {
    expect(functionNameForTool('filesystem.read')).toBe('filesystem_read');
    expect(toolIdForFunctionName('filesystem_read')).toBe('filesystem.read');
  });

  it('describes a tool with its input schema', () => {
    const tool = createFilesystemTools({ assert: () => undefined })[0];
    if (!tool) throw new Error('expected a filesystem tool');
    const definition = toModelToolDefinition(tool);
    expect(definition.name).toBe(functionNameForTool(tool.id));
    expect(definition.parameters.type).toBe('object');
    expect(definition.parameters.required).toEqual(tool.inputSchema.required);
  });
});

describe('normalizeToolArguments', () => {
  it('keeps object arguments as they are', () => {
    expect(normalizeToolArguments({ path: 'C:\\x.txt' })).toEqual({ path: 'C:\\x.txt' });
  });

  it('parses arguments a model emitted as a JSON string', () => {
    expect(normalizeToolArguments('{"path":"C:\\\\x.txt"}')).toEqual({ path: 'C:\\x.txt' });
  });

  it('falls back to an empty object for junk', () => {
    expect(normalizeToolArguments('not json')).toEqual({});
    expect(normalizeToolArguments(null)).toEqual({});
    expect(normalizeToolArguments(['a'])).toEqual({});
  });
});
