import type { RiskLevel } from './risk.js';
import type { PermissionEffect } from './permission.js';

export type AuditResult = 'succeeded' | 'failed' | 'denied' | 'cancelled';

/** One immutable row per attempted tool action. Never contains secrets. */
export interface AuditEvent {
  id: string;
  /** ISO-8601 UTC. */
  time: string;
  toolId: string;
  action: string;
  target?: string;
  riskLevel: RiskLevel;
  permission: PermissionEffect;
  /** Why the permission engine reached that effect. */
  permissionReason: string;
  result: AuditResult;
  reversible: boolean;
  durationMs?: number;
  detail?: string;
  taskId?: string;
  conversationId?: string;
}

export interface AuditQuery {
  toolId?: string;
  result?: AuditResult;
  permission?: PermissionEffect;
  minRiskLevel?: RiskLevel;
  since?: string;
  until?: string;
  search?: string;
  limit?: number;
  offset?: number;
}
