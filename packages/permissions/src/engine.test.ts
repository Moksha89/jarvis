import { describe, expect, it } from 'vitest';
import type { PathScope, PermissionContext, PermissionRequest } from '@jarvis/types';
import { PermissionEngine } from './engine.js';

const scopes: PathScope[] = [
  { id: 's1', path: 'C:/Users/me/Documents', mode: 'read-write', effect: 'allow', createdAt: '2026-01-01T00:00:00Z' },
  { id: 's2', path: 'C:/Users/me/Documents/private', mode: 'read', effect: 'deny', createdAt: '2026-01-01T00:00:00Z' },
  { id: 's3', path: 'C:/Users/me/Reference', mode: 'read', effect: 'allow', createdAt: '2026-01-01T00:00:00Z' },
];

function ctx(partial: Partial<PermissionContext> = {}): PermissionContext {
  return { profile: 'balanced', rules: [], scopes, ...partial };
}

function request(partial: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    toolId: 'filesystem.read',
    action: 'read',
    summary: 'Read a file',
    riskLevel: 0,
    reversible: true,
    ...partial,
  };
}

describe('PermissionEngine', () => {
  it('allows safe reads under Balanced', () => {
    const decision = new PermissionEngine(ctx()).evaluate(
      request({ paths: [{ path: 'C:/Users/me/Documents/a.txt', mode: 'read' }] }),
    );
    expect(decision.effect).toBe('allow');
  });

  it('asks for reversible writes under Locked but allows them under Balanced', () => {
    const write = request({
      toolId: 'filesystem.write',
      riskLevel: 1,
      paths: [{ path: 'C:/Users/me/Documents/a.txt', mode: 'read-write' }],
    });
    expect(new PermissionEngine(ctx({ profile: 'locked' })).evaluate(write).effect).toBe('ask');
    expect(new PermissionEngine(ctx()).evaluate(write).effect).toBe('allow');
  });

  it('denies paths outside every allowed scope', () => {
    const decision = new PermissionEngine(ctx()).evaluate(
      request({ paths: [{ path: 'C:/Windows/System32/drivers/etc/hosts', mode: 'read' }] }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('scope:none');
  });

  it('prefers the most specific scope, so a nested deny wins', () => {
    const decision = new PermissionEngine(ctx()).evaluate(
      request({ paths: [{ path: 'C:/Users/me/Documents/private/keys.txt', mode: 'read' }] }),
    );
    expect(decision.reason).toBe('scope:deny');
  });

  it('denies writes into a read-only scope', () => {
    const decision = new PermissionEngine(ctx()).evaluate(
      request({ toolId: 'filesystem.write', riskLevel: 1, paths: [{ path: 'C:/Users/me/Reference/a.txt', mode: 'read-write' }] }),
    );
    expect(decision.reason).toBe('scope:read-only');
  });

  it('rejects traversal before consulting scopes', () => {
    const decision = new PermissionEngine(ctx()).evaluate(
      request({ paths: [{ path: 'C:/Users/me/Documents/../../Windows/win.ini', mode: 'read' }] }),
    );
    expect(decision.reason).toBe('scope:suspicious-path');
  });

  it('never auto-allows level 4, even with a permissive rule', () => {
    const decision = new PermissionEngine(
      ctx({ rules: [{ id: 'r1', toolPattern: 'shell.*', effect: 'allow', maxRiskLevel: 4, createdAt: '2026-01-01T00:00:00Z' }] }),
    ).evaluate(request({ toolId: 'shell.run', riskLevel: 4, reversible: false }));
    expect(decision.effect).toBe('deny');
  });

  it('escalates to ask when a rule is used above its risk ceiling', () => {
    const decision = new PermissionEngine(
      ctx({ rules: [{ id: 'r2', toolPattern: 'shell.*', effect: 'allow', maxRiskLevel: 1, createdAt: '2026-01-01T00:00:00Z' }] }),
    ).evaluate(request({ toolId: 'shell.run', riskLevel: 2, reversible: true }));
    expect(decision.effect).toBe('ask');
    expect(decision.reason).toBe('rule:r2:risk-ceiling');
  });

  it('ignores expired rules', () => {
    const decision = new PermissionEngine(
      ctx({
        rules: [
          { id: 'r3', toolPattern: 'shell.*', effect: 'allow', maxRiskLevel: 3, createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z' },
        ],
      }),
    ).evaluate(request({ toolId: 'shell.run', riskLevel: 2, reversible: true }), new Date('2026-02-01T00:00:00Z'));
    expect(decision.reason).toBe('profile:balanced');
    expect(decision.effect).toBe('ask');
  });

  it('requires a confirmation phrase for high risk approvals', () => {
    const decision = new PermissionEngine(ctx()).evaluate(
      request({ toolId: 'shell.run', riskLevel: 3, reversible: false }),
    );
    expect(decision.effect).toBe('ask');
    expect(decision.requiresConfirmationPhrase).toBe(true);
  });
});
