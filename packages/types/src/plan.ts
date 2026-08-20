import type { WorkflowRun, WorkflowStepInput } from './workflow.js';

/**
 * A plan is what Jarvis works out for itself from a sentence the user typed: the
 * ordered steps it intends to take, before any of them run. It reuses the workflow
 * step shape, so a plan can be run by the workflow runner (and therefore through the
 * same scopes, risk levels, approvals and audit log) and edited afterwards like any
 * other recipe.
 */
export interface Plan {
  /** The user's own words, kept so the plan can be re-planned or explained. */
  goal: string;
  /** One line describing the approach, shown above the steps. */
  summary: string;
  steps: WorkflowStepInput[];
  /** What Jarvis had to change about the model's plan, e.g. a tool that does not exist. */
  notes: string[];
  model: string;
  /**
   * True when the model produced nothing usable and Jarvis fell back to a single
   * agent step. The goal still gets worked on; the steps just are not known upfront.
   */
  fallback: boolean;
}

export interface PlanRunStart {
  plan: Plan;
  /** The saved copy of the plan, so it can be inspected or edited on the Workflows page. */
  workflowId: string;
  run: WorkflowRun;
}

export const PLAN_LIMITS = {
  /** A plan is a short recipe: long jobs belong to an agent step inside it. */
  maxSteps: 8,
  maxGoalChars: 2_000,
  /** Plans Jarvis saved for itself, oldest pruned first so hand-made ones are safe. */
  maxKept: 20,
} as const;
