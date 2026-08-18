import type { PathScope, PermissionRule } from '@jarvis/types';
import { isRiskLevel, RiskLevel } from '@jarvis/types';
import type { JarvisDatabase } from '../db/database.js';

interface RuleRow {
  id: string;
  tool_pattern: string;
  target_pattern: string | null;
  effect: string;
  max_risk_level: number;
  note: string | null;
  created_at: string;
  expires_at: string | null;
}

interface ScopeRow {
  id: string;
  path: string;
  mode: string;
  effect: string;
  created_at: string;
}

export class PermissionStore {
  constructor(private readonly db: JarvisDatabase) {}

  listRules(): PermissionRule[] {
    const rows = this.db.prepare('SELECT * FROM permission_rules ORDER BY created_at DESC').all() as RuleRow[];
    return rows.map((row) => ({
      id: row.id,
      toolPattern: row.tool_pattern,
      targetPattern: row.target_pattern ?? undefined,
      effect: row.effect as PermissionRule['effect'],
      maxRiskLevel: isRiskLevel(row.max_risk_level) ? row.max_risk_level : RiskLevel.Safe,
      note: row.note ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    }));
  }

  addRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): PermissionRule {
    const created: PermissionRule = { ...rule, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO permission_rules (id, tool_pattern, target_pattern, effect, max_risk_level, note, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        created.id,
        created.toolPattern,
        created.targetPattern ?? null,
        created.effect,
        created.maxRiskLevel,
        created.note ?? null,
        created.createdAt,
        created.expiresAt ?? null,
      );
    return created;
  }

  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id);
  }

  listScopes(): PathScope[] {
    const rows = this.db.prepare('SELECT * FROM path_scopes ORDER BY path').all() as ScopeRow[];
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      mode: row.mode as PathScope['mode'],
      effect: row.effect as PathScope['effect'],
      createdAt: row.created_at,
    }));
  }

  addScope(scope: Omit<PathScope, 'id' | 'createdAt'>): PathScope {
    const created: PathScope = { ...scope, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO path_scopes (id, path, mode, effect, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(created.id, created.path, created.mode, created.effect, created.createdAt);
    return created;
  }

  deleteScope(id: string): void {
    this.db.prepare('DELETE FROM path_scopes WHERE id = ?').run(id);
  }
}
