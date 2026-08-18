import { Body1, makeStyles, tokens } from '@fluentui/react-components';
import { TaskCard, jarvisSpacing } from '@jarvis/ui';
import { PageHeader } from '../components/PageHeader.js';
import { useTasks } from '../queries.js';

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s },
  empty: { color: tokens.colorNeutralForeground3 },
});

export function TasksPage() {
  const styles = useStyles();
  const { data = [] } = useTasks();

  return (
    <>
      <PageHeader title="Tasks" description="Every chat turn and tool run is tracked as a task." />
      <div className={styles.list}>
        {data.length === 0 ? (
          <Body1 className={styles.empty}>No tasks yet.</Body1>
        ) : (
          data.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </>
  );
}
