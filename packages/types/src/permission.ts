import type { RiskLevel } from './risk.js';

/** Permission profiles shipped in the MVP (spec ss35). `Open` is intentionally not built yet. */
export type PermissionProfileId = 'locked' | 'balanced';

export type PermissionEffect = 'allow' | 'ask' | 'deny';

export interface PermissionProfile {
  id: PermissionProfileId;
  name: string;
  description: string;
  /** Effect applied for each risk level before rule overrides. */
  effects: Record<RiskLevel, PermissionEffect>;
  /** Level 4 always needs a typed confirmation phrase in addition to approval. */
  requireConfirmationPhraseAtOrAbove: RiskLevel;
}

/** A persisted user decision that overrides the profile default. */
export interface PermissionRule {
  id: string;
  /** Tool id, or a tool namespace such as `filesystem.*`. */
  toolPattern: string;
  /** Optional path/target glob the rule is limited to. */
  targetPattern?: string;
  effect: PermissionEffect;
  /** Rules never widen beyond this risk level. */
  maxRiskLevel: RiskLevel;
  createdAt: string;
  expiresAt?: string;
  note?: string;
}

/** A filesystem scope the user explicitly granted or blocked. */
export interface PathScope {
  id: string;
  /** Absolute path root. Children inherit unless a deny scope is more specific. */
  path: string;
  mode: 'read' | 'read-write';
  effect: 'allow' | 'deny';
  createdAt: string;
}

export interface PermissionContext {
  profile: PermissionProfileId;
  rules: readonly PermissionRule[];
  scopes: readonly PathScope[];
}

export interface PermissionRequest {
  toolId: string;
  action: string;
  /** Plain-language description shown to the user. */
  summary: string;
  target?: string;
  /** Paths the call will touch, with the access each one needs. */
  paths?: readonly { path: string; mode: 'read' | 'read-write' }[];
  riskLevel: RiskLevel;
  reversible: boolean;
  taskId?: string;
  conversationId?: string;
}

export interface PermissionDecision {
  effect: PermissionEffect;
  riskLevel: RiskLevel;
  /** Machine-readable reason, e.g. `profile:balanced`, `rule:<id>`, `scope:deny`. */
  reason: string;
  /** Human-readable explanation surfaced in the approval dialog and audit log. */
  explanation: string;
  requiresConfirmationPhrase: boolean;
  matchedRuleId?: string;
}

export interface ApprovalRequest extends PermissionRequest {
  id: string;
  createdAt: string;
  decision: PermissionDecision;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  resolvedAt?: string;
  /** Set when the user chose "always allow this" in the approval dialog. */
  createdRuleId?: string;
}
