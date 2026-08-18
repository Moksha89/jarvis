import { useState } from 'react';
import {
  Body1,
  Button,
  Field,
  Input,
  ProgressBar,
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
  pull: { display: 'flex', gap: jarvisSpacing.s, alignItems: 'flex-end', marginBottom: jarvisSpacing.m },
  pullField: { minWidth: '260px' },
  progress: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs, marginBottom: jarvisSpacing.m },
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
  const remove = useMutation({ mutationFn: (id: string) => coreClient.deleteModel(id), onSuccess: invalidate });

  const [pullName, setPullName] = useState('');
  const [pull, setPull] = useState<{ model: string; label: string; percent?: number } | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);

  const startPull = async () => {
    const model = pullName.trim();
    if (!model || pull) return;
    setPullError(null);
    setPull({ model, label: 'starting' });
    try {
      for await (const progress of coreClient.pullModel(model)) {
        setPull({ model, label: progress.status, percent: progress.percent });
      }
      setPullName('');
      invalidate();
    } catch (error) {
      setPullError(error instanceof Error ? error.message : String(error));
    } finally {
      setPull(null);
    }
  };

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

      <div className={styles.pull}>
        <Field label="Pull a model" className={styles.pullField} hint="Any Ollama tag, for example qwen2.5-coder:7b">
          <Input value={pullName} onChange={(_, data) => setPullName(data.value)} placeholder="qwen2.5-coder:7b" />
        </Field>
        <Button appearance="primary" disabled={Boolean(pull) || pullName.trim() === ''} onClick={() => void startPull()}>
          Pull
        </Button>
      </div>

      {pull ? (
        <div className={styles.progress}>
          <Body1>{`${pull.model} · ${pull.label}${pull.percent === undefined ? '' : ` · ${pull.percent}%`}`}</Body1>
          <ProgressBar value={pull.percent === undefined ? undefined : pull.percent / 100} />
        </div>
      ) : null}

      {pullError ? (
        <MessageBar intent="error" className={styles.notice}>
          <MessageBarBody>{pullError}</MessageBarBody>
        </MessageBar>
      ) : null}

      {(models.data ?? []).length === 0 ? (
        <Body1>No models found. Pull one above, for example `qwen2.5-coder:7b`.</Body1>
      ) : (
        <Table size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Model</TableHeaderCell>
              <TableHeaderCell>Parameters</TableHeaderCell>
              <TableHeaderCell>Quantization</TableHeaderCell>
              <TableHeaderCell>Size</TableHeaderCell>
              <TableHeaderCell>VRAM</TableHeaderCell>
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
                <TableCell>{model.vramBytes ? `${(model.vramBytes / 1024 ** 3).toFixed(1)} GB` : '—'}</TableCell>
                <TableCell>
                  <StatusBadge
                    tone={model.loaded ? 'ok' : 'neutral'}
                    label={model.loaded ? 'Loaded' : 'Idle'}
                    title={model.expiresAt ? `Unloads at ${new Date(model.expiresAt).toLocaleTimeString()}` : undefined}
                  />
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
                    <Button size="small" disabled={remove.isPending} onClick={() => remove.mutate(model.id)}>
                      Delete
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
