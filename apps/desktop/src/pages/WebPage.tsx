import { useState } from 'react';
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Caption1,
  Checkbox,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle2,
  Switch,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { BrowserPageInfo } from '@jarvis/types';
import { jarvisSpacing } from '@jarvis/ui';
import { PageHeader } from '../components/PageHeader.js';
import { useBrowserActions, useSettings, useUpdateSettings } from '../queries.js';

const useStyles = makeStyles({
  card: { padding: jarvisSpacing.m, display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s },
  section: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s, marginBottom: jarvisSpacing.l },
  row: { display: 'flex', gap: jarvisSpacing.s, alignItems: 'center', flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '240px' },
  meta: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs, maxHeight: '240px', overflowY: 'auto' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
});

/**
 * Browser automation: Jarvis drives its own visible browser window with its own
 * profile, so the user can watch it work and take over at any time.
 */
export function WebPage() {
  const styles = useStyles();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const browser = useBrowserActions();
  const [url, setUrl] = useState('https://');
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [submit, setSubmit] = useState(false);

  const controlEnabled = settings.data?.browserControlEnabled ?? false;
  // A click or a submitted form navigates too, so the newest of the three results
  // is the page actually on screen.
  const page = newestPage([browser.open, browser.click, browser.type]);
  const snapshot = browser.read.data;
  const shot = browser.screenshot.data;
  const error =
    browser.open.error ??
    browser.read.error ??
    browser.screenshot.error ??
    browser.click.error ??
    browser.type.error ??
    browser.close.error ??
    null;

  return (
    <>
      <PageHeader
        title="Web"
        description="Jarvis browses in its own window with its own profile, never your everyday one. Opening and reading pages is always allowed; clicking and filling in forms need the switch below."
      />

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{(error as Error).message}</MessageBarBody>
        </MessageBar>
      ) : null}

      <div className={styles.section}>
        <Card className={styles.card}>
          <CardHeader header={<Subtitle2>Browser control</Subtitle2>} />
          <Switch
            checked={controlEnabled}
            label={controlEnabled ? 'Jarvis may click and fill in pages' : 'Jarvis may only open and read pages'}
            onChange={(_, data) => updateSettings.mutate({ browserControlEnabled: data.checked })}
          />
          <Caption1 className={styles.meta}>
            A click on a page can spend money or send a message, so acting stays off until you turn it on. Every call is
            still classified, may ask for approval and is written to the audit log.
          </Caption1>
        </Card>
      </div>

      <div className={styles.section}>
        <Card className={styles.card}>
          <CardHeader header={<Subtitle2>Open a page</Subtitle2>} />
          <div className={styles.row}>
            <Input
              className={styles.grow}
              value={url}
              placeholder="https://example.com"
              onChange={(_, data) => setUrl(data.value)}
            />
            <Button
              appearance="primary"
              disabled={browser.open.isPending || url.trim().length < 9}
              onClick={() => browser.open.mutate(url.trim())}
            >
              Open
            </Button>
            <Button disabled={browser.read.isPending} onClick={() => browser.read.mutate()}>
              Read page
            </Button>
            <Button disabled={browser.screenshot.isPending} onClick={() => browser.screenshot.mutate(true)}>
              Capture
            </Button>
            <Button disabled={browser.close.isPending} onClick={() => browser.close.mutate()}>
              Close browser
            </Button>
            {browser.open.isPending || browser.read.isPending ? <Spinner size="tiny" /> : null}
          </div>
          {page ? <Caption1 className={styles.meta}>{`${page.title} — ${page.url}`}</Caption1> : null}
          {shot ? (
            <Caption1 className={styles.meta}>
              {`Saved the page to ${shot.path} (${String(Math.round(shot.bytes / 1024))} KB)`}
            </Caption1>
          ) : null}
        </Card>
      </div>

      {page && !snapshot ? (
        <div className={styles.section}>
          <Caption1 className={styles.meta}>
            Read the page to see what is on it. Clicking and filling in are offered from that reading, so they always
            aim at the page in front of you.
          </Caption1>
        </div>
      ) : null}

      {snapshot ? (
        <div className={styles.section}>
          <Card className={styles.card}>
            <CardHeader header={<Subtitle2>{snapshot.title}</Subtitle2>} />
            <Textarea value={snapshot.text} readOnly resize="vertical" rows={8} />
            {snapshot.truncated ? <Caption1 className={styles.meta}>Text was cut to keep the page short.</Caption1> : null}
            <Body1>What can be used on this page</Body1>
            <div className={styles.list}>
              {snapshot.controls.map((control, index) => (
                <Caption1 key={`${control.role}-${control.name}-${String(index)}`} className={styles.mono}>
                  {`${control.role} · ${control.name}`}
                </Caption1>
              ))}
            </div>
            <div className={styles.row}>
              <Input
                className={styles.grow}
                value={target}
                placeholder="Button, link or field name, e.g. Sign in"
                onChange={(_, data) => setTarget(data.value)}
              />
              <Button
                disabled={!controlEnabled || target.trim() === '' || browser.click.isPending}
                onClick={() => browser.click.mutate(target.trim())}
              >
                Click
              </Button>
            </div>
            <div className={styles.row}>
              <Input
                className={styles.grow}
                value={text}
                placeholder="Text to type into the field named above"
                onChange={(_, data) => setText(data.value)}
              />
              <Checkbox
                label="press Enter"
                checked={submit}
                onChange={(_, data) => setSubmit(data.checked === true)}
              />
              <Button
                disabled={!controlEnabled || text === '' || browser.type.isPending}
                onClick={() => browser.type.mutate({ target: target.trim(), text, submit })}
              >
                Fill in
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}

/** The most recently submitted of the actions that can change which page is open. */
function newestPage(
  results: readonly { data?: BrowserPageInfo; submittedAt: number }[],
): BrowserPageInfo | undefined {
  let newest: { data: BrowserPageInfo; submittedAt: number } | undefined;
  for (const result of results) {
    if (!result.data) continue;
    if (!newest || result.submittedAt > newest.submittedAt) newest = { data: result.data, submittedAt: result.submittedAt };
  }
  return newest?.data;
}
