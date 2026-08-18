import { useState } from 'react';
import {
  Body1,
  Button,
  Card,
  CardHeader,
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
import type { SavedTask, SavedTaskInput, ScheduleKind, TaskRunStatus, TaskSchedule } from '@jarvis/types';
import { TASK_LIMITS } from '@jarvis/types';
import { StatusBadge, TaskCard, jarvisSpacing } from '@jarvis/ui';
import type { StatusTone } from '@jarvis/ui';
import { PageHeader } from '../components/PageHeader.js';
import { useSavedTaskActions, useSavedTasks, useTaskRuns, useTasks } from '../queries.js';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s, marginBottom: jarvisSpacing.l },
  form: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s, padding: jarvisSpacing.m },
  row: { display: 'flex', gap: jarvisSpacing.s, flexWrap: 'wrap', alignItems: 'flex-end' },
  field: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs, minWidth: '180px' },
  taskCard: { padding: jarvisSpacing.m, display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs },
  meta: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: jarvisSpacing.xs, flexWrap: 'wrap' },
  runs: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs },
  empty: { color: tokens.colorNeutralForeground3 },
});

const RUN_TONE: Record<TaskRunStatus, StatusTone> = {
  running: 'info',
  succeeded: 'ok',
  failed: 'error',
  cancelled: 'neutral',
  skipped: 'neutral',
};

const EMPTY_DRAFT: SavedTaskInput = {
  name: '',
  prompt: '',
  mode: 'agent',
  maxSteps: 6,
  schedule: { kind: 'manual' },
};

