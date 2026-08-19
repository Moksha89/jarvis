import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_LIMITS, WORKFLOW_LIMITS } from '@jarvis/types';
import { JarvisCore } from './core.js';
import { CONFIRMATION_PHRASE } from './services/tool-executor.js';

describe('JarvisCore tool gating and audit', () => {
  let core: JarvisCore;
  let workspace: string;

  beforeEach(() => {
    core = new JarvisCore({ databaseFile: ':memory:', enableAgent: false, enableScheduler: false });
    workspace = mkdtempSync(join(tmpdir(), 'jarvis-test-'));
    core.addPathScope({ path: workspace, mode: 'read-write', effect: 'allow' });
  });

  afterEach(async () => {
    await core.close();
  });

  it('registers the MVP tools', () => {
    const ids = core.listTools().map((tool) => tool.id);
    expect(ids.filter((id) => !id.startsWith('desktop.'))).toEqual([
      'browser.click',
      'browser.close',
      'browser.open',
      'browser.read',
      'browser.screenshot',
      'browser.type',
      'filesystem.delete',
      'filesystem.list',
      'filesystem.read',
      'filesystem.write',
      'knowledge.search',
      'shell.classify',
      'shell.run',
    ]);
    // The desktop tools drive Win32 and UI Automation, so they only exist on Windows.
    const desktop = ids.filter((id) => id.startsWith('desktop.'));
    expect(desktop.length > 0).toBe(platform() === 'win32');
  });

  it('reads a file inside an allowed scope and audits it', async () => {
    const file = join(workspace, 'note.txt');
    writeFileSync(file, 'hello jarvis', 'utf8');

    const call = await core.callTool('filesystem.read', { path: file });
    expect(call.status).toBe('succeeded');
    expect(call.decision.effect).toBe('allow');

    const audit = core.queryAudit({ toolId: 'filesystem.read' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ result: 'succeeded', permission: 'allow', riskLevel: 0, target: file });
  });

  it('denies a read outside every allowed scope and audits the denial', async () => {
    const call = await core.callTool('filesystem.read', { path: join(tmpdir(), 'not-allowed.txt') });
    expect(call.status).toBe('denied');
    expect(core.queryAudit({ result: 'denied' })).toHaveLength(1);
  });

  it('writes a new file without approval under Balanced', async () => {
    const file = join(workspace, 'created.txt');
    const call = await core.callTool('filesystem.write', { path: file, content: 'first' });
    expect(call.status).toBe('succeeded');
    expect(readFileSync(file, 'utf8')).toBe('first');
  });

  it('requires approval before overwriting an existing file', async () => {
    const file = join(workspace, 'existing.txt');
    writeFileSync(file, 'original', 'utf8');

    const call = await core.callTool('filesystem.write', { path: file, content: 'replaced' });
    expect(call.status).toBe('pending-approval');
    expect(readFileSync(file, 'utf8')).toBe('original');

    const [approval] = core.listApprovals({ pendingOnly: true });
    expect(approval?.riskLevel).toBe(2);
    const finished = await core.approve(approval!.id);
    expect(finished.status).toBe('succeeded');
    expect(readFileSync(file, 'utf8')).toBe('replaced');

    const audit = core.queryAudit({ toolId: 'filesystem.write' });
    expect(audit[0]).toMatchObject({ permission: 'ask', result: 'succeeded', reversible: false });
  });

  it('does not run the tool when an approval is denied', async () => {
    const file = join(workspace, 'keep.txt');
    writeFileSync(file, 'keep me', 'utf8');
    await core.callTool('filesystem.write', { path: file, content: 'nope' });
    const [approval] = core.listApprovals({ pendingOnly: true });
    const denied = await core.deny(approval!.id, 'not now');
    expect(denied.status).toBe('denied');
    expect(readFileSync(file, 'utf8')).toBe('keep me');
  });

  it('moves deletes to the recycle bin / trash after approval', async () => {
    const file = join(workspace, 'trash-me.txt');
    writeFileSync(file, 'bye', 'utf8');
    const call = await core.callTool('filesystem.delete', { path: file });
    expect(call.status).toBe('pending-approval');
    const [approval] = core.listApprovals({ pendingOnly: true });
    expect(approval?.reversible).toBe(true);
    const finished = await core.approve(approval!.id);
    expect(finished.status).toBe('succeeded');
    expect(existsSync(file)).toBe(false);
  });

  it('runs read-only shell commands without approval', async () => {
    const call = await core.callTool('shell.run', { command: 'echo jarvis', cwd: workspace });
    expect(call.decision.effect).toBe('allow');
    expect(call.status).toBe('succeeded');
    expect(core.queryAudit({ toolId: 'shell.run' })[0]?.riskLevel).toBe(0);
  });

  it('requires approval for write-class shell commands', async () => {
    const call = await core.callTool('shell.run', { command: 'mkdir nested', cwd: workspace });
    expect(call.status).toBe('pending-approval');
    const [approval] = core.listApprovals({ pendingOnly: true });
    const finished = await core.approve(approval!.id);
    expect(finished.status).toBe('succeeded');
    expect(existsSync(join(workspace, 'nested'))).toBe(true);
  });

  it('blocks dangerous shell commands outright under every profile', async () => {
    for (const profile of ['balanced', 'locked'] as const) {
      core.setPermissionProfile(profile);
      const call = await core.callTool('shell.run', { command: 'format C:', cwd: workspace });
      expect(call.status).toBe('denied');
    }
  });

  it('demands the confirmation phrase for high-risk approvals', async () => {
    const call = await core.callTool('shell.run', { command: 'winget install Foo', cwd: workspace });
    expect(call.status).toBe('pending-approval');
    const [approval] = core.listApprovals({ pendingOnly: true });
    expect(approval?.decision.requiresConfirmationPhrase).toBe(true);
    await expect(core.approve(approval!.id)).rejects.toThrow(/confirmation phrase/);
    await expect(core.approve(approval!.id, { confirmationPhrase: CONFIRMATION_PHRASE })).resolves.toBeTruthy();
  });

  it('refuses to run a tool when its cwd scope is revoked after approval', async () => {
    const call = await core.callTool('shell.run', { command: 'mkdir late', cwd: workspace });
    const [approval] = core.listApprovals({ pendingOnly: true });
    for (const scope of core.getPermissionState().scopes) core.deletePathScope(scope.id);
    const finished = await core.approve(approval!.id);
    expect(finished.status).toBe('failed');
    expect(finished.result?.error).toMatch(/not permitted/);
    expect(call.status).toBe('pending-approval');
  });

  it('remembers an approval as a permission rule when asked', async () => {
    const file = join(workspace, 'remembered.txt');
    writeFileSync(file, 'v1', 'utf8');
    await core.callTool('filesystem.write', { path: file, content: 'v2' });
    const [approval] = core.listApprovals({ pendingOnly: true });
    await core.approve(approval!.id, { remember: true });
    expect(core.getPermissionState().rules).toHaveLength(1);

    const second = await core.callTool('filesystem.write', { path: file, content: 'v3' });
    expect(second.status).toBe('succeeded');
    expect(readFileSync(file, 'utf8')).toBe('v3');
  });

  it('keeps a Locked profile from auto-allowing reversible writes', async () => {
    core.setPermissionProfile('locked');
    const call = await core.callTool('filesystem.write', { path: join(workspace, 'locked.txt'), content: 'x' });
    expect(call.status).toBe('pending-approval');
  });

  it('audits permission changes, since loosening permissions is itself an action', () => {
    // beforeEach already added the workspace scope, so that add is audited too.
    core.setPermissionProfile('locked');
    const rule = core.addPermissionRule({
      toolPattern: 'filesystem.read',
      effect: 'allow',
      maxRiskLevel: 1,
    });
    core.deletePermissionRule(rule.id);
    const [scope] = core.getPermissionState().scopes;
    core.deletePathScope(scope!.id);

    const events = core.queryAudit({ toolId: 'permissions' });
    expect(events.map((event) => event.action)).toEqual([
      'delete-scope',
      'delete-rule',
      'add-rule',
      'set-profile',
      'add-scope',
    ]);
    expect(events.every((event) => event.result === 'succeeded')).toBe(true);
  });

  it('refuses a plan with no goal or more steps than a plan may have', () => {
    const step = { kind: 'prompt' as const, title: 'x', prompt: 'go' };
    const plan = { goal: 'tidy up', summary: 'Tidy', steps: [step], notes: [], model: 'm', fallback: false };

    expect(() => core.runPlan({ ...plan, goal: '  ' })).toThrow(/what you want done/i);
    expect(() =>
      core.runPlan({ ...plan, steps: Array.from({ length: PLAN_LIMITS.maxSteps + 1 }, () => step) }),
    ).toThrow(/at most/i);
  });

  it('saves a plan it runs as a workflow that says Jarvis wrote it', () => {
    const started = core.runPlan({
      goal: 'read the notes',
      summary: 'Read the notes and say what is in them',
      steps: [{ kind: 'prompt', title: 'Read', prompt: 'about {{input}}', mode: 'ask' }],
      notes: [],
      model: 'test-model',
      fallback: false,
    });

    const workflow = core.listWorkflows().find((entry) => entry.id === started.workflowId);
    expect(workflow).toMatchObject({ source: 'planner', goal: 'read the notes' });
    expect(started.run.input).toBe('read the notes');
    core.cancelWorkflowRun(started.run.id);
  });

  it('keeps no saved plan behind when the run cannot start', () => {
    const plan = {
      goal: 'read the notes',
      summary: 'Read the notes',
      steps: [{ kind: 'prompt' as const, title: 'Read', prompt: 'about {{input}}', mode: 'ask' as const }],
      notes: [],
      model: 'test-model',
      fallback: false,
    };
    const started = Array.from({ length: WORKFLOW_LIMITS.maxConcurrentRuns }, () => core.runPlan(plan));
    const savedBefore = core.listWorkflows().length;

    expect(() => core.runPlan(plan)).toThrow(/at once|running/i);
    expect(core.listWorkflows()).toHaveLength(savedBefore);

    for (const run of started) core.cancelWorkflowRun(run.run.id);
  });
});

