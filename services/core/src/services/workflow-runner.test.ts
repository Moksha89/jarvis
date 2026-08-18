import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatStreamEvent, JarvisTool, ToolResult } from '@jarvis/types';
import { RiskLevel } from '@jarvis/types';
import { EventBus } from '@jarvis/events';
import { PermissionEngine } from '@jarvis/permissions';
import { ToolRegistry } from '@jarvis/tools';
import { openDatabase, type JarvisDatabase } from '../db/database.js';
import { AuditStore } from '../store/audit-store.js';
import { ConversationStore } from '../store/conversation-store.js';
import { WorkflowStore } from '../store/workflow-store.js';
import { ToolExecutor } from './tool-executor.js';
import { WorkflowRunner, renderTemplate, type WorkflowTurnRunner } from './workflow-runner.js';

interface EchoOptions {
  id: string;
  riskLevel: RiskLevel;
  fail?: boolean;
}

/** A tool with no paths, so a test decides its verdict purely through its risk level. */
function echoTool(options: EchoOptions): JarvisTool<{ text?: string }, { text: string }> {
  return {
    id: options.id,
    name: options.id,
    version: '1.0.0',
    category: 'app',
    description: 'Echoes its input back.',
    baseRiskLevel: options.riskLevel,
    reversible: true,
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text' } }, required: [] },
    describe: (input) => ({
      summary: `Echo ${input.text ?? ''}`,
      target: options.id,
      riskLevel: options.riskLevel,
      reversible: true,
    }),
    execute: (input): Promise<ToolResult<{ text: string }>> =>
      Promise.resolve(
        options.fail
          ? { ok: false, error: 'the tool broke', summary: 'echo failed' }
          : { ok: true, data: { text: input.text ?? '' }, summary: `echoed ${input.text ?? ''}` },
      ),
  };
}

