import type {
  ApprovalRequest,
  AuditEvent,
  PermissionRequest,
  ToolCallRecord,
  ToolResult,
} from '@jarvis/types';
import type { EventBus } from '@jarvis/events';
import type { PermissionEngine } from '@jarvis/permissions';
import type { ToolRegistry } from '@jarvis/tools';
import type { JarvisDatabase } from '../db/database.js';
import type { AuditStore } from '../store/audit-store.js';

interface ToolCallRow {
  id: string;
  tool_id: string;
  action: string;
  input_json: string;
  intent_json: string;
  decision_json: string;
  status: string;
  result_json: string | null;
  task_id: string | null;
  conversation_id: string | null;
  started_at: string;
  finished_at: string | null;
}

interface ApprovalRow {
  id: string;
  tool_call_id: string;
  request_json: string;
  decision_json: string;
  status: string;
  created_rule_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ToolCallOptions {
  taskId?: string;
  conversationId?: string;
}

export interface ApproveOptions {
  /** Required when the decision demands it (risk level 3+). */
  confirmationPhrase?: string;
  /** Persist "always allow" as a permission rule. */
  remember?: boolean;
}

export const CONFIRMATION_PHRASE = 'I understand';

/**
 * The one code path that runs tools. Nothing else may call `tool.execute`, so every
 * action is classified, gated by the permission engine and written to the audit log.
 */
export class ToolExecutor {
  constructor(
    private readonly db: JarvisDatabase,
    private readonly registry: ToolRegistry,
    private readonly engine: PermissionEngine,
    private readonly audit: AuditStore,
    private readonly bus: EventBus,
    private readonly onApprovalRule?: (rule: {
      toolPattern: string;
      targetPattern?: string;
      maxRiskLevel: ApprovalRequest['riskLevel'];
    }) => { id: string },
  ) {}

  /** Classify + gate a call. Allowed calls run immediately; others return pending or denied. */
  async call(toolId: string, input: unknown, options: ToolCallOptions = {}): Promise<ToolCallRecord> {
    const tool = this.registry.require(toolId);
    const intent = tool.describe(input as never);
    const request: PermissionRequest = {
      toolId,
      action: toolId.split('.')[1] ?? 'invoke',
      summary: intent.summary,
      target: intent.target,
      paths: intent.paths,
      riskLevel: intent.riskLevel,
      reversible: intent.reversible,
      taskId: options.taskId,
      conversationId: options.conversationId,
    };
    const decision = this.engine.evaluate(request);

    const record: ToolCallRecord = {
      id: crypto.randomUUID(),
      toolId,
      action: request.action,
      input,
      intent,
      decision,
      status: decision.effect === 'deny' ? 'denied' : decision.effect === 'ask' ? 'pending-approval' : 'running',
      startedAt: new Date().toISOString(),
    };
    this.insertCall(record, options);

    if (decision.effect === 'deny') {
      const finished: ToolCallRecord = {
        ...record,
        finishedAt: new Date().toISOString(),
        result: { ok: false, error: decision.explanation, summary: `Blocked: ${intent.summary}` },
      };
      this.updateCall(finished);
      this.appendAudit(finished, 'denied', 0, options);
      this.bus.emit('tool.call.changed', finished);
      return finished;
    }

    if (decision.effect === 'ask') {
      const approval: ApprovalRequest = {
        ...request,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        decision,
        status: 'pending',
      };
      this.insertApproval(approval, record.id);
      this.bus.emit('tool.call.changed', record);
      this.bus.emit('approval.requested', approval);
      return record;
    }

    return await this.run(record, options);
  }

  /** The pending approval blocking a call, if the call is waiting for one. */
  pendingApprovalForCall(callId: string): ApprovalRequest | undefined {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE tool_call_id = ? AND status = 'pending' ORDER BY created_at DESC")
      .get(callId) as ApprovalRow | undefined;
    return row ? toApproval(row) : undefined;
  }