export function TasksPage() {
  const styles = useStyles();
  const activity = useTasks();
  const saved = useSavedTasks();
  const runs = useTaskRuns();
  const actions = useSavedTaskActions();
  const [draft, setDraft] = useState<SavedTaskInput>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);

  const error =
    actions.create.error ?? actions.update.error ?? actions.runNow.error ?? actions.cancelRun.error ?? null;

  const submit = () => {
    if (editingId) {
      actions.update.mutate(
        { id: editingId, input: draft },
        {
          onSuccess: () => {
            setEditingId(null);
            setDraft(EMPTY_DRAFT);
          },
        },
      );
      return;
    }
    actions.create.mutate(draft, { onSuccess: () => setDraft(EMPTY_DRAFT) });
  };

  const edit = (task: SavedTask) => {
    setEditingId(task.id);
    setDraft({
      name: task.name,
      prompt: task.prompt,
      mode: task.mode,
      model: task.model,
      maxSteps: task.maxSteps,
      schedule: task.schedule,
    });
  };

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Save a prompt, run it now or on a schedule. Scheduled runs use the same permission gate as chat."
      />

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{(error as Error).message}</MessageBarBody>
        </MessageBar>
      ) : null}

      <Card className={styles.form}>
        <CardHeader header={<Subtitle2>{editingId ? 'Edit task' : 'New task'}</Subtitle2>} />
        <div className={styles.field}>
          <Label htmlFor="task-name">Name</Label>
          <Input
            id="task-name"
            value={draft.name}
            onChange={(_, data) => setDraft({ ...draft, name: data.value })}
            placeholder="Tidy my Downloads folder"
          />
        </div>
        <div className={styles.field}>
          <Label htmlFor="task-prompt">Prompt</Label>
          <Textarea
            id="task-prompt"
            value={draft.prompt}
            onChange={(_, data) => setDraft({ ...draft, prompt: data.value })}
            placeholder="List the files in C:\Users\me\Downloads and summarise what is safe to delete."
          />
        </div>
        <div className={styles.row}>
          <div className={styles.field}>
            <Label htmlFor="task-mode">Mode</Label>
            <Dropdown
              id="task-mode"
              value={draft.mode === 'agent' ? 'Agent (uses tools)' : 'Ask (answer only)'}
              selectedOptions={[draft.mode ?? 'ask']}
              onOptionSelect={(_, data) =>
                setDraft({ ...draft, mode: data.optionValue === 'agent' ? 'agent' : 'ask' })
              }
            >
              <Option value="ask">Ask (answer only)</Option>
              <Option value="agent">Agent (uses tools)</Option>
            </Dropdown>
          </div>
          <div className={styles.field}>
            <Label htmlFor="task-steps">{`Step budget (max ${TASK_LIMITS.maxSteps})`}</Label>
            <Input
              id="task-steps"
              type="number"
              min={1}
              max={TASK_LIMITS.maxSteps}
              value={String(draft.maxSteps ?? 6)}
              onChange={(_, data) => setDraft({ ...draft, maxSteps: Number(data.value) || 1 })}
            />
          </div>
          <div className={styles.field}>
            <Label htmlFor="task-schedule">Schedule</Label>
            <Dropdown
              id="task-schedule"
              value={scheduleLabel(draft.schedule.kind)}
              selectedOptions={[draft.schedule.kind]}
              onOptionSelect={(_, data) =>
                setDraft({ ...draft, schedule: scheduleFor((data.optionValue as ScheduleKind) ?? 'manual', draft.schedule) })
              }
            >
              <Option value="manual">Manual only</Option>
              <Option value="interval">Every N minutes</Option>
              <Option value="daily">Daily at a time</Option>
            </Dropdown>
          </div>
          {draft.schedule.kind === 'interval' ? (
            <div className={styles.field}>
              <Label htmlFor="task-interval">{`Minutes (min ${TASK_LIMITS.minIntervalMinutes})`}</Label>
              <Input
                id="task-interval"
                type="number"
                min={TASK_LIMITS.minIntervalMinutes}
                value={String(draft.schedule.intervalMinutes ?? TASK_LIMITS.minIntervalMinutes)}
                onChange={(_, data) =>
                  setDraft({
                    ...draft,
                    schedule: { kind: 'interval', intervalMinutes: Number(data.value) || 0 },
                  })
                }
              />
            </div>
          ) : null}
          {draft.schedule.kind === 'daily' ? (
            <div className={styles.field}>
              <Label htmlFor="task-daily">Time (HH:MM)</Label>
              <Input
                id="task-daily"
                type="time"
                value={draft.schedule.dailyTime ?? '09:00'}
                onChange={(_, data) => setDraft({ ...draft, schedule: { kind: 'daily', dailyTime: data.value } })}
              />
            </div>
          ) : null}
        </div>
        <div className={styles.actions}>
          <Button appearance="primary" onClick={submit} disabled={actions.create.isPending || actions.update.isPending}>
            {editingId ? 'Save changes' : 'Create task'}
          </Button>
          {editingId ? (
            <Button
              onClick={() => {
                setEditingId(null);
                setDraft(EMPTY_DRAFT);
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </Card>

      <div className={styles.section}>
        <Subtitle2>Saved tasks</Subtitle2>
        {(saved.data ?? []).length === 0 ? (
          <Body1 className={styles.empty}>No saved tasks yet.</Body1>
        ) : (
          (saved.data ?? []).map((task) => {
            const taskRuns = (runs.data ?? []).filter((run) => run.taskId === task.id).slice(0, 3);
            const activeRun = taskRuns.find((run) => run.status === 'running');
            return (
              <Card key={task.id} className={styles.taskCard}>
                <div className={styles.row}>
                  <Subtitle2>{task.name}</Subtitle2>
                  <StatusBadge tone={task.running ? 'info' : task.enabled ? 'ok' : 'neutral'} label={taskState(task)} />
                  <Switch
                    checked={task.enabled}
                    label="Enabled"
                    onChange={(_, data) => actions.setEnabled.mutate({ id: task.id, enabled: data.checked })}
                  />
                </div>
                <Body1>{task.prompt}</Body1>
                <Body1 className={styles.meta}>{describeSchedule(task)}</Body1>
                <div className={styles.actions}>
                  <Button size="small" onClick={() => actions.runNow.mutate(task.id)} disabled={task.running}>
                    Run now
                  </Button>
                  <Button
                    size="small"
                    onClick={() => activeRun && actions.cancelRun.mutate(activeRun.id)}
                    disabled={!activeRun}
                  >
                    Stop
                  </Button>
                  <Button size="small" onClick={() => edit(task)}>
                    Edit
                  </Button>
                  <Button size="small" onClick={() => actions.remove.mutate(task.id)}>
                    Delete
                  </Button>
                </div>
                <div className={styles.runs}>
                  {taskRuns.length === 0 ? (
                    <Body1 className={styles.empty}>No runs yet.</Body1>
                  ) : (
                    taskRuns.map((run) => (
                      <div key={run.id} className={styles.row}>
                        <StatusBadge tone={RUN_TONE[run.status]} label={run.status} />
                        <Body1 className={styles.meta}>
                          {`${run.trigger} · ${new Date(run.startedAt).toLocaleString()}${
                            run.stepsUsed ? ` · ${run.stepsUsed} tool calls` : ''
                          }${run.error ? ` · ${run.error}` : ''}`}
                        </Body1>
                      </div>
                    ))
                  )}
                </div>
              </Card>
            );
          })
        )}
      </div>

      <div className={styles.section}>
        <Subtitle2>Recent activity</Subtitle2>
        {(activity.data ?? []).length === 0 ? (
          <Body1 className={styles.empty}>Nothing has run yet.</Body1>
        ) : (
          (activity.data ?? []).map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </>
  );
}

/**
 * Seeds the concrete default the inputs display, and keeps a value the user already
 * typed when they switch kinds. Without this the form shows "5" or "09:00" while the
 * draft carries nothing, and Core rejects the save.
 */
function scheduleFor(kind: ScheduleKind, previous: TaskSchedule): TaskSchedule {
  if (kind === 'interval') {
    return { kind, intervalMinutes: previous.intervalMinutes ?? TASK_LIMITS.minIntervalMinutes };
  }
  if (kind === 'daily') return { kind, dailyTime: previous.dailyTime ?? '09:00' };
  return { kind: 'manual' };
}

function scheduleLabel(kind: ScheduleKind): string {
  if (kind === 'interval') return 'Every N minutes';
  if (kind === 'daily') return 'Daily at a time';
  return 'Manual only';
}

function taskState(task: SavedTask): string {
  if (task.running) return 'Running';
  if (!task.enabled) return 'Paused';
  return task.lastRunStatus ?? 'Idle';
}

function describeSchedule(task: SavedTask): string {
  const next = task.nextRunAt ? ` · next ${new Date(task.nextRunAt).toLocaleString()}` : '';
  if (task.schedule.kind === 'interval') return `Every ${task.schedule.intervalMinutes} min${next}`;
  if (task.schedule.kind === 'daily') return `Daily at ${task.schedule.dailyTime}${next}`;
  return 'Manual only';
}
