import type {
  PermissionContext,
  PermissionDecision,
  PermissionEffect,
  PermissionRequest,
  PermissionRule,
  RiskLevel,
} from '@jarvis/types';
import { RISK_DESCRIPTIONS, RISK_LABELS } from '@jarvis/types';
import { PERMISSION_PROFILES } from './profiles.js';
import { evaluatePath, normalizePath } from './paths.js';

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const namespace = pattern.slice(0, -2);
    return value === namespace || value.startsWith(`${namespace}.`);
  }
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(value);
  }
  return pattern === value;
}

function ruleApplies(rule: PermissionRule, request: PermissionRequest, now: Date): boolean {
  if (rule.expiresAt && new Date(rule.expiresAt).getTime() <= now.getTime()) return false;
  if (!patternMatches(rule.toolPattern, request.toolId)) return false;
  if (rule.targetPattern) {
    const target = request.target ? normalizePath(request.target) : '';
    if (!target) return false;
    if (!patternMatches(normalizePath(rule.targetPattern), target)) return false;
  }
  return true;
}

/**
 * The single gate every tool call passes through. Decisions are computed from
 * profile + rules + path scopes in code; no model output can influence them.
 */
export class PermissionEngine {
  constructor(private context: PermissionContext) {}

  getContext(): PermissionContext {
    return this.context;
  }

  setContext(context: PermissionContext): void {
    this.context = context;
  }

  evaluate(request: PermissionRequest, now: Date = new Date()): PermissionDecision {
    const profile = PERMISSION_PROFILES[this.context.profile];
    const riskLevel = request.riskLevel;

    for (const entry of request.paths ?? []) {
      const verdict = evaluatePath(this.context.scopes, entry.path, entry.mode);
      if (!verdict.allowed) {
        return {
          effect: 'deny',
          riskLevel,
          reason: verdict.reason,
          explanation: explainScopeDenial(verdict.reason, entry.path, entry.mode),
          requiresConfirmationPhrase: false,
        };
      }
    }

    const baseEffect: PermissionEffect = profile.effects[riskLevel];
    const rule = this.context.rules.find((candidate) => ruleApplies(candidate, request, now));

    let effect = baseEffect;
    let reason = `profile:${profile.id}`;
    let matchedRuleId: string | undefined;

    if (rule) {
      matchedRuleId = rule.id;
      if (rule.effect === 'deny') {
        effect = 'deny';
        reason = `rule:${rule.id}`;
      } else if (riskLevel <= rule.maxRiskLevel) {
        // A rule may relax or tighten, but never past its own risk ceiling.
        effect = rule.effect;
        reason = `rule:${rule.id}`;
      } else {
        effect = escalate(baseEffect);
        reason = `rule:${rule.id}:risk-ceiling`;
      }
    }

    if (profile.effects[riskLevel] === 'deny' && effect === 'allow' && riskLevel >= 4) {
      // Level 4 is never auto-allowed by a stored rule.
      effect = 'deny';
      reason = `profile:${profile.id}:critical-floor`;
    }

    return {
      effect,
      riskLevel,
      reason,
      explanation: explain(effect, riskLevel, profile.name, request),
      requiresConfirmationPhrase:
        effect !== 'deny' && riskLevel >= profile.requireConfirmationPhraseAtOrAbove,
      matchedRuleId,
    };
  }
}

function escalate(effect: PermissionEffect): PermissionEffect {
  return effect === 'allow' ? 'ask' : effect;
}

function explainScopeDenial(reason: string, path: string, mode: 'read' | 'read-write'): string {
  switch (reason) {
    case 'scope:suspicious-path':
      return `The path "${path}" uses traversal or a device path, which Jarvis never accepts.`;
    case 'scope:deny':
      return `"${path}" is inside a folder you blocked.`;
    case 'scope:read-only':
      return `"${path}" is in a read-only folder, and this action needs write access.`;
    default:
      return `"${path}" is not inside any folder you allowed. Grant ${
        mode === 'read-write' ? 'read/write' : 'read'
      } access to it on the Permissions page first.`;
  }
}

function explain(
  effect: PermissionEffect,
  riskLevel: RiskLevel,
  profileName: string,
  request: PermissionRequest,
): string {
  const risk = `${RISK_LABELS[riskLevel]} (level ${riskLevel})`;
  const reversible = request.reversible ? 'This can be undone.' : 'This cannot be undone.';
  switch (effect) {
    case 'allow':
      return `Allowed automatically: ${risk} action under the ${profileName} profile. ${RISK_DESCRIPTIONS[riskLevel]}`;
    case 'ask':
      return `Needs your approval: ${risk}. ${request.summary} ${reversible}`;
    case 'deny':
      return `Blocked by the ${profileName} profile: ${risk}. ${RISK_DESCRIPTIONS[riskLevel]}`;
  }
}
