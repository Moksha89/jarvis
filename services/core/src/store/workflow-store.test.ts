import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_LIMITS } from '@jarvis/types';
import { openDatabase, type JarvisDatabase } from '../db/database.js';
import { WorkflowStore } from './workflow-store.js';

describe('WorkflowStore', () => {
  let db: JarvisDatabase;
  let store: WorkflowStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new WorkflowStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('numbers steps from one and keeps the order they were written in', () => {
    const workflow = store.create({
      name: '  Tidy  ',
      description: '  keeps things neat  ',
      steps: [
        { kind: 'tool', title: 'List', toolId: 'filesystem.list' },
        { kind: 'prompt', title: 'Summarise', prompt: 'summarise {{previous}}' },
      ],
    });

    expect(workflow.name).toBe('Tidy');
    expect(workflow.description).toBe('keeps things neat');
    expect(workflow.steps.map((step) => step.position)).toEqual([1, 2]);
    expect(workflow.steps[1]).toMatchObject({ kind: 'prompt', mode: 'ask', maxSteps: 4 });
    expect(store.require(workflow.id).steps).toHaveLength(2);
  });

  it('rejects a workflow with no name, no steps, or a step missing its instruction', () => {
    expect(() => store.create({ name: ' ', steps: [{ kind: 'prompt', title: 'x', prompt: 'go' }] })).toThrow(/name/i);
    expect(() => store.create({ name: 'Empty', steps: [] })).toThrow(/at least one step/i);
    expect(() => store.create({ name: 'No tool', steps: [{ kind: 'tool', title: 'x' }] })).toThrow(/tool it should run/i);
    expect(() => store.create({ name: 'No prompt', steps: [{ kind: 'prompt', title: 'x' }] })).toThrow(/instruction/i);
  });

  it('refuses tool arguments that are not an object', () => {
    expect(() =>
      store.create({
        name: 'Bad input',
        // A list of arguments cannot be handed to a tool that expects named ones.
        steps: [{ kind: 'tool', title: 'x', toolId: 'app.echo', input: [] as unknown as Record<string, unknown> }],
      }),
    ).toThrow(/as an object/i);
  });

  it('caps the number of steps in one workflow', () => {
    const steps = Array.from({ length: WORKFLOW_LIMITS.maxSteps + 1 }, (_, index) => ({
      kind: 'prompt' as const,
      title: `Step ${String(index)}`,
      prompt: 'go',
    }));
    expect(() => store.create({ name: 'Too long', steps })).toThrow(/at most/i);
  });

  it('records run history and surfaces the latest outcome on the workflow', () => {
    const workflow = store.create({ name: 'Run me', steps: [{ kind: 'prompt', title: 'x', prompt: 'go' }] });
    const run = store.startRun(workflow.id, { input: 'now' });
    expect(store.require(workflow.id).running).toBe(true);

    store.appendStepResult(run.id, {
      stepId: workflow.steps[0]?.id as string,
      position: 1,
      title: 'x',
      ok: true,
      summary: 'done',
      output: 'out',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const finished = store.finishRun(run.id, { status: 'succeeded' });

    expect(finished.steps).toHaveLength(1);
    expect(finished.input).toBe('now');
    expect(store.require(workflow.id)).toMatchObject({ running: false, lastRunStatus: 'succeeded' });
    expect(store.listRuns({ workflowId: workflow.id })).toHaveLength(1);
  });

  it('fails runs that a crash left mid-flight', () => {
    const workflow = store.create({ name: 'Crashed', steps: [{ kind: 'prompt', title: 'x', prompt: 'go' }] });
    const stale = store.startRun(workflow.id);

    const healed = store.failStaleRuns();

    expect(healed).toHaveLength(1);
    expect(store.requireRun(stale.id)).toMatchObject({ status: 'failed' });
  });

  it('prunes the oldest plans without touching hand-written workflows or a running plan', () => {
    const step = [{ kind: 'prompt' as const, title: 'x', prompt: 'go' }];
    const mine = store.create({ name: 'Mine', steps: step });
    const plans = [1, 2, 3].map((n) => store.create({ name: `Plan ${String(n)}`, steps: step }, { source: 'planner', goal: 'g' }));
    store.startRun((plans[0] as { id: string }).id);

    store.prunePlans(1);

    expect(store.get(mine.id)).toBeDefined();
    // The running plan survives regardless, and the newest idle plan is the one kept.
    expect(store.get((plans[0] as { id: string }).id)).toBeDefined();
    expect(store.get((plans[2] as { id: string }).id)).toBeDefined();
    expect(store.get((plans[1] as { id: string }).id)).toBeUndefined();
  });

  it('deletes a workflow together with its run history', () => {
    const workflow = store.create({ name: 'Gone', steps: [{ kind: 'prompt', title: 'x', prompt: 'go' }] });
    store.startRun(workflow.id);

    store.delete(workflow.id);

    expect(store.get(workflow.id)).toBeUndefined();
    expect(store.listRuns({ workflowId: workflow.id })).toHaveLength(0);
  });
});
