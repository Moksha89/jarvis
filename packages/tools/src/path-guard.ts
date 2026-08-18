import type { PathScope } from '@jarvis/types';
import { evaluatePath } from '@jarvis/permissions';

/**
 * Re-checks scopes at execution time. The permission engine already evaluated the
 * request, but tools must not trust their caller: this is the second, in-code gate.
 */
export interface PathGuard {
  assert(path: string, mode: 'read' | 'read-write'): void;
}

export function createPathGuard(getScopes: () => readonly PathScope[]): PathGuard {
  return {
    assert(path, mode) {
      const verdict = evaluatePath(getScopes(), path, mode);
      if (!verdict.allowed) {
        throw new Error(`Path "${path}" is not permitted (${verdict.reason}).`);
      }
    },
  };
}
