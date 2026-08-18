import type { AuditEvent, AuditQuery } from '@jarvis/types';
import { isRiskLevel, RiskLevel } from '@jarvis/types';
import type { JarvisDatabase } from '../db/database.js';

interface AuditRow {
  id: string;
  time: string;
  tool_id: string;
  action: string;
  target: string | null;
  risk_level: number;
  permission: string;
  permission_reason: string;
  result: string;
  reversible: number;
  duration_ms: number | null;
  detail: string | null;
  task_id: string | null;
  conversation_id: string | null;
}

function toEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    time: row.time,
    toolId: row.tool_id,
    action: row.action,
    target: row.target ?? undefined,
    riskLevel: isRiskLevel(row.risk_level) ? row.risk_level : RiskLevel.Safe,
    permission: row.permission as AuditEvent['permission'],
    permissionReason: row.permission_reason,
    result: row.result as AuditEvent['result'],
    reversible: row.reversible === 1,
    durationMs: row.duration_ms ?? undefined,
    detail: row.detail ?? undefined,
    taskId: row.task_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
  };
}

export class AuditStore {
  constructor(private readonly db: JarvisDatabase) {}

  append(event: Omit<AuditEvent, 'id' | 'time'> & { id?: string; time?: string }): AuditEvent {
    const record: AuditEvent = {
      ...event,
      id: event.id ?? crypto.randomUUID(),
      time: event.time ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO audit_events
          (id, time, tool_id, action, target, risk_level, permission, permission_reason, result, reversible, duration_ms, detail, task_id, conversation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.time,
        record.toolId,
        record.action,
        record.target ?? null,
        record.riskLevel,
        record.permission,
        record.permissionReason,
        record.result,
        record.reversible ? 1 : 0,
        record.durationMs ?? null,
        record.detail ?? null,
        record.taskId ?? null,
        record.conversationId ?? null,
      );
    return record;
  }

  query(query: AuditQuery = {}): AuditEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.toolId) {
      where.push('tool_id = ?');
      params.push(query.toolId);
    }
    if (query.result) {
      where.push('result = ?');
      params.push(query.result);
    }
    if (query.permission) {
      where.push('permission = ?');
      params.push(query.permission);
    }
    if (query.minRiskLevel !== undefined) {
      where.push('risk_level >= ?');
      params.push(query.minRiskLevel);
    }
    if (query.since) {
      where.push('time >= ?');
      params.push(query.since);
    }
    if (query.until) {
      where.push('time <= ?');
      params.push(query.until);
    }
    if (query.search) {
      where.push('(target LIKE ? OR detail LIKE ? OR action LIKE ?)');
      const like = `%${query.search}%`;
      params.push(like, like, like);
    }
    const limit = Math.min(query.limit ?? 200, 1_000);
    const offset = query.offset ?? 0;
    const sql = `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY time DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as AuditRow[];
    return rows.map(toEvent);
  }
}
