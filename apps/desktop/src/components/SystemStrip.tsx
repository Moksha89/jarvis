import { makeStyles } from '@fluentui/react-components';
import { ResourceMeter, StatusBadge, jarvisSpacing, type StatusTone } from '@jarvis/ui';
import type { RuntimeStatus } from '@jarvis/types';
import { useSystemStatus } from '../queries.js';

const runtimeTone: Record<RuntimeStatus, StatusTone> = {
  ready: 'ok',
  'not-running': 'warning',
  'not-installed': 'error',
  error: 'error',
};

const runtimeLabel: Record<RuntimeStatus, string> = {
  ready: 'Ollama ready',
  'not-running': 'Ollama not running',
  'not-installed': 'Ollama not installed',
  error: 'Ollama error',
};

const useStyles = makeStyles({
  root: { display: 'flex', alignItems: 'center', gap: jarvisSpacing.m, flexWrap: 'wrap' },
});

/** The Home dashboard system strip, also shown compactly in the header. */
export function SystemStrip({ compact = false }: { compact?: boolean }) {
  const styles = useStyles();
  const { data, isPending, error } = useSystemStatus();

  if (error) {
    return (
      <div className={styles.root}>
        <StatusBadge
          tone="error"
          label="Core offline"
          title={`Jarvis Core is not reachable. Start it with "pnpm dev:core". (${error.message})`}
        />
      </div>
    );
  }

  if (isPending || !data) {
    return (
      <div className={styles.root}>
        <StatusBadge tone="neutral" label="Checking…" />
      </div>
    );
  }

  const memoryPercent =
    data.resources.memoryTotalBytes > 0
      ? (data.resources.memoryUsedBytes / data.resources.memoryTotalBytes) * 100
      : 0;

  return (
    <div className={styles.root}>
      <StatusBadge tone="ok" label={`Core ${data.core.version}`} title={`Platform ${data.core.platform}`} />
      <StatusBadge
        tone={runtimeTone[data.runtime.status]}
        label={runtimeLabel[data.runtime.status]}
        title={data.runtime.message ?? data.runtime.endpoint}
      />
      <StatusBadge
        tone={data.agent.available ? 'ok' : 'neutral'}
        label={data.agent.mode === 'qwen-serve' ? 'Qwen Code' : 'Direct model'}
        title={data.agent.message}
      />
      <StatusBadge tone="info" label={`Profile: ${data.profile}`} />
      {compact ? null : (
        <>
          <ResourceMeter label="CPU" percent={data.resources.cpuPercent} />
          <ResourceMeter
            label="Memory"
            percent={memoryPercent}
            detail={`${formatGiB(data.resources.memoryUsedBytes)} / ${formatGiB(data.resources.memoryTotalBytes)}`}
          />
        </>
      )}
    </div>
  );
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