describe('skill server tools awaiting approval', () => {
  let core: JarvisCore;

  beforeEach(() => {
    core = new JarvisCore({
      databaseFile: ':memory:',
      enableAgent: false,
      enableScheduler: false,
      mcpConnect: () =>
        Promise.resolve({
          listTools: () => Promise.resolve({ tools: [{ name: 'do_thing', description: 'Do a thing.' }] }),
          callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'done' }] }),
          close: () => Promise.resolve(),
        }),
    });
  });

  afterEach(async () => {
    await core.close();
  });

  it('fails the waiting call when the server was switched off, instead of leaving it stuck', async () => {
    const server = await core.addSkillServer({ name: 'demo', command: 'fake', args: [], trust: 'normal' });
    const call = await core.callTool('mcp.demo.do_thing', {});
    expect(call.status).toBe('pending-approval');

    await core.setSkillServerEnabled(server.id, false);
    const [approval] = core.listApprovals({ pendingOnly: true });
    const finished = await core.approve(approval!.id);

    expect(finished.status).toBe('failed');
    expect(finished.result?.error).toMatch(/no longer available/);
    expect(core.listApprovals({ pendingOnly: true })).toHaveLength(0);
  });

  it('audits registering and switching off a skill server, since Jarvis runs that program', async () => {
    const server = await core.addSkillServer({ name: 'demo', command: 'fake', args: ['--stdio'], trust: 'normal' });
    await core.setSkillServerEnabled(server.id, false);
    await core.deleteSkillServer(server.id);

    const events = core.queryAudit({ toolId: 'skills' });
    expect(events.map((event) => event.action)).toEqual(['delete-server', 'disable-server', 'add-server']);
    expect(events.at(-1)?.detail).toMatch(/fake --stdio/);
  });
});

