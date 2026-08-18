import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChatCompletionRequest,
  ChatStreamEvent,
  ModelInfo,
  ModelPullProgress,
  ModelRuntimeAdapter,
  ModelRuntimeInfo,
  ModelStreamChunk,
  PathScope,
} from '@jarvis/types';
import { EventBus } from '@jarvis/events';
import { PermissionEngine } from '@jarvis/permissions';
import { ToolRegistry, createFilesystemTools, createPathGuard } from '@jarvis/tools';
import { openDatabase, type JarvisDatabase } from '../db/database.js';
import { AuditStore } from '../store/audit-store.js';
import { AgentRunner, type AgentRunResult } from './agent-runner.js';
import { ToolExecutor } from './tool-executor.js';

/** Replays a scripted turn per model call, so the loop can be tested without Ollama. */
class ScriptedRuntime implements ModelRuntimeAdapter {
  readonly id = 'scripted';
  readonly name = 'Scripted runtime';
  readonly requests: ChatCompletionRequest[] = [];
  private turn = 0;

  constructor(private readonly script: readonly (readonly ModelStreamChunk[])[]) {}

  async status(): Promise<ModelRuntimeInfo> {
    return { id: this.id, name: this.name, status: 'ready', endpoint: 'scripted://' };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
  async loadModel(): Promise<void> {}
  async unloadModel(): Promise<void> {}
  async *pullModel(): AsyncGenerator<ModelPullProgress> {
    yield { status: 'success', done: true };
  }
  async deleteModel(): Promise<void> {}
  async embed(): Promise<number[][]> {
    return [];
  }

  async *streamChat(request: ChatCompletionRequest): AsyncGenerator<ModelStreamChunk> {
    this.requests.push(request);
    // Past the end of the script the model just keeps repeating its last turn.
    const chunks = this.script[Math.min(this.turn, this.script.length - 1)] ?? [];
    this.turn += 1;
    for (const chunk of chunks) {
      yield chunk;
    }
  }
}

interface Harness {
  runner: AgentRunner;
  executor: ToolExecutor;
  bus: EventBus;
  db: JarvisDatabase;
}

function harness(runtime: ModelRuntimeAdapter, workspace: string): Harness {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const scopes: PathScope[] = [
    {
      id: 'scope-1',
      path: workspace,
      mode: 'read-write',
      effect: 'allow',
      createdAt: new Date().toISOString(),
    },
  ];
  const engine = new PermissionEngine({ profile: 'balanced', rules: [], scopes });
  const registry = new ToolRegistry();
  for (const tool of createFilesystemTools(createPathGuard(() => scopes))) {
    registry.register(tool);
  }
  const executor = new ToolExecutor(db, registry, engine, new AuditStore(db), bus);
  return { runner: new AgentRunner(runtime, registry, executor, bus), executor, bus, db };
}

async function drain(
  generator: AsyncGenerator<ChatStreamEvent, AgentRunResult>,
): Promise<{ events: ChatStreamEvent[]; result: AgentRunResult }> {
  const events: ChatStreamEvent[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe('AgentRunner', () => {
  let workspace: string;
  let open: Harness | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'jarvis-agent-'));
  });

  afterEach(() => {
    open?.db.close();
    open = undefined;
  });

