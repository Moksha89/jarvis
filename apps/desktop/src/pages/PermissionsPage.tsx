import { useState } from 'react';
import {
  Body1,
  Button,
  Card,
  Caption1,
  Dropdown,
  Field,
  Input,
  Option,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PathScope, PermissionProfileId } from '@jarvis/types';
import { RiskBadge, StatusBadge, jarvisSpacing } from '@jarvis/ui';
import { coreClient } from '../core-client.js';
import { PageHeader } from '../components/PageHeader.js';
import { queryKeys, usePermissions, useSetProfile, useTools } from '../queries.js';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.l },
  card: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.m, padding: jarvisSpacing.l },
  row: { display: 'flex', alignItems: 'flex-end', gap: jarvisSpacing.s, flexWrap: 'wrap' },
  item: { display: 'flex', alignItems: 'center', gap: jarvisSpacing.s, flexWrap: 'wrap' },
  path: { fontFamily: tokens.fontFamilyMonospace, wordBreak: 'break-all' },
  hint: { color: tokens.colorNeutralForeground3 },
  grow: { flex: 1, minWidth: '240px' },
});

const profileDescriptions: Record<PermissionProfileId, string> = {
  locked: 'Only safe reads run automatically. Anything that writes needs your approval; high risk is blocked.',
  balanced: 'Low-risk reversible writes inside allowed folders run automatically. Medium and high risk ask first.',
};

export function PermissionsPage() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const tools = useTools();
  const setProfile = useSetProfile();

  const [path, setPath] = useState('');
  const [mode, setMode] = useState<PathScope['mode']>('read');
  const [effect, setEffect] = useState<PathScope['effect']>('allow');

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: queryKeys.permissions });
  const addScope = useMutation({
    mutationFn: () => coreClient.addScope({ path, mode, effect }),
    onSuccess: () => {
      setPath('');
      invalidate();
    },
  });
  const removeScope = useMutation({ mutationFn: (id: string) => coreClient.deleteScope(id), onSuccess: invalidate });
  const removeRule = useMutation({ mutationFn: (id: string) => coreClient.deleteRule(id), onSuccess: invalidate });

  const profile = permissions.data?.profile ?? 'locked';

  return (
    <>
      <PageHeader
        title="Permissions"
        description="Enforced in code, not by prompting. Every tool call is checked before it runs."
      />

      <div className={styles.stack}>
        <Card className={styles.card}>
          <Subtitle2>Profile</Subtitle2>
          <Dropdown
            value={profile}
            selectedOptions={[profile]}
            onOptionSelect={(_, data) => {
              if (data.optionValue) setProfile.mutate(data.optionValue as PermissionProfileId);
            }}
          >
            <Option value="locked">locked</Option>
            <Option value="balanced">balanced</Option>
          </Dropdown>
          <Caption1 className={styles.hint}>{profileDescriptions[profile]}</Caption1>
        </Card>

        <Card className={styles.card}>
          <Subtitle2>Folder scopes</Subtitle2>
          <Caption1 className={styles.hint}>
            Filesystem tools only work inside allowed folders. A deny scope always wins over a parent allow scope.
          </Caption1>
          <div className={styles.row}>
            <Field label="Absolute path" className={styles.grow}>
              <Input value={path} onChange={(_, data) => setPath(data.value)} placeholder="C:\\Users\\you\\Documents\\jarvis" />
            </Field>
            <Field label="Access">
              <Dropdown
                value={mode}
                selectedOptions={[mode]}
                onOptionSelect={(_, data) => setMode(data.optionValue as PathScope['mode'])}
              >
                <Option value="read">read</Option>
                <Option value="read-write">read-write</Option>
              </Dropdown>
            </Field>
            <Field label="Effect">
              <Dropdown
                value={effect}
                selectedOptions={[effect]}
                onOptionSelect={(_, data) => setEffect(data.optionValue as PathScope['effect'])}
              >
                <Option value="allow">allow</Option>
                <Option value="deny">deny</Option>
              </Dropdown>
            </Field>
            <Button appearance="primary" disabled={!path.trim() || addScope.isPending} onClick={() => addScope.mutate()}>
              Add scope
            </Button>
          </div>
          {(permissions.data?.scopes ?? []).length === 0 ? (
            <Body1>No scopes yet. Jarvis cannot read or write any file until you add one.</Body1>
          ) : (
            (permissions.data?.scopes ?? []).map((scope) => (
              <div key={scope.id} className={styles.item}>
                <StatusBadge tone={scope.effect === 'allow' ? 'ok' : 'error'} label={scope.effect} />
                <StatusBadge tone="neutral" label={scope.mode} />
                <Caption1 className={styles.path}>{scope.path}</Caption1>
                <Button size="small" appearance="subtle" onClick={() => removeScope.mutate(scope.id)}>
                  Remove
                </Button>
              </div>
            ))
          )}
        </Card>

        <Card className={styles.card}>
          <Subtitle2>Remembered decisions</Subtitle2>
          {(permissions.data?.rules ?? []).length === 0 ? (
            <Body1>No saved rules. Approvals apply to a single action unless you choose to remember them.</Body1>
          ) : (
            (permissions.data?.rules ?? []).map((rule) => (
              <div key={rule.id} className={styles.item}>
                <StatusBadge tone={rule.effect === 'allow' ? 'ok' : rule.effect === 'deny' ? 'error' : 'warning'} label={rule.effect} />
                <Caption1 className={styles.path}>{`${rule.toolPattern}${rule.targetPattern ? ` @ ${rule.targetPattern}` : ''}`}</Caption1>
                <RiskBadge level={rule.maxRiskLevel} />
                <Button size="small" appearance="subtle" onClick={() => removeRule.mutate(rule.id)}>
                  Remove
                </Button>
              </div>
            ))
          )}
        </Card>

        <Card className={styles.card}>
          <Subtitle2>Registered tools</Subtitle2>
          {(tools.data ?? []).map((tool) => (
            <div key={tool.id} className={styles.item}>
              <Caption1 className={styles.path}>{tool.id}</Caption1>
              <RiskBadge level={tool.baseRiskLevel as 0 | 1 | 2 | 3 | 4} />
              <StatusBadge
                tone={tool.reversible ? 'ok' : 'warning'}
                label={tool.reversible ? 'reversible' : 'not reversible'}
              />
              <Caption1 className={styles.hint}>{tool.description}</Caption1>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}