describe('pending approvals across restarts', () => {
  let workspace: string;
  let databaseFile: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'jarvis-restart-'));
    databaseFile = join(workspace, 'jarvis.db');
  });

  it('can approve a call that was left pending before Jarvis was closed', async () => {
    const file = join(workspace, 'kept.txt');
    writeFileSync(file, 'original', 'utf8');

    const first = new JarvisCore({ databaseFile, enableAgent: false, enableScheduler: false });
    first.addPathScope({ path: workspace, mode: 'read-write', effect: 'allow' });
    const call = await first.callTool('filesystem.write', { path: file, content: 'replaced' });
    expect(call.status).toBe('pending-approval');
    await first.close();

    const second = new JarvisCore({ databaseFile, enableAgent: false, enableScheduler: false });
    try {
      const [approval] = second.listApprovals({ pendingOnly: true });
      expect(approval?.target).toBe(call.intent.target);

      const finished = await second.approve(approval!.id);
      expect(finished.id).toBe(call.id);
      expect(finished.status).toBe('succeeded');
      expect(readFileSync(file, 'utf8')).toBe('replaced');
      expect(second.listApprovals({ pendingOnly: true })).toHaveLength(0);
    } finally {
      await second.close();
    }
  });

  it('keeps a denial permanent after a restart', async () => {
    const file = join(workspace, 'kept.txt');
    writeFileSync(file, 'original', 'utf8');

    const first = new JarvisCore({ databaseFile, enableAgent: false, enableScheduler: false });
    first.addPathScope({ path: workspace, mode: 'read-write', effect: 'allow' });
    await first.callTool('filesystem.write', { path: file, content: 'replaced' });
    await first.close();

    const second = new JarvisCore({ databaseFile, enableAgent: false, enableScheduler: false });
    try {
      const [approval] = second.listApprovals({ pendingOnly: true });
      const denied = await second.deny(approval!.id, 'Not this time.');
      expect(denied.status).toBe('denied');
      expect(readFileSync(file, 'utf8')).toBe('original');
      await expect(second.deny(approval!.id)).rejects.toThrow();
    } finally {
      await second.close();
    }
  });
});
