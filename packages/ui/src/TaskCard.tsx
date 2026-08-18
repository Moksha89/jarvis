import { Body1, Caption1, Card, CardHeader, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import type { Task } from '@jarvis/types';
import { StatusBadge, type StatusTone } from './StatusBadge.js';
import { jarvisSpacing } from './tokens.js';

const toneByStatus: Record<Task['status'], StatusTone> = {
  queued: 'neutral',
  running: 'info',
  'awaiting-approval': 'warning',
  succeeded: 'ok',
  failed: 'error',
  cancelled: 'neutral',
};

const useStyles = makeStyles({
  card: { padding: jarvisSpacing.m },
  detail: { color: tokens.colorNeutralForeground3 },
  header: { display: 'flex', alignItems: 'center', gap: jarvisSpacing.s },
});

export function TaskCard({ task }: { task: Task }) {
  const styles = useStyles();
  return (
    <Card className={styles.card}>
      <CardHeader
        header={
          <div className={styles.header}>
            {task.status === 'running' ? <Spinner size="tiny" /> : null}
            <Body1>{task.title}</Body1>
          </div>
        }
        description={
          <Caption1 className={styles.detail}>
            {`${task.kind} · ${new Date(task.updatedAt).toLocaleString()}${task.detail ? ` · ${task.detail}` : ''}`}
          </Caption1>
        }
        action={<StatusBadge tone={toneByStatus[task.status]} label={task.status.replace('-', ' ')} />}
      />
      {task.error ? <Caption1 className={styles.detail}>{task.error}</Caption1> : null}
    </Card>
  );
}