/** Answers every prompt step with the prompt it received, so templates are observable. */
const echoTurn: WorkflowTurnRunner = async function* (options) {
  const done: ChatStreamEvent[] = [
    { type: 'delta', messageId: 'm', text: `seen: ${options.prompt}` },
    { type: 'done', messageId: 'm', content: `seen: ${options.prompt}` },
  ];
  for (const event of done) yield event;
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('renderTemplate', () => {
  it('fills the run input, a numbered step and the previous step', () => {
    const outputs = new Map([
      [1, 'one'],
      [2, 'two'],
    ]);
    expect(renderTemplate('{{input}}/{{step1}}/{{previous}}', 'in', outputs)).toBe('in/one/two');
  });

  it('leaves nothing behind for a placeholder it cannot fill', () => {
    expect(renderTemplate('a{{step9}}b{{nonsense}}c', undefined, new Map())).toBe('abc');
  });
});

describe('WorkflowRunner', () => {
  let db: JarvisDatabase;
  let store: WorkflowStore;
  let conversations: ConversationStore;
  let registry: ToolRegistry;
  let executor: ToolExecutor;
  let bus: EventBus;

  const build = (turn: WorkflowTurnRunner = echoTurn): WorkflowRunner =>
    new WorkflowRunner({ store, conversations, registry, executor, bus, runTurn: turn });

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new WorkflowStore(db);
    conversations = new ConversationStore(db);
    registry = new ToolRegistry();
    registry.register(echoTool({ id: 'app.echo', riskLevel: RiskLevel.Safe }));
    registry.register(echoTool({ id: 'app.broken', riskLevel: RiskLevel.Safe, fail: true }));
    registry.register(echoTool({ id: 'app.risky', riskLevel: RiskLevel.Medium }));
    bus = new EventBus();
    executor = new ToolExecutor(
      db,
      registry,
      new PermissionEngine({ profile: 'balanced', rules: [], scopes: [] }),
      new AuditStore(db),
      bus,
    );
  });

  afterEach(() => {
    db.close();
  });

  it('runs steps in order and feeds each output into the next', async () => {
    const runner = build();
    const workflow = store.create({
      name: 'Chain',
      steps: [
        { kind: 'tool', title: 'Echo the input', toolId: 'app.echo', input: { text: '{{input}}' } },
        { kind: 'prompt', title: 'Say it back', prompt: 'about {{previous}}' },
      ],
    });

    const run = runner.runNow(workflow.id, 'hello');
    expect(run.status).toBe('running');
    await flush();

    const finished = store.requireRun(run.id);
    expect(finished.status).toBe('succeeded');
    expect(finished.steps).toHaveLength(2);
    expect(finished.steps[0]?.output).toContain('hello');
    // The prompt step saw the first step's output, not the literal placeholder.
    expect(finished.steps[1]?.output).toContain('about {"text":"hello"}');
    expect(store.require(workflow.id).lastRunStatus).toBe('succeeded');
    runner.stop();
  });

  it('renders placeholders inside nested tool arguments', async () => {
    const seen: unknown[] = [];
    registry.register({
      ...echoTool({ id: 'app.nested', riskLevel: RiskLevel.Safe }),
      execute: (input: unknown): Promise<ToolResult<{ text: string }>> => {
        seen.push(input);
        return Promise.resolve({ ok: true, data: { text: 'ok' }, summary: 'ok' });
      },
    } as JarvisTool<{ text?: string }, { text: string }>);

    const runner = build();
    const workflow = store.create({
      name: 'Nested',
      steps: [
        {
          kind: 'tool',
          title: 'Nested arguments',
          toolId: 'app.nested',
          input: { outer: { inner: ['{{input}}', 'plain'] } },
        },
      ],
    });

    runner.runNow(workflow.id, 'deep');
    await flush();

    expect(seen[0]).toEqual({ outer: { inner: ['deep', 'plain'] } });
    runner.stop();
  });

  it('stops at a failing step but carries on when the step is best-effort', async () => {
    const runner = build();
    const strict = store.create({
      name: 'Strict',
      steps: [
        { kind: 'tool', title: 'Break', toolId: 'app.broken' },
        { kind: 'prompt', title: 'Never runs', prompt: 'hi' },
      ],
    });
    const lenient = store.create({
      name: 'Lenient',
      steps: [
        { kind: 'tool', title: 'Break', toolId: 'app.broken', continueOnError: true },
        { kind: 'prompt', title: 'Runs anyway', prompt: 'hi' },
      ],
    });

    const strictRun = runner.runNow(strict.id);
    await flush();
    const strictFinished = store.requireRun(strictRun.id);
    expect(strictFinished.status).toBe('failed');
    expect(strictFinished.steps).toHaveLength(1);
    expect(strictFinished.error).toContain('the tool broke');

    const lenientRun = runner.runNow(lenient.id);
    await flush();
    const lenientFinished = store.requireRun(lenientRun.id);
    expect(lenientFinished.status).toBe('succeeded');
    expect(lenientFinished.steps).toHaveLength(2);
    runner.stop();
  });

  it('waits for an approval and runs the step once it is granted', async () => {
    const runner = build();
    const workflow = store.create({
      name: 'Gated',
      steps: [{ kind: 'tool', title: 'Risky', toolId: 'app.risky', input: { text: 'go' } }],
    });

    const run = runner.runNow(workflow.id);
    await flush();
    expect(store.requireRun(run.id).status).toBe('running');

    const approval = executor.listApprovals().find((entry) => entry.status === 'pending');
    expect(approval).toBeDefined();
    await executor.approve(approval?.id as string);
    await flush();

    const finished = store.requireRun(run.id);
    expect(finished.status).toBe('succeeded');
    expect(finished.steps[0]?.ok).toBe(true);
    runner.stop();
  });

  it('fails the step when the approval is denied', async () => {
    const runner = build();
    const workflow = store.create({
      name: 'Denied',
      steps: [{ kind: 'tool', title: 'Risky', toolId: 'app.risky' }],
    });

    const run = runner.runNow(workflow.id);
    await flush();
    const approval = executor.listApprovals().find((entry) => entry.status === 'pending');
    await executor.deny(approval?.id as string, 'not today');
    await flush();

    const finished = store.requireRun(run.id);
    expect(finished.status).toBe('failed');
    expect(finished.steps[0]?.ok).toBe(false);
    runner.stop();
  });

  it('cancels a run that is waiting, and reports it as cancelled', async () => {
    const runner = build();
    const workflow = store.create({
      name: 'Cancel me',
      steps: [{ kind: 'tool', title: 'Risky', toolId: 'app.risky' }],
    });

    const run = runner.runNow(workflow.id);
    await flush();
    runner.cancelRun(run.id);
    await flush();

    const finished = store.requireRun(run.id);
    expect(finished.status).toBe('cancelled');
    expect(() => runner.cancelRun(run.id)).toThrow(/already finished/i);
    runner.stop();
  });

  it('refuses to run a workflow that is off, or one already running', async () => {
    const runner = build();
    const off = store.create({
      name: 'Off',
      enabled: false,
      steps: [{ kind: 'prompt', title: 'Hi', prompt: 'hi' }],
    });
    expect(() => runner.runNow(off.id)).toThrow(/turned off/i);

    const busy = store.create({
      name: 'Busy',
      steps: [{ kind: 'tool', title: 'Risky', toolId: 'app.risky' }],
    });
    runner.runNow(busy.id);
    await flush();
    expect(() => runner.runNow(busy.id)).toThrow(/already running/i);
    runner.stop();
  });

  it('reports a missing tool as a failed step rather than crashing the run', async () => {
    const runner = build();
    const workflow = store.create({
      name: 'Ghost',
      steps: [{ kind: 'tool', title: 'Gone', toolId: 'app.does-not-exist' }],
    });

    const run = runner.runNow(workflow.id);
    await flush();

    const finished = store.requireRun(run.id);
    expect(finished.status).toBe('failed');
    expect(finished.steps[0]?.error).toContain('no tool called');
    runner.stop();
  });

  it('fails runs a crash left in flight when it recovers', () => {
    const workflow = store.create({
      name: 'Crashed',
      steps: [{ kind: 'prompt', title: 'Hi', prompt: 'hi' }],
    });
    const stale = store.startRun(workflow.id);

    build().recover();

    expect(store.requireRun(stale.id).status).toBe('failed');
  });

  it('leaves bookkeeping alone once it has been stopped', async () => {
    const runner = build();
    const workflow = store.create({
      name: 'Shutdown',
      steps: [{ kind: 'tool', title: 'Risky', toolId: 'app.risky' }],
    });

    const run = runner.runNow(workflow.id);
    await flush();
    runner.stop();
    await flush();

    // Left as running on purpose: recovery on the next start marks it failed.
    expect(store.requireRun(run.id).status).toBe('running');
  });
});
