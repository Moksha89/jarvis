import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Caption1,
  Dropdown,
  Field,
  Input,
  Option,
  Subtitle2,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { CoreSettingsDto } from '@jarvis/core/client';
import { jarvisSpacing } from '@jarvis/ui';
import { coreBaseUrl } from '../core-client.js';
import { PageHeader } from '../components/PageHeader.js';
import { useModels, useSettings, useUpdateSettings } from '../queries.js';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.l },
  card: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.m, padding: jarvisSpacing.l },
  hint: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: jarvisSpacing.s },
});

export function SettingsPage() {
  const styles = useStyles();
  const settings = useSettings();
  const models = useModels();
  const update = useUpdateSettings();
  const [draft, setDraft] = useState<CoreSettingsDto | null>(null);

  useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data);
  }, [draft, settings.data]);

  if (!draft) return <PageHeader title="Settings" description="Loading configuration from Jarvis Core…" />;

  const patch = (next: Partial<CoreSettingsDto>) => setDraft({ ...draft, ...next });

  return (
    <>
      <PageHeader title="Settings" description="Stored in the local SQLite database. Secrets are never kept here." />
      <div className={styles.stack}>
        <Card className={styles.card}>
          <Subtitle2>Model runtime</Subtitle2>
          <Field label="Ollama endpoint">
            <Input value={draft.ollamaEndpoint} onChange={(_, data) => patch({ ollamaEndpoint: data.value })} />
          </Field>
          <Field label="Default model">
            <Dropdown
              placeholder="Choose automatically"
              value={draft.defaultModel ?? ''}
              selectedOptions={draft.defaultModel ? [draft.defaultModel] : []}
              onOptionSelect={(_, data) => patch({ defaultModel: data.optionValue ?? null })}
            >
              {(models.data ?? []).map((model) => (
                <Option key={model.id} value={model.id}>
                  {model.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Card>

        <Card className={styles.card}>
          <Subtitle2>Qwen Code agent</Subtitle2>
          <Field label="qwen serve endpoint">
            <Input value={draft.qwenEndpoint} onChange={(_, data) => patch({ qwenEndpoint: data.value })} />
          </Field>
          <Switch
            checked={draft.qwenAutoStart}
            label="Start the qwen serve daemon with Core"
            onChange={(_, data) => patch({ qwenAutoStart: data.checked })}
          />
          <Caption1 className={styles.hint}>
            When the agent is unavailable, Core routes chat straight to the model runtime so streaming keeps working.
          </Caption1>
        </Card>

        <Card className={styles.card}>
          <Subtitle2>Memory and knowledge</Subtitle2>
          <Field label="Embedding model">
            <Input value={draft.embeddingModel} onChange={(_, data) => patch({ embeddingModel: data.value })} />
          </Field>
          <Switch
            checked={draft.memoryEnabled}
            label="Use indexed files and past chats to answer"
            onChange={(_, data) => patch({ memoryEnabled: data.checked })}
          />
          <Switch
            checked={draft.rememberConversations}
            label="Remember completed conversations"
            onChange={(_, data) => patch({ rememberConversations: data.checked })}
          />
          <Caption1 className={styles.hint}>
            Pull the embedding model in Models first. Changing it makes existing passages unusable until you reindex.
          </Caption1>
        </Card>

        <Card className={styles.card}>
          <Subtitle2>Appearance</Subtitle2>
          <Field label="Theme">
            <Dropdown
              value={draft.theme}
              selectedOptions={[draft.theme]}
              onOptionSelect={(_, data) => patch({ theme: (data.optionValue ?? 'system') as CoreSettingsDto['theme'] })}
            >
              <Option value="system">system</Option>
              <Option value="light">light</Option>
              <Option value="dark">dark</Option>
            </Dropdown>
          </Field>
          <Caption1 className={styles.hint}>{`Core endpoint: ${coreBaseUrl}`}</Caption1>
        </Card>

        <div className={styles.actions}>
          <Button appearance="primary" disabled={update.isPending} onClick={() => update.mutate(draft)}>
            Save changes
          </Button>
          <Button appearance="secondary" onClick={() => setDraft(settings.data ?? draft)}>
            Reset
          </Button>
        </div>
      </div>
    </>
  );
}
