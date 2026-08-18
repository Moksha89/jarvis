import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ChatCompletionRequest,
  EmbeddingRequest,
  JarvisTool,
  ModelInfo,
  ModelPullProgress,
  ModelRuntimeAdapter,
  ModelRuntimeInfo,
  ModelStreamChunk,
  ToolResult,
} from '@jarvis/types';
import { RiskLevel } from '@jarvis/types';
import { ToolRegistry } from '@jarvis/tools';
import { Planner } from './planner.js';

/** A runtime that replies with scripted text, so a plan can be asserted exactly. */
class ScriptedRuntime implements ModelRuntimeAdapter {
  readonly id = 'scripted';
  readonly name = 'Scripted';
  readonly prompts: string[] = [];

  constructor(private reply: string) {}

  say(reply: string): void {
    this.reply = reply;
  }

  status(): Promise<ModelRuntimeInfo> {
    return Promise.resolve({ id: this.id, name: this.name, status: 'ready', endpoint: 'test://scripted' });
  }
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }
  loadModel(): Promise<void> {
    return Promise.resolve();
  }
  unloadModel(): Promise<void> {
    return Promise.resolve();
  }
  async *pullModel(): AsyncIterable<ModelPullProgress> {
    // Never used by the planner.
  }
  deleteModel(): Promise<void> {
    return Promise.resolve();
  }
  async *streamChat(request: ChatCompletionRequest): AsyncIterable<ModelStreamChunk> {
    this.prompts.push(request.messages.map((message) => message.content ?? '').join('\n'));
    yield { type: 'delta', text: this.reply };
    yield { type: 'done' };
  }
  embed(_request: EmbeddingRequest): Promise<number[][]> {
    return Promise.resolve([]);
  }
}

function echoTool(id: string): JarvisTool<{ text?: string }, { text: string }> {
  return {
    id,
    name: id,
    version: '1.0.0',
    category: 'app',
    description: 'Echoes its input back.',
    baseRiskLevel: RiskLevel.Safe,
    reversible: true,
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text' } }, required: ['text'] },
    describe: () => ({ summary: id, riskLevel: RiskLevel.Safe, reversible: true }),
    execute: (input): Promise<ToolResult<{ text: string }>> =>
      Promise.resolve({ ok: true, data: { text: input.text ?? '' }, summary: 'echoed' }),
  };
}

describe('Planner', () => {
  let registry: ToolRegistry;
  let runtime: ScriptedRuntime;

  const plan = (goal = 'tidy my notes') => new Planner({ runtime, registry }).plan(goal, 'test-model');

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(echoTool('app.echo'));
    runtime = new ScriptedRuntime('{}');
  });

  it('turns the model\'s JSON into ordered steps', async () => {
    runtime.say(
      JSON.stringify({
        summary: 'Echo the notes, then summarise them',
        steps: [
          { title: 'Echo it', tool: 'app.echo', input: { text: '{{input}}' } },
          { title: 'Summarise', prompt: 'Summarise {{step1}}', mode: 'ask' },
        ],
      }),
    );

    const result = await plan();

    expect(result.fallback).toBe(false);
    expect(result.summary).toBe('Echo the notes, then summarise them');
    expect(result.steps).toEqual([
      { kind: 'tool', title: 'Echo it', toolId: 'app.echo', input: { text: '{{input}}' } },
      { kind: 'prompt', title: 'Summarise', prompt: 'Summarise {{step1}}', mode: 'ask', maxSteps: 6 },
    ]);
    expect(result.notes).toEqual([]);
  });

  it('reads the plan out of prose and a code fence around it', async () => {
    runtime.say('Sure! ```json\n{"summary":"Echo","steps":[{"title":"Echo","tool":"app.echo","input":{}}]}\n``` done');

    const result = await plan();

    expect(result.fallback).toBe(false);
    expect(result.steps).toHaveLength(1);
  });

  it('drops a step whose tool does not exist and says so', async () => {
    runtime.say(
      JSON.stringify({
        summary: 'Two steps',
        steps: [
          { title: 'Made up', tool: 'app.invented', input: {} },
          { title: 'Echo', tool: 'app.echo', input: {} },
        ],
      }),
    );

    const result = await plan();

    expect(result.steps).toEqual([{ kind: 'tool', title: 'Echo', toolId: 'app.echo', input: {} }]);
    expect(result.notes[0]).toContain('app.invented');
  });

  it('drops a tool step whose arguments are not an object', async () => {
    runtime.say(JSON.stringify({ summary: 's', steps: [{ title: 'Echo', tool: 'app.echo', input: ['nope'] }] }));

    const result = await plan();

    expect(result.fallback).toBe(true);
    expect(result.notes.some((note) => note.includes('arguments'))).toBe(true);
  });

  it('falls back to one agent step when the model returns no usable plan', async () => {
    runtime.say('I would start by looking at the folder.');

    const result = await plan('tidy my notes');

    expect(result.fallback).toBe(true);
    expect(result.steps).toEqual([
      { kind: 'prompt', title: 'tidy my notes', prompt: 'tidy my notes', mode: 'agent', maxSteps: 8 },
    ]);
  });

  it('keeps at most the step limit and notes the truncation', async () => {
    runtime.say(
      JSON.stringify({
        summary: 'many',
        steps: Array.from({ length: 12 }, (_, index) => ({ title: `Echo ${String(index)}`, tool: 'app.echo', input: {} })),
      }),
    );

    const result = await plan();

    expect(result.steps).toHaveLength(8);
    expect(result.notes.some((note) => note.includes('8 steps'))).toBe(true);
  });

  it('offers the model only the tools that exist, with their arguments', async () => {
    runtime.say('{}');

    await plan();

    expect(runtime.prompts[0]).toContain('app.echo(text: string)');
  });

  it('refuses an empty goal', async () => {
    await expect(plan('   ')).rejects.toThrow(/what you want done/i);
  });
});
