import { describe, expect, it } from 'vitest';
import type { ToolCallRecord } from '@jarvis/types';
import { RiskLevel } from '@jarvis/types';
import { EventBus } from '@jarvis/events';
import { waitForApproval, type ApprovalWaitExecutor } from './approval-wait.js';

const record: ToolCallRecord = {
  id: 'call-1',
  toolId: 'app.echo',
  action: 'echo',
  input: {},
  intent: { summary: 'Echo something', target: 'app.echo', riskLevel: RiskLevel.Medium, reversible: true },
  decision: {
    effect: 'ask',
    riskLevel: RiskLevel.Medium,
    reason: 'profile:balanced',
    explanation: 'Needs your approval.',
    requiresConfirmationPhrase: false,
  },
  status: 'pending-approval',
  startedAt: new Date().toISOString(),
};

function fakeExecutor(): ApprovalWaitExecutor & { denials: string[] } {
  const denials: string[] = [];
  return {
    denials,
    deny: (_approvalId, reason) => {
      denials.push(reason ?? '');
      return Promise.resolve({ ...record, status: 'denied' as const });
    },
    getCall: () => record,
  };
}

describe('waitForApproval', () => {
  it('resolves once the call reaches a terminal state', async () => {
    const bus = new EventBus();
    const waiting = waitForApproval(fakeExecutor(), bus, record, 'approval-1');
    bus.emit('tool.call.changed', { ...record, status: 'running' });
    bus.emit('tool.call.changed', { ...record, status: 'succeeded' });
    expect((await waiting).status).toBe('succeeded');
  });

  it('denies straight away when the signal aborted before the wait started', async () => {
    const executor = fakeExecutor();
    const controller = new AbortController();
    controller.abort();

    // An aborted signal never fires again, so without this the run would wait forever.
    const settled = await waitForApproval(executor, new EventBus(), record, 'approval-1', {
      signal: controller.signal,
    });

    expect(settled.status).toBe('denied');
    expect(executor.denials).toHaveLength(1);
  });

  it('denies when the caller aborts while waiting', async () => {
    const executor = fakeExecutor();
    const controller = new AbortController();
    const waiting = waitForApproval(executor, new EventBus(), record, 'approval-1', { signal: controller.signal });
    controller.abort();
    expect((await waiting).status).toBe('denied');
  });

  it('fails closed when nobody answers in time', async () => {
    const executor = fakeExecutor();
    const settled = await waitForApproval(executor, new EventBus(), record, 'approval-1', { timeoutMs: 5 });
    expect(settled.status).toBe('denied');
    expect(executor.denials[0]).toMatch(/within/i);
  });

  it('returns the record untouched when there is no approval to wait for', async () => {
    expect(await waitForApproval(fakeExecutor(), new EventBus(), record, undefined)).toBe(record);
  });
});
