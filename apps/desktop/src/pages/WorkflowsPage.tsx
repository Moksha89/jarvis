import { useState } from 'react';
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Caption1,
  Dropdown,
  Input,
  Label,
  MessageBar,
  MessageBarBody,
  Option,
  Subtitle2,
  Switch,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type {
  Workflow,
  WorkflowInput,
  WorkflowRunStatus,
  WorkflowStepInput,
  WorkflowStepKind,
} from '@jarvis/types';
import { TASK_LIMITS, WORKFLOW_LIMITS } from '@jarvis/types';
import { StatusBadge, jarvisSpacing } from '@jarvis/ui';
import type { StatusTone } from '@jarvis/ui';
import { PageHeader } from '../components/PageHeader.js';
import { useTools, useWorkflowActions, useWorkflowRuns, useWorkflows } from '../queries.js';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s, marginBottom: jarvisSpacing.l },
  form: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s, padding: jarvisSpacing.m },
  card: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs, padding: jarvisSpacing.m },
  row: { display: 'flex', gap: jarvisSpacing.s, flexWrap: 'wrap', alignItems: 'flex-end' },
  field: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs, minWidth: '180px' },
  grow: { flex: 1, minWidth: '240px' },
  step: {
    display: 'flex',
    flexDirection: 'column',
    gap: jarvisSpacing.xs,
    padding: jarvisSpacing.s,
    borderLeft: `2px solid ${tokens.colorNeutralStroke1}`,
  },
  meta: { color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  actions: { display: 'flex', gap: jarvisSpacing.xs, flexWrap: 'wrap', alignItems: 'center' },
  runs: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs },
});

const RUN_TONE: Record<WorkflowRunStatus, StatusTone> = {
  running: 'info',
  succeeded: 'ok',
  failed: 'error',
  cancelled: 'neutral',
};

const EMPTY_STEP: WorkflowStepInput = { kind: 'tool', title: '', toolId: '', input: {} };

const EMPTY_DRAFT: WorkflowInput = { name: '', description: '', steps: [EMPTY_STEP] };

/**
 * A workflow is a fixed recipe: the steps and their order are the user's, not the
 * model's. Tool steps still go through the permission engine, so a workflow can ask
 * for approval mid-run exactly like chat does.
 */
