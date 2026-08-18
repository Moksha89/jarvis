import type {
  JarvisTool,
  ModelRuntimeAdapter,
  Plan,
  WorkflowStepInput,
} from '@jarvis/types';
import { PLAN_LIMITS } from '@jarvis/types';
import type { ToolRegistry } from '@jarvis/tools';

export const PLANNER_SYSTEM_PROMPT = `You plan work for Jarvis, a local Windows assistant.

The user tells you what they want in their own words. Reply with the ordered steps that
carry it out, as JSON and nothing else, in this shape:

{"summary":"one line about the approach","steps":[
  {"title":"short title","tool":"filesystem.read","input":{"path":"C:\\\\notes\\\\a.txt"}},
  {"title":"short title","prompt":"what the model should do with {{step1}}","mode":"agent"}
]}

Rules:
- Use a "tool" step only for a tool listed below, with arguments its schema accepts.
- Use a "prompt" step when judgement, writing or reading of an earlier result is needed.
  Its "mode" is "agent" when the model may use tools itself, otherwise "ask".
- A later step reads earlier output with {{input}}, {{step1}}, {{step2}} or {{previous}}.
- Keep it to the fewest steps that finish the job, at most ${PLAN_LIMITS.maxSteps}.
- Never invent file names, paths or commands the user did not give you. When a detail is
  missing, plan a step that finds it out instead of guessing.
- Output the JSON object only: no prose, no code fences, no explanation.`;

export interface PlannerOptions {
  runtime: ModelRuntimeAdapter;
  registry: ToolRegistry;
}

/** What the model is expected to answer with; every field is checked before use. */
interface RawPlan {
  summary?: unknown;
  steps?: unknown;
}

/**
 * Turns a sentence into an ordered plan, so the user never has to build a workflow by
 * hand. The planner only decides *what* to attempt: every step is still run by the
 * workflow runner through `ToolExecutor`, so scopes, risk levels, approvals and the
 * audit log apply to a planned step exactly as to one a person wrote.
 */
export class Planner {
  constructor(private readonly options: PlannerOptions) {}

  async plan(goal: string, model: string, signal?: AbortSignal): Promise<Plan> {
    const trimmed = goal.trim().slice(0, PLAN_LIMITS.maxGoalChars);
    if (!trimmed) throw new Error('Tell Jarvis what you want done.');

    let text = '';
    for await (const chunk of this.options.runtime.streamChat(
      {
        model,
        messages: [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user', content: `${this.catalog()}\n\nWhat I want: ${trimmed}` },
        ],
      },
      signal,
    )) {
      if (chunk.type === 'delta') text += chunk.text;
    }

    const raw = parsePlan(text);
    const notes: string[] = [];
    const steps = raw ? this.validateSteps(raw.steps, notes) : [];

    if (steps.length === 0) {
      // The model gave nothing usable. Working on the goal directly is better than
      // refusing: an agent step is the same loop chat mode uses, with the same gates.
      notes.push(
        raw
          ? 'None of the planned steps could be used, so Jarvis works on this as one agent step.'
          : 'The model did not return a plan, so Jarvis works on this as one agent step.',
      );
      return {
        goal: trimmed,
        summary: 'Work on the request directly, deciding each step while running.',
        steps: [{ kind: 'prompt', title: firstWords(trimmed), prompt: trimmed, mode: 'agent', maxSteps: 8 }],
        notes,
        model,
        fallback: true,
      };
    }

    return {
      goal: trimmed,
      summary: typeof raw?.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 500) : firstWords(trimmed),
      steps,
      notes,
      model,
      fallback: false,
    };
  }

  /** Every step the model proposed that Jarvis can actually run, in order. */
  private validateSteps(value: unknown, notes: string[]): WorkflowStepInput[] {
    if (!Array.isArray(value)) return [];
    const steps: WorkflowStepInput[] = [];

    for (const entry of value) {
      if (steps.length >= PLAN_LIMITS.maxSteps) {
        notes.push(`Only the first ${PLAN_LIMITS.maxSteps} steps are kept.`);
        break;
      }
      if (!isRecord(entry)) continue;
      const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim().slice(0, 120) : undefined;
      const toolId = typeof entry.tool === 'string' ? entry.tool.trim() : '';

      if (toolId) {
        if (!this.options.registry.get(toolId)) {
          notes.push(`Skipped a step that wanted "${toolId}", which is not a tool Jarvis has.`);
          continue;
        }
        if (entry.input !== undefined && !isRecord(entry.input)) {
          notes.push(`Skipped a "${toolId}" step whose arguments were not an object.`);
          continue;
        }
        steps.push({
          kind: 'tool',
          title: title ?? toolId,
          toolId,
          input: isRecord(entry.input) ? entry.input : {},
        });
        continue;
      }

      const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
      if (!prompt) continue;
      steps.push({
        kind: 'prompt',
        title: title ?? firstWords(prompt),
        prompt,
        mode: entry.mode === 'ask' ? 'ask' : 'agent',
        maxSteps: 6,
      });
    }

    return steps;
  }

  /** The tools the planner may choose from, with the arguments each one takes. */
  private catalog(): string {
    const lines = this.options.registry.list().map((tool) => `- ${tool.id}(${parameters(tool)}): ${tool.description}`);
    return `Tools you may use:\n${lines.join('\n')}`;
  }
}

function parameters(tool: JarvisTool): string {
  return Object.entries(tool.inputSchema.properties)
    .map(([name, schema]) => `${name}${tool.inputSchema.required.includes(name) ? '' : '?'}: ${schema.type}`)
    .join(', ');
}

/**
 * Reads the plan out of whatever the model wrote. Small local models like to wrap JSON
 * in prose or a code fence, so the outermost braces are used rather than the whole reply.
 */
function parsePlan(text: string): RawPlan | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return isRecord(parsed) ? (parsed as RawPlan) : undefined;
  } catch {
    return undefined;
  }
}

function firstWords(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim().length > 0) ?? 'Plan';
  return line.trim().slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
