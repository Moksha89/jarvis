/**
 * Risk model (master spec ss33-36).
 *
 * Level 0 SAFE      - observation only, no side effects.
 * Level 1 LOW       - reversible writes inside an allowed scope.
 * Level 2 MEDIUM    - recoverable destructive changes (Recycle Bin delete, move/rename)
 *                     and ordinary write commands.
 * Level 3 HIGH      - irreversible or system-affecting changes (permanent delete,
 *                     installers, service/registry changes, credential-bearing egress).
 * Level 4 CRITICAL  - system integrity and security boundary changes (disabling security
 *                     tooling, disk formatting, bulk credential access, mass deletion).
 */
export const RiskLevel = {
  Safe: 0,
  Low: 1,
  Medium: 2,
  High: 3,
  Critical: 4,
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const RISK_LEVELS: readonly RiskLevel[] = [0, 1, 2, 3, 4];

export const RISK_LABELS: Record<RiskLevel, string> = {
  0: 'Safe',
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Critical',
};

export const RISK_DESCRIPTIONS: Record<RiskLevel, string> = {
  0: 'Reads information only. Nothing on the computer changes.',
  1: 'Makes a small, reversible change inside a folder you allowed.',
  2: 'Changes or removes data, but the change can be recovered.',
  3: 'Makes a change that cannot be undone or affects the whole system.',
  4: 'Touches system integrity or security. Blocked unless you explicitly allow it.',
};

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4;
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return (a > b ? a : b) as RiskLevel;
}