export function WorkflowsPage() {
  const styles = useStyles();
  const workflows = useWorkflows();
  const runs = useWorkflowRuns();
  const tools = useTools();
  const actions = useWorkflowActions();
  const [draft, setDraft] = useState<WorkflowInput>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runInput, setRunInput] = useState<Record<string, string>>({});
  const [jsonError, setJsonError] = useState<string | null>(null);

  const error =
    jsonError ??
    (actions.create.error ??
      actions.update.error ??
      actions.runNow.error ??
      actions.cancelRun.error ??
      actions.remove.error ??
      null);
  const steps = draft.steps as WorkflowStepInput[];

  const setSteps = (next: WorkflowStepInput[]) => setDraft({ ...draft, steps: next });
  const patchStep = (index: number, patch: Partial<WorkflowStepInput>) =>
    setSteps(steps.map((step, position) => (position === index ? { ...step, ...patch } : step)));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved as WorkflowStepInput);
    setSteps(next);
  };

  const reset = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setJsonError(null);
  };

  const submit = () => {
    setJsonError(null);
    if (editingId) {
      actions.update.mutate({ id: editingId, input: draft }, { onSuccess: reset });
      return;
    }
    actions.create.mutate(draft, { onSuccess: reset });
  };

  const edit = (workflow: Workflow) => {
    setEditingId(workflow.id);
    setJsonError(null);
    setDraft({
      name: workflow.name,
      description: workflow.description ?? '',
      model: workflow.model,
      steps: workflow.steps.map((step) => ({
        kind: step.kind,
        title: step.title,
        toolId: step.toolId,
        input: step.input,
        prompt: step.prompt,
        mode: step.mode,
        maxSteps: step.maxSteps,
        continueOnError: step.continueOnError,
      })),
    });
  };

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Build a recipe out of tool and prompt steps. Jarvis runs the steps in order, and every tool step goes through the same permission checks as chat."
      />

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{typeof error === 'string' ? error : (error as Error).message}</MessageBarBody>
        </MessageBar>
      ) : null}

      <Card className={styles.form}>
        <CardHeader header={<Subtitle2>{editingId ? 'Edit workflow' : 'New workflow'}</Subtitle2>} />
        <div className={styles.field}>
          <Label htmlFor="workflow-name">Name</Label>
          <Input
            id="workflow-name"
            value={draft.name}
            placeholder="Tidy my Downloads folder"
            onChange={(_, data) => setDraft({ ...draft, name: data.value })}
          />
        </div>
        <div className={styles.field}>
          <Label htmlFor="workflow-description">What it does (optional)</Label>
          <Input
            id="workflow-description"
            value={draft.description ?? ''}
            onChange={(_, data) => setDraft({ ...draft, description: data.value })}
          />
        </div>

        {steps.map((step, index) => (
          <div className={styles.step} key={index}>
            <div className={styles.row}>
              <Subtitle2>{`Step ${String(index + 1)}`}</Subtitle2>
              <Dropdown
                value={step.kind === 'tool' ? 'Run a tool' : 'Ask the model'}
                selectedOptions={[step.kind]}
                onOptionSelect={(_, data) =>
                  patchStep(index, { kind: ((data.optionValue as WorkflowStepKind | undefined) ?? 'tool') })
                }
              >
                <Option value="tool">Run a tool</Option>
                <Option value="prompt">Ask the model</Option>
              </Dropdown>
              <Button size="small" onClick={() => move(index, -1)} disabled={index === 0}>
                Up
              </Button>
              <Button size="small" onClick={() => move(index, 1)} disabled={index === steps.length - 1}>
                Down
              </Button>
              <Button
                size="small"
                appearance="subtle"
                disabled={steps.length === 1}
                onClick={() => setSteps(steps.filter((_, position) => position !== index))}
              >
                Remove
              </Button>
            </div>
            <div className={styles.field}>
              <Label>Title</Label>
              <Input
                value={step.title}
                placeholder="List the downloads"
                onChange={(_, data) => patchStep(index, { title: data.value })}
              />
            </div>
            {step.kind === 'tool' ? (
              <>
                <div className={styles.field}>
                  <Label>Tool</Label>
                  <Dropdown
                    value={step.toolId ?? ''}
                    selectedOptions={step.toolId ? [step.toolId] : []}
                    onOptionSelect={(_, data) => patchStep(index, { toolId: data.optionValue })}
                  >
                    {(tools.data ?? []).map((tool) => (
                      <Option key={tool.id} value={tool.id} text={tool.id}>
                        {`${tool.id} — ${tool.name}`}
                      </Option>
                    ))}
                  </Dropdown>
                </div>
                <div className={styles.field}>
                  <Label>Tool input (JSON)</Label>
                  <Textarea
                    value={JSON.stringify(step.input ?? {}, null, 2)}
                    onChange={(_, data) => {
                      try {
                        const parsed: unknown = JSON.parse(data.value === '' ? '{}' : data.value);
                        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                          setJsonError('Tool input must be a JSON object.');
                          return;
                        }
                        setJsonError(null);
                        patchStep(index, { input: parsed as Record<string, unknown> });
                      } catch {
                        setJsonError('That tool input is not valid JSON yet.');
                      }
                    }}
                  />
                  <Caption1 className={styles.meta}>
                    {'Use {{input}} for what you type when you run it, {{step1}} for an earlier step\'s output, {{previous}} for the step before.'}
                  </Caption1>
                </div>
              </>
            ) : (
              <>
                <div className={styles.field}>
                  <Label>Prompt</Label>
                  <Textarea
                    value={step.prompt ?? ''}
                    placeholder="Summarise {{previous}} in three bullet points."
                    onChange={(_, data) => patchStep(index, { prompt: data.value })}
                  />
                </div>
                <div className={styles.row}>
                  <div className={styles.field}>
                    <Label>Mode</Label>
                    <Dropdown
                      value={step.mode === 'agent' ? 'Agent (uses tools)' : 'Ask (answer only)'}
                      selectedOptions={[step.mode ?? 'ask']}
                      onOptionSelect={(_, data) =>
                        patchStep(index, { mode: data.optionValue === 'agent' ? 'agent' : 'ask' })
                      }
                    >
                      <Option value="ask">Ask (answer only)</Option>
                      <Option value="agent">Agent (uses tools)</Option>
                    </Dropdown>
                  </div>
                  <div className={styles.field}>
                    <Label>{`Step budget (max ${String(TASK_LIMITS.maxSteps)})`}</Label>
                    <Input
                      type="number"
                      min={1}
                      max={TASK_LIMITS.maxSteps}
                      value={String(step.maxSteps ?? 4)}
                      onChange={(_, data) => patchStep(index, { maxSteps: Number(data.value) || 1 })}
                    />
                  </div>
                </div>
              </>
            )}
            <Switch
              checked={step.continueOnError === true}
              label="Keep going if this step fails"
              onChange={(_, data) => patchStep(index, { continueOnError: data.checked })}
            />
          </div>
        ))}

        <div className={styles.actions}>
          <Button
            disabled={steps.length >= WORKFLOW_LIMITS.maxSteps}
            onClick={() => setSteps([...steps, { ...EMPTY_STEP }])}
          >
            Add step
          </Button>
          <Button appearance="primary" onClick={submit} disabled={actions.create.isPending || actions.update.isPending}>
            {editingId ? 'Save changes' : 'Create workflow'}
          </Button>
          {editingId ? <Button onClick={reset}>Cancel</Button> : null}
        </div>
      </Card>

      <div className={styles.section}>
        <Subtitle2>Workflows</Subtitle2>
        {(workflows.data ?? []).length === 0 ? (
          <Body1 className={styles.meta}>No workflows yet.</Body1>
        ) : (
          (workflows.data ?? []).map((workflow) => {
            const history = (runs.data ?? []).filter((run) => run.workflowId === workflow.id).slice(0, 3);
            const activeRun = history.find((run) => run.status === 'running');
            return (
              <Card key={workflow.id} className={styles.card}>
                <div className={styles.row}>
                  <Subtitle2>{workflow.name}</Subtitle2>
                  <StatusBadge
                    tone={workflow.running ? 'info' : workflow.enabled ? 'ok' : 'neutral'}
                    label={workflowState(workflow)}
                  />
                  <Switch
                    checked={workflow.enabled}
                    label="Enabled"
                    onChange={(_, data) => actions.setEnabled.mutate({ id: workflow.id, enabled: data.checked })}
                  />
                </div>
                {workflow.description ? <Body1>{workflow.description}</Body1> : null}
                <Caption1 className={styles.mono}>
                  {workflow.steps.map((step) => `${String(step.position)}. ${step.title}`).join('  ·  ')}
                </Caption1>
                <div className={styles.row}>
                  <Input
                    className={styles.grow}
                    value={runInput[workflow.id] ?? ''}
                    placeholder="Input for this run, available as {{input}}"
                    onChange={(_, data) => setRunInput({ ...runInput, [workflow.id]: data.value })}
                  />
                </div>
                <div className={styles.actions}>
                  <Button
                    size="small"
                    disabled={workflow.running || !workflow.enabled}
                    onClick={() =>
                      actions.runNow.mutate({ id: workflow.id, input: runInput[workflow.id]?.trim() || undefined })
                    }
                  >
                    Run now
                  </Button>
                  <Button
                    size="small"
                    disabled={!activeRun}
                    onClick={() => activeRun && actions.cancelRun.mutate(activeRun.id)}
                  >
                    Stop
                  </Button>
                  <Button size="small" onClick={() => edit(workflow)}>
                    Edit
                  </Button>
                  <Button size="small" onClick={() => actions.remove.mutate(workflow.id)}>
                    Delete
                  </Button>
                </div>
                <div className={styles.runs}>
                  {history.length === 0 ? (
                    <Body1 className={styles.meta}>No runs yet.</Body1>
                  ) : (
                    history.map((run) => (
                      <div key={run.id} className={styles.runs}>
                        <div className={styles.row}>
                          <StatusBadge tone={RUN_TONE[run.status]} label={run.status} />
                          <Caption1 className={styles.meta}>
                            {`${new Date(run.startedAt).toLocaleString()}${run.error ? ` · ${run.error}` : ''}`}
                          </Caption1>
                        </div>
                        {run.steps.map((step) => (
                          <Caption1 key={step.stepId} className={styles.mono}>
                            {`${String(step.position)}. ${step.title} — ${step.ok ? 'ok' : 'failed'}: ${
                              step.error ?? step.summary
                            }`}
                          </Caption1>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </Card>
            );
          })
        )}
      </div>
    </>
  );
}

function workflowState(workflow: Workflow): string {
  if (workflow.running) return 'Running';
  if (!workflow.enabled) return 'Paused';
  return workflow.lastRunStatus ?? 'Idle';
}
