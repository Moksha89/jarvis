import {
  Body1,
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
} from '@fluentui/react-components';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { StatusBadge, jarvisSpacing } from '@jarvis/ui';
import { coreClient } from '../core-client.js';
import { PageHeader } from '../components/PageHeader.js';
import { queryKeys, useModels, useSystemStatus } from '../queries.js';

const useStyles = makeStyles({
  notice: { marginBottom: jarvisSpacing.m },
  actions: { display: 'flex', gap: jarvisSpacing.xs },
});

export function ModelsPage() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const models = useModels();
  const status = useSystemStatus();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.models });
    void queryClient.invalidateQueries({ queryKey: queryKeys.status });
  };
  const load = useMutation({ mutationFn: (id: string) => coreClient.loadModel(id), onSuccess: invalidate });
  const unload = useMutation({ mutationFn: (id: string) => coreClient.unloadModel(id), onSuccess: invalidate });

  const runtime = status.data?.runtime;

  return (
    <>
      <PageHeader title="Models" description="Local models served by Ollama through the ModelRuntimeAdapter." />

      {runtime && runtime.status !== 'ready' ? (
        <MessageBar intent={runtime.status === 'not-installed' ? 'error' : 'warning'} className={styles.notice}>
          <MessageBarBody>
            <MessageBarTitle>
              {runtime.status === 'not-installed' ? 'Ollama is not installed' : 'Ollama is not running'}
            </MessageBarTitle>
            {runtime.message ?? `Expected at ${runtime.endpoint}.`}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {(models.data ?? []).length === 0 ? (
        <Body1>No models found. Pull one with `ollama pull qwen2.5-coder:7b`.</Body1>
      ) : (
        <Table size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Model</TableHeaderCell>
              <TableHeaderCell>Parameters</TableHeaderCell>
              <TableHeaderCell>Quantization</TableHeaderCell>
              <TableHeaderCell>Size</TableHeaderCell>
              <TableHeaderCell>State</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(models.data ?? []).map((model) => (
              <TableRow key={model.id}>
                <TableCell>{model.name}</TableCell>
                <TableCell>{model.parameterSize ?? '—'}</TableCell>
                <TableCell>{model.quantization ?? '—'}</TableCell>
                <TableCell>{model.sizeBytes ? `${(model.sizeBytes / 1024 ** 3).toFixed(1)} GB` : '—'}</TableCell>
                <TableCell>
                  <StatusBadge tone={model.loaded ? 'ok' : 'neutral'} label={model.loaded ? 'Loaded' : 'Idle'} />
                </TableCell>
                <TableCell>
                  <div className={styles.actions}>
                    <Button
                      size="small"
                      disabled={load.isPending || model.loaded}
                      onClick={() => load.mutate(model.id)}
                    >
                      Load
                    </Button>
                    <Button
                      size="small"
                      disabled={unload.isPending || !model.loaded}
                      onClick={() => unload.mutate(model.id)}
                    >
                      Unload
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