  it('runs a tool through the executor and answers from its result', async () => {
    const file = join(workspace, 'note.txt');
    writeFileSync(file, 'hello from disk', 'utf8');
    const runtime = new ScriptedRuntime([
      [{ type: 'tool-calls', calls: [{ name: 'filesystem_read', arguments: { path: file } }] }],
      [{ type: 'delta', text: 'The note says hello from disk.' }],
    ]);
    open = harness(runtime, workspace);

    const { events, result } = await drain(
      open.runner.run({
        conversationId: 'conv-1',
        model: 'test',
        history: [{ role: 'user', content: 'read my note' }],
        maxSteps: 4,
        messageId: 'msg-1',
      }),
    );

    expect(result.content).toBe('The note says hello from disk.');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ toolId: 'filesystem.read', ok: true });
    expect(events.filter((event) => event.type === 'tool-result')).toHaveLength(1);
    // The second model turn must see the tool output, not just the assistant's text.
    const second = runtime.requests[1];
    expect(second?.messages.some((message) => message.role === 'tool')).toBe(true);
    expect(open.executor.listCalls()[0]).toMatchObject({ toolId: 'filesystem.read', status: 'succeeded' });
  });

  it('offers every registered tool with a model-safe name', async () => {
    const runtime = new ScriptedRuntime([[{ type: 'delta', text: 'nothing to do' }]]);
    open = harness(runtime, workspace);
    await drain(
      open.runner.run({
        conversationId: 'conv-1',
        model: 'test',
        history: [{ role: 'user', content: 'hi' }],
        maxSteps: 2,
        messageId: 'msg-1',
      }),
    );
    expect(runtime.requests[0]?.tools?.map((tool) => tool.name)).toContain('filesystem_read');
  });

  it('stops at the step budget and says so instead of claiming success', async () => {
    const file = join(workspace, 'note.txt');
    writeFileSync(file, 'x', 'utf8');
    const runtime = new ScriptedRuntime([
      [{ type: 'tool-calls', calls: [{ name: 'filesystem_read', arguments: { path: file } }] }],
    ]);
    open = harness(runtime, workspace);

    const { result } = await drain(
      open.runner.run({
        conversationId: 'conv-1',
        model: 'test',
        history: [{ role: 'user', content: 'loop forever' }],
        maxSteps: 2,
        messageId: 'msg-1',
      }),
    );

    expect(result.stepsUsed).toBe(2);
    expect(result.steps).toHaveLength(2);
    expect(result.content).toContain('all 2 allowed steps');
  });

  it('keeps the prose the model wrote alongside its tool calls when it runs out of steps', async () => {
    const file = join(workspace, 'note.txt');
    writeFileSync(file, 'x', 'utf8');
    const runtime = new ScriptedRuntime([
      [
        { type: 'delta', text: 'Here is what I found so far.' },
        { type: 'tool-calls', calls: [{ name: 'filesystem_read', arguments: { path: file } }] },
      ],
    ]);
    open = harness(runtime, workspace);

    const { result } = await drain(
      open.runner.run({
        conversationId: 'conv-1',
        model: 'test',
        history: [{ role: 'user', content: 'loop forever' }],
        maxSteps: 2,
        messageId: 'msg-1',
      }),
    );

    expect(result.content).toContain('Here is what I found so far.');
    expect(result.content).toContain('all 2 allowed steps');
  });

  it('tells the model when it invented a tool, without executing anything', async () => {
    const runtime = new ScriptedRuntime([
      [{ type: 'tool-calls', calls: [{ name: 'browser_open', arguments: {} }] }],
      [{ type: 'delta', text: 'I cannot browse.' }],
    ]);
    open = harness(runtime, workspace);

    const { result } = await drain(
      open.runner.run({
        conversationId: 'conv-1',
        model: 'test',
        history: [{ role: 'user', content: 'open a site' }],
        maxSteps: 3,
        messageId: 'msg-1',
      }),
    );

    expect(result.content).toBe('I cannot browse.');
    expect(result.steps[0]?.ok).toBe(false);
    expect(open.executor.listCalls()).toHaveLength(0);
  });

  it('waits for approval and reports the denial back to the model', async () => {
    const file = join(workspace, 'existing.txt');
    writeFileSync(file, 'original', 'utf8');
    const runtime = new ScriptedRuntime([
      [
        {
          type: 'tool-calls',
          calls: [{ name: 'filesystem_write', arguments: { path: file, content: 'replaced' } }],
        },
      ],
      [{ type: 'delta', text: 'You denied the overwrite, so I stopped.' }],
    ]);
    open = harness(runtime, workspace);

    const bus = open.bus;
    const executor = open.executor;
    bus.on('approval.requested', (approval) => {
      setTimeout(() => void executor.deny(approval.id, 'No thanks.'), 5);
    });

    const { events, result } = await drain(
      open.runner.run({
        conversationId: 'conv-1',
        model: 'test',
        history: [{ role: 'user', content: 'overwrite it' }],
        maxSteps: 3,
        messageId: 'msg-1',
      }),
    );

    expect(events.some((event) => event.type === 'awaiting-approval')).toBe(true);
    expect(result.steps[0]?.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('original');
  });

  it('runs the call after the user approves it', async () => {
    const file = join(workspace, 'existing.txt');
    writeFileSync(file, 'original', 'utf8');
    const runtime = new ScriptedRuntime([
      [
        {
          type: 'tool-calls',
          calls: [{ name: 'filesystem_write', arguments: { path: file, content: 'replaced' } }],
        },
      ],
      [{ type: 'delta', text: 'Overwritten.' }],
    ]);
    open = harness(runtime, workspace);

    const executor = open.executor;
    open.bus.on('approval.requested', (approval) => {
      setTimeout(() => void executor.approve(approval.id), 5);
    });

    const { result } = await drain(
      open.runner.run({
        conversationId: 'conv-1',
        model: 'test',
        history: [{ role: 'user', content: 'overwrite it' }],
        maxSteps: 3,
        messageId: 'msg-1',
      }),
    );

    expect(result.steps[0]?.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('replaced');
  });

  it('denies an unanswered approval when nobody is watching', async () => {
    const file = join(workspace, 'existing.txt');
    writeFileSync(file, 'original', 'utf8');
    const runtime = new ScriptedRuntime([
      [
        {
          type: 'tool-calls',
          calls: [{ name: 'filesystem_write', arguments: { path: file, content: 'replaced' } }],
        },
      ],
      [{ type: 'delta', text: 'Nobody approved it.' }],
    ]);
    open = harness(runtime, workspace);

    const { result } = await drain(
      open.runner.run({
        conversationId: 'conv-1',
        model: 'test',
        history: [{ role: 'user', content: 'overwrite it' }],
        maxSteps: 3,
        messageId: 'msg-1',
        unattended: true,
        approvalTimeoutMs: 50,
      }),
    );

    expect(result.steps[0]?.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('original');
    expect(open.executor.listPendingApprovals()).toHaveLength(0);
  });

  it('stops between steps when the run is aborted', async () => {
    const file = join(workspace, 'note.txt');
    writeFileSync(file, 'x', 'utf8');
    const controller = new AbortController();
    const runtime = new ScriptedRuntime([
      [{ type: 'tool-calls', calls: [{ name: 'filesystem_read', arguments: { path: file } }] }],
    ]);
    open = harness(runtime, workspace);

    open.bus.on('tool.call.changed', () => controller.abort());

    await expect(
      drain(
        open.runner.run({
          conversationId: 'conv-1',
          model: 'test',
          history: [{ role: 'user', content: 'read it' }],
          maxSteps: 5,
          messageId: 'msg-1',
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow();
  });
});
