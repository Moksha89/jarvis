import type { ToolCallRecord } from '@jarvis/types';
import type { EventBus } from '@jarvis/events';

/** The slice of `ToolExecutor` a waiter needs, so tests can stand one in. */
export interface ApprovalWaitExecutor {
  deny(approvalId: string, reason?: string): Promise<ToolCallRecord>;
  getCall(id: string): ToolCallRecord | undefined;
}

export interface ApprovalWaitOptions {
  /** Aborting denies the approval, so the call cannot run after the caller gave up. */
  signal?: AbortSignal;
  /** Nobody is watching: the approval fails closed once this elapses. */
  timeoutMs?: number;
}

/**
 * Blocks until the user (or the timeout, or an abort) settles the approval a call is
 * waiting on. Shared by the agent loop and workflow runs so an unanswered approval
 * always fails closed rather than leaving a run hanging.
 */
export async function waitForApproval(
  executor: ApprovalWaitExecutor,
  bus: EventBus,
  record: ToolCallRecord,
  approvalId: string | undefined,
  options: ApprovalWaitOptions = {},
): Promise<ToolCallRecord> {
  if (!approvalId) return record;

  return await new Promise<ToolCallRecord>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (value: ToolCallRecord): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      options.signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };

    const settleWith = (reason: string): void => {
      void executor
        .deny(approvalId, reason)
        .then(finish)
        .catch(() => finish(executor.getCall(record.id) ?? record));
    };

    const unsubscribe = bus.on('tool.call.changed', (changed) => {
      if (changed.id !== record.id) return;
      if (changed.status === 'pending-approval' || changed.status === 'running') return;
      finish(changed);
    });

    const onAbort = (): void => settleWith('The run was stopped before you answered.');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.timeoutMs !== undefined) {
      const seconds = Math.round(options.timeoutMs / 1000);
      timer = setTimeout(
        () => settleWith(`Nobody answered this approval within ${seconds}s, so it was denied.`),
        options.timeoutMs,
      );
    }
  });
}
