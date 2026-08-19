import { useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Card,
  CardHeader,
  Caption1,
  Dropdown,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Subtitle2,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { McpTrust } from '@jarvis/types';
import { jarvisSpacing } from '@jarvis/ui';
import { PageHeader } from '../components/PageHeader.js';
import { useSkillCatalog, useSkillServerActions, useSkillServers } from '../queries.js';

const useStyles = makeStyles({
  card: { padding: jarvisSpacing.m, display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s },
  section: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s, marginBottom: jarvisSpacing.l },
  row: { display: 'flex', gap: jarvisSpacing.s, alignItems: 'center', flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '200px' },
  meta: { color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  tools: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs, maxHeight: '200px', overflowY: 'auto' },
});

const trustLabels: Record<McpTrust, string> = {
  'read-only': 'Read-only — it only looks at things',
  normal: 'Normal — it can change things it owns',
  sensitive: 'Sensitive — it can do damage',
};

/**
 * Skill servers are Model Context Protocol programs. Their tools appear in the same
 * registry as Jarvis' own, so they are classified, may ask for approval and are
 * audited exactly like the built-in ones. Trust decides how careful Jarvis is,
 * because Jarvis cannot see what a third-party tool actually does.
 */
export function SkillsPage() {
  const styles = useStyles();
  const servers = useSkillServers();
  const catalog = useSkillCatalog();
  const actions = useSkillServerActions();
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [trust, setTrust] = useState<McpTrust>('read-only');

  const error =
    servers.error ??
    actions.add.error ??
    actions.setEnabled.error ??
    actions.reconnect.error ??
    actions.remove.error ??
    actions.install.error;
  const list = servers.data ?? [];

  const addServer = () => {
    actions.add.mutate(
      {
        name: name.trim(),
        command: command.trim(),
        // Arguments are split on spaces, the way they are written in a README.
        args: args.split(' ').filter((arg) => arg.trim() !== ''),
        trust,
      },
      {
        onSuccess: () => {
          setName('');
          setCommand('');
          setArgs('');
        },
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Skills"
        description="Add a skill server and its tools become Jarvis' tools. They go through the same permission checks, approvals and audit log as everything else."
      />

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{(error as Error).message}</MessageBarBody>
        </MessageBar>
      ) : null}

      <div className={styles.section}>
        <Card className={styles.card}>
          <CardHeader header={<Subtitle2>Skills Jarvis can add by itself</Subtitle2>} />
          <Caption1 className={styles.meta}>
            Jarvis picks from this list on its own when a job needs an ability it has no tool for. It asks first, because
            adding one starts a program on this machine.
          </Caption1>
          {(catalog.data ?? []).map((match) => (
            <div className={styles.row} key={match.entry.id}>
              <div className={styles.grow}>
                <Body1>{match.entry.name}</Body1>
                <Caption1 className={styles.meta}>{match.entry.summary}</Caption1>
                <Caption1 className={styles.mono}>{match.entry.package ?? match.entry.command}</Caption1>
              </div>
              {match.installed ? (
                <Badge appearance="tint" color="success">
                  added
                </Badge>
              ) : (
                <Button disabled={actions.install.isPending} onClick={() => actions.install.mutate(match.entry.id)}>
                  Add now
                </Button>
              )}
            </div>
          ))}
          {actions.install.isPending ? <Spinner size="tiny" /> : null}
        </Card>
      </div>

      <div className={styles.section}>
        <Card className={styles.card}>
          <CardHeader header={<Subtitle2>Add a skill server</Subtitle2>} />
          <div className={styles.row}>
            <Input
              className={styles.grow}
              value={name}
              placeholder="Short name, e.g. files"
              onChange={(_, data) => setName(data.value)}
            />
            <Input
              className={styles.grow}
              value={command}
              placeholder="Command, e.g. npx"
              onChange={(_, data) => setCommand(data.value)}
            />
          </div>
          <div className={styles.row}>
            <Input
              className={styles.grow}
              value={args}
              placeholder="Arguments, e.g. -y @modelcontextprotocol/server-filesystem C:\\work"
              onChange={(_, data) => setArgs(data.value)}
            />
            <Dropdown
              value={trustLabels[trust]}
              selectedOptions={[trust]}
              onOptionSelect={(_, data) => setTrust((data.optionValue as McpTrust | undefined) ?? 'read-only')}
            >
              {(Object.keys(trustLabels) as McpTrust[]).map((value) => (
                <Option key={value} value={value} text={trustLabels[value]}>
                  {trustLabels[value]}
                </Option>
              ))}
            </Dropdown>
            <Button
              appearance="primary"
              disabled={actions.add.isPending || name.trim() === '' || command.trim() === ''}
              onClick={addServer}
            >
              Add
            </Button>
            {actions.add.isPending ? <Spinner size="tiny" /> : null}
          </div>
          <Caption1 className={styles.meta}>
            The server runs on this machine and Jarvis talks to it over its own input and output. Only the command is
            stored — keys a server needs belong in Windows Credential Manager, never here.
          </Caption1>
        </Card>
      </div>

      {list.length === 0 ? (
        <Caption1 className={styles.meta}>No skill servers yet. Jarvis is using its built-in tools only.</Caption1>
      ) : null}

      {list.map((server) => (
        <div className={styles.section} key={server.id}>
          <Card className={styles.card}>
            <CardHeader
              header={<Subtitle2>{server.name}</Subtitle2>}
              description={
                <Badge appearance="tint" color={server.connected ? 'success' : server.enabled ? 'danger' : 'informative'}>
                  {server.connected ? 'connected' : server.enabled ? 'not running' : 'off'}
                </Badge>
              }
            />
            <Caption1 className={styles.mono}>{[server.command, ...server.args].join(' ')}</Caption1>
            <Caption1 className={styles.meta}>{trustLabels[server.trust]}</Caption1>
            {server.error ? (
              <MessageBar intent="warning">
                <MessageBarBody>{server.error}</MessageBarBody>
              </MessageBar>
            ) : null}
            <Body1>{`${String(server.tools.length)} tool${server.tools.length === 1 ? '' : 's'}`}</Body1>
            <div className={styles.tools}>
              {server.tools.map((tool) => (
                <Caption1 key={tool.id} className={styles.mono}>
                  {`${tool.id} — ${tool.description}`}
                </Caption1>
              ))}
            </div>
            <div className={styles.row}>
              <Switch
                checked={server.enabled}
                label={server.enabled ? 'Jarvis may use this server' : 'Server is off'}
                onChange={(_, data) => actions.setEnabled.mutate({ id: server.id, enabled: data.checked })}
              />
              <Button
                disabled={!server.enabled || actions.reconnect.isPending}
                onClick={() => actions.reconnect.mutate(server.id)}
              >
                Reconnect
              </Button>
              <Button
                appearance="subtle"
                disabled={actions.remove.isPending}
                onClick={() => actions.remove.mutate(server.id)}
              >
                Remove
              </Button>
            </div>
          </Card>
        </div>
      ))}
    </>
  );
}
