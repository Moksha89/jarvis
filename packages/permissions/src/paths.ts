import type { PathScope } from '@jarvis/types';

/** Normalise a path for comparison: forward slashes, no trailing slash, case-folded (Windows). */
export function normalizePath(input: string): string {
  const unified = input.replace(/\\/g, '/').replace(/\/+$/g, '');
  return unified.toLowerCase();
}

export function isWithin(parent: string, child: string): boolean {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/** Reject traversal and UNC/device paths outright; they defeat scope containment. */
export function isSuspiciousPath(input: string): boolean {
  const unified = input.replace(/\\/g, '/');
  if (unified.includes('/../') || unified.endsWith('/..') || unified.startsWith('../')) return true;
  // Covers UNC (\\server\share) and device paths (\\?\C:\...) once backslashes are unified.
  if (unified.startsWith('//')) return true;
  return false;
}

export interface ScopeVerdict {
  allowed: boolean;
  reason: string;
  matchedScopeId?: string;
}

/**
 * A path is allowed only when the most specific matching scope allows it.
 * Absence of any matching scope is a denial: scopes are opt-in, never implicit.
 */
export function evaluatePath(
  scopes: readonly PathScope[],
  path: string,
  mode: 'read' | 'read-write',
): ScopeVerdict {
  if (isSuspiciousPath(path)) {
    return { allowed: false, reason: 'scope:suspicious-path' };
  }
  const matches = scopes
    .filter((scope) => isWithin(scope.path, path))
    .sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length);

  const best = matches[0];
  if (!best) {
    return { allowed: false, reason: 'scope:none' };
  }
  if (best.effect === 'deny') {
    return { allowed: false, reason: 'scope:deny', matchedScopeId: best.id };
  }
  if (mode === 'read-write' && best.mode === 'read') {
    return { allowed: false, reason: 'scope:read-only', matchedScopeId: best.id };
  }
  return { allowed: true, reason: 'scope:allow', matchedScopeId: best.id };
}