  getCall(id: string): ToolCallRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as ToolCallRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  listPendingApprovals(): ApprovalRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as ApprovalRow[];
    return rows.map(toApproval);
  }

  listApprovals(limit = 100): ApprovalRequest[] {
    const rows = this.db
      .prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(limit, 500)) as ApprovalRow[];
    return rows.map(toApproval);
  }

  async approve(approvalId: string, options: ApproveOptions = {}): Promise<ToolCallRecord> {
    const row = this.getApprovalRow(approvalId);
    const approval = toApproval(row);
    if (approval.status !== 'pending') {
      throw new Error(`Approval ${approvalId} was already ${approval.status}.`);
    }
    if (approval.decision.requiresConfirmationPhrase && options.confirmationPhrase?.trim() !== CONFIRMATION_PHRASE) {
      throw new Error(`This action needs the confirmation phrase "${CONFIRMATION_PHRASE}".`);
    }
    // The call row carries the original input, so an approval survives a Core restart.
    const pending = this.getCallRow(row.tool_call_id);
    if (!pending) {
      throw new Error('The original request is no longer available. Ask Jarvis to try again.');
    }

    let createdRuleId: string | undefined;
    if (options.remember && this.onApprovalRule) {
      createdRuleId = this.onApprovalRule({
        toolPattern: approval.toolId,
        targetPattern: approval.target,
        maxRiskLevel: approval.riskLevel,
      }).id;
    }

    this.resolveApproval(approvalId, 'approved', createdRuleId);
    this.bus.emit('approval.resolved', {
      ...approval,
      status: 'approved',
      resolvedAt: new Date().toISOString(),
      createdRuleId,
    });

    const running: ToolCallRecord = {
      ...toRecord(pending),
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.updateCall(running);
    return await this.run(running, {
      taskId: pending.task_id ?? undefined,
      conversationId: pending.conversation_id ?? undefined,
    });
  }

  async deny(approvalId: string, reason?: string): Promise<ToolCallRecord> {
    const row = this.getApprovalRow(approvalId);
    const approval = toApproval(row);
    if (approval.status !== 'pending') {
      throw new Error(`Approval ${approvalId} was already ${approval.status}.`);
    }
    this.resolveApproval(approvalId, 'denied');
    this.bus.emit('approval.resolved', { ...approval, status: 'denied', resolvedAt: new Date().toISOString() });

    const callRow = this.getCallRow(row.tool_call_id);
    if (!callRow) throw new Error(`Tool call ${row.tool_call_id} is missing.`);
    const record = toRecord(callRow);
    const denied: ToolCallRecord = {
      ...record,
      status: 'denied',
      finishedAt: new Date().toISOString(),
      result: { ok: false, error: reason ?? 'You denied this action.', summary: `Denied: ${record.intent.summary}` },
    };
    this.updateCall(denied);
    this.appendAudit(denied, 'denied', 0, {
      taskId: callRow.task_id ?? undefined,
      conversationId: callRow.conversation_id ?? undefined,
    });
    this.bus.emit('tool.call.changed', denied);
    return denied;
  }

  listCalls(limit = 100): ToolCallRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tool_calls ORDER BY started_at DESC LIMIT ?')
      .all(Math.min(limit, 500)) as ToolCallRow[];
    return rows.map(toRecord);
  }

  private async run(record: ToolCallRecord, options: ToolCallOptions): Promise<ToolCallRecord> {
    // A skill server's tools disappear when it is switched off, which can happen while one
    // of its calls sits in the approval queue: fail that call instead of throwing, or it
    // stays `running` forever with nothing left to finish it.
    const tool = this.registry.get(record.toolId);
    if (!tool) {
      const gone: ToolCallRecord = {
        ...record,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        result: {
          ok: false,
          error: `The tool "${record.toolId}" is no longer available. Its skill server may have been switched off.`,
          summary: `Unavailable: ${record.intent.summary}`,
        },
      };
      this.updateCall(gone);
      this.appendAudit(gone, 'failed', 0, options);
      this.bus.emit('tool.call.changed', gone);
      return gone;
    }
    const startedAt = Date.now();
    this.bus.emit('tool.call.changed', record);
    let result: ToolResult;
    try {
      result = await tool.execute(record.input as never, {
        callId: record.id,
        taskId: options.taskId,
        conversationId: options.conversationId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { ok: false, error: message, summary: `Failed: ${record.intent.summary}` };
    }
    const finished: ToolCallRecord = {
      ...record,
      status: result.ok ? 'succeeded' : 'failed',
      finishedAt: new Date().toISOString(),
      result,
    };
    this.updateCall(finished);
    this.appendAudit(finished, result.ok ? 'succeeded' : 'failed', Date.now() - startedAt, options);
    this.bus.emit('tool.call.changed', finished);
    return finished;
  }

  private appendAudit(
    record: ToolCallRecord,
    result: AuditEvent['result'],
    durationMs: number,
    options: ToolCallOptions,
  ): void {
    const event = this.audit.append({
      toolId: record.toolId,
      action: record.action,
      target: record.intent.target,
      riskLevel: record.decision.riskLevel,
      permission: record.decision.effect,
      permissionReason: record.decision.reason,
      result,
      reversible: record.intent.reversible,
      durationMs,
      detail: record.result?.error ?? record.result?.summary,
      taskId: options.taskId,
      conversationId: options.conversationId,
    });
    this.bus.emit('audit.appended', event);
  }

  private insertCall(record: ToolCallRecord, options: ToolCallOptions): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls
          (id, tool_id, action, input_json, intent_json, decision_json, status, result_json, task_id, conversation_id, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
      )
      .run(
        record.id,
        record.toolId,
        record.action,
        JSON.stringify(record.input),
        JSON.stringify(record.intent),
        JSON.stringify(record.decision),
        record.status,
        options.taskId ?? null,
        options.conversationId ?? null,
        record.startedAt,
      );
  }

  private updateCall(record: ToolCallRecord): void {
    this.db
      .prepare('UPDATE tool_calls SET status = ?, result_json = ?, finished_at = ? WHERE id = ?')
      .run(record.status, record.result ? JSON.stringify(record.result) : null, record.finishedAt ?? null, record.id);
  }

  private getCallRow(id: string): ToolCallRow | undefined {
    return this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as ToolCallRow | undefined;
  }

  private insertApproval(approval: ApprovalRequest, toolCallId: string): void {
    const { decision, ...request } = approval;
    this.db
      .prepare(
        `INSERT INTO approvals (id, tool_call_id, request_json, decision_json, status, created_rule_id, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(approval.id, toolCallId, JSON.stringify(request), JSON.stringify(decision), approval.status, approval.createdAt);
  }

  private resolveApproval(id: string, status: ApprovalRequest['status'], createdRuleId?: string): void {
    this.db
      .prepare('UPDATE approvals SET status = ?, resolved_at = ?, created_rule_id = ? WHERE id = ?')
      .run(status, new Date().toISOString(), createdRuleId ?? null, id);
  }

  private getApprovalRow(id: string): ApprovalRow {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
    if (!row) throw new Error(`Unknown approval: ${id}`);
    return row;
  }
}

function toRecord(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    toolId: row.tool_id,
    action: row.action,
    input: JSON.parse(row.input_json) as unknown,
    intent: JSON.parse(row.intent_json) as ToolCallRecord['intent'],
    decision: JSON.parse(row.decision_json) as ToolCallRecord['decision'],
    status: row.status as ToolCallRecord['status'],
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    result: row.result_json ? (JSON.parse(row.result_json) as ToolResult) : undefined,
  };
}

function toApproval(row: ApprovalRow): ApprovalRequest {
  const request = JSON.parse(row.request_json) as Omit<ApprovalRequest, 'decision' | 'status'>;
  return {
    ...request,
    decision: JSON.parse(row.decision_json) as ApprovalRequest['decision'],
    status: row.status as ApprovalRequest['status'],
    createdRuleId: row.created_rule_id ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
  };
}
