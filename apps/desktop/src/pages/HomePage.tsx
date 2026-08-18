import { Body1, Button, Card, Caption1, Subtitle2, makeStyles, tokens } from '@fluentui/react-components';
import { jarvisSpacing } from '@jarvis/ui';
import { PageHeader } from '../components/PageHeader.js';
import { SystemStrip } from '../components/SystemStrip.js';
import { usePendingApprovals, useSystemStatus, useTasks } from '../queries.js';
import { useUiStore } from '../store.js';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: jarvisSpacing.m },
  card: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s, padding: jarvisSpacing.l },
  strip: { marginBottom: jarvisSpacing.l },
  hint: { color: tokens.colorNeutralForeground3 },
});

export function HomePage() {
  const styles = useStyles();
  const status = useSystemStatus();
  const tasks = useTasks();
  const approvals = usePendingApprovals();
  const setPage = useUiStore((state) => state.setPage);

  const runtimeReady = status.data?.runtime.status === 'ready';

  return (
    <>
      <PageHeader title="Home" description="Local-first assistant. Everything runs on this machine." />
      <div className={styles.strip}>
        <SystemStrip />
      </div>

      <div className={styles.grid}>
        <Card className={styles.card}>
          <Subtitle2>Start a conversation</Subtitle2>
          <Body1>
            {runtimeReady
              ? 'Ask a question or plan a change. Ask and Plan modes are available in this milestone.'
              : 'Chat needs a local model runtime. Install and start Ollama, then pull a model such as qwen2.5-coder.'}
          </Body1>
          <Button appearance="primary" onClick={() => setPage('chat')}>
            Open Chat
          </Button>
        </Card>

        <Card className={styles.card}>
          <Subtitle2>Pending approvals</Subtitle2>
          <Body1>{`${approvals.data?.length ?? 0} action(s) waiting for your decision.`}</Body1>
          <Caption1 className={styles.hint}>
            Jarvis never performs a risky action without an explicit approval recorded in the audit log.
          </Caption1>
          <Button onClick={() => useUiStore.getState().setApprovalsOpen(true)}>Review queue</Button>
        </Card>

        <Card className={styles.card}>
          <Subtitle2>Recent tasks</Subtitle2>
          <Body1>{`${tasks.data?.length ?? 0} task(s) recorded.`}</Body1>
          <Button onClick={() => setPage('tasks')}>Open Tasks</Button>
        </Card>

        <Card className={styles.card}>
          <Subtitle2>Permissions</Subtitle2>
          <Body1>{`Profile: ${status.data?.profile ?? 'unknown'}`}</Body1>
          <Caption1 className={styles.hint}>
            Folder scopes are opt-in. Without an allowed scope, filesystem tools are denied in code.
          </Caption1>
          <Button onClick={() => setPage('permissions')}>Manage access</Button>
        </Card>
      </div>
    </>
  );
}
