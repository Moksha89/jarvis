import { useState } from 'react';
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Caption1,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle2,
  Switch,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { StatusBadge, jarvisSpacing } from '@jarvis/ui';
import { PageHeader } from '../components/PageHeader.js';
import { useDesktopActions, useSettings, useUpdateSettings } from '../queries.js';

const useStyles = makeStyles({
  card: { padding: jarvisSpacing.m, display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s },
  section: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s, marginBottom: jarvisSpacing.l },
  row: { display: 'flex', gap: jarvisSpacing.s, alignItems: 'center', flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '240px' },
  meta: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs, maxHeight: '320px', overflowY: 'auto' },
  element: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  empty: { color: tokens.colorNeutralForeground3 },
});

/**
 * Computer use: what Jarvis can see on the desktop, and — once the user opts in —
 * what it may click and type. Every action here goes through the same tool,
 * permission and audit path as a chat-driven call.
 */
export function ScreenPage() {
  const styles = useStyles();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const desktop = useDesktopActions();
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [keys, setKeys] = useState('');
  const [target, setTarget] = useState('');

  const controlEnabled = settings.data?.desktopControlEnabled ?? false;
  const windows = desktop.windows.data ?? [];
  const elements = desktop.inspect.data ?? [];
  const shot = desktop.screenshot.data;
  const error =
    desktop.windows.error ??
    desktop.inspect.error ??
    desktop.screenshot.error ??
    desktop.focus.error ??
    desktop.click.error ??
    desktop.type.error ??
    desktop.keys.error ??
    null;

  return (
    <>
      <PageHeader
        title="Screen"
        description="Let Jarvis read the desktop, and optionally drive it. Reading is always allowed; clicking and typing need the switch below."
      />

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{(error as Error).message}</MessageBarBody>
        </MessageBar>
      ) : null}

      <div className={styles.section}>
        <Card className={styles.card}>
          <CardHeader header={<Subtitle2>Desktop control</Subtitle2>} />
          <Switch
            checked={controlEnabled}
            label={controlEnabled ? 'Jarvis may click and type' : 'Jarvis may only look at the screen'}
            onChange={(_, data) => updateSettings.mutate({ desktopControlEnabled: data.checked })}
          />
          <Caption1 className={styles.meta}>
            A click lands wherever it lands, so no folder scope can contain it. Each click, keystroke and window focus
            is still classified, may ask for approval and is written to the audit log.
          </Caption1>
        </Card>
      </div>

      <div className={styles.section}>
        <Card className={styles.card}>
          <CardHeader header={<Subtitle2>Open windows</Subtitle2>} />
          <div className={styles.row}>
            <Button appearance="primary" disabled={desktop.windows.isPending} onClick={() => desktop.windows.mutate()}>
              Refresh
            </Button>
            <Button disabled={desktop.screenshot.isPending} onClick={() => desktop.screenshot.mutate(undefined)}>
              Capture whole screen
            </Button>
            {desktop.windows.isPending ? <Spinner size="tiny" /> : null}
          </div>
          {desktop.windows.isSuccess && windows.length === 0 ? (
            <Body1 className={styles.empty}>No visible windows with a title.</Body1>
          ) : null}
          <div className={styles.list}>
            {windows.map((window) => (
              <div key={window.handle} className={styles.row}>
                <Text weight={selected === window.handle ? 'semibold' : 'regular'} className={styles.grow}>
                  {window.title}
                </Text>
                {window.foreground ? <StatusBadge tone="ok" label="focused" /> : null}
                <Caption1 className={styles.meta}>{`${window.process} · pid ${String(window.pid)}`}</Caption1>
                <Button
                  size="small"
                  onClick={() => {
                    setSelected(window.handle);
                    desktop.inspect.mutate(window.handle);
                  }}
                >
                  Read
                </Button>
                <Button size="small" onClick={() => desktop.screenshot.mutate(window.handle)}>
                  Capture
                </Button>
                <Button size="small" disabled={!controlEnabled} onClick={() => desktop.focus.mutate(window.handle)}>
                  Focus
                </Button>
              </div>
            ))}
          </div>
          {shot ? (
            <Caption1 className={styles.meta}>
              {`Saved ${shot.width}x${shot.height} to ${shot.path} (${String(Math.round(shot.bytes / 1024))} KB)`}
            </Caption1>
          ) : null}
        </Card>
      </div>

      {selected ? (
        <div className={styles.section}>
          <Card className={styles.card}>
            <CardHeader header={<Subtitle2>What that window exposes</Subtitle2>} />
            {desktop.inspect.isPending ? <Spinner size="tiny" /> : null}
            <div className={styles.list}>
              {elements.map((element, index) => (
                <Caption1 key={`${element.automationId}-${String(index)}`} className={styles.element}>
                  {`${'  '.repeat(element.depth)}${element.role}${element.name ? ` · ${element.name}` : ''}${
                    element.enabled ? '' : ' · disabled'
                  }`}
                </Caption1>
              ))}
            </div>
            {desktop.inspect.isSuccess && elements.length === 0 ? (
              <Body1 className={styles.empty}>That window exposes no accessible elements.</Body1>
            ) : null}
            <div className={styles.row}>
              <Input
                className={styles.grow}
                value={target}
                placeholder="Element to click, e.g. Save"
                onChange={(_, data) => setTarget(data.value)}
              />
              <Button
                disabled={!controlEnabled || !target.trim() || desktop.click.isPending}
                onClick={() => desktop.click.mutate({ handle: selected, element: target.trim() })}
              >
                Click
              </Button>
            </div>
            <div className={styles.row}>
              <Input
                className={styles.grow}
                value={text}
                placeholder="Text to type into the focused window"
                onChange={(_, data) => setText(data.value)}
              />
              <Button
                disabled={!controlEnabled || !text || desktop.type.isPending}
                onClick={() => desktop.type.mutate(text)}
              >
                Type
              </Button>
            </div>
            <div className={styles.row}>
              <Input
                className={styles.grow}
                value={keys}
                placeholder="Keys in SendKeys notation, e.g. ^s or {ENTER}"
                onChange={(_, data) => setKeys(data.value)}
              />
              <Button
                disabled={!controlEnabled || !keys.trim() || desktop.keys.isPending}
                onClick={() => desktop.keys.mutate(keys.trim())}
              >
                Press
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
