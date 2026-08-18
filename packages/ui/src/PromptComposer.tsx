import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Textarea, makeStyles, tokens } from '@fluentui/react-components';
import { Dismiss24Regular, Send24Filled } from '@fluentui/react-icons';
import { jarvisRadius, jarvisSpacing } from './tokens.js';

export interface PromptComposerProps {
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Mode switch and other controls rendered beneath the input. */
  toolbar?: ReactNode;
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: jarvisSpacing.s,
    padding: jarvisSpacing.m,
    borderRadius: jarvisRadius.large,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  row: { display: 'flex', alignItems: 'center', gap: jarvisSpacing.s },
  spacer: { flex: 1 },
  input: { width: '100%' },
});

export function PromptComposer({
  onSubmit,
  onCancel,
  busy = false,
  disabled = false,
  placeholder = 'Ask Jarvis something…',
  toolbar,
}: PromptComposerProps) {
  const styles = useStyles();
  const [value, setValue] = useState('');

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || busy || disabled) return;
    setValue('');
    onSubmit(trimmed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={styles.root}>
      <Textarea
        className={styles.input}
        value={value}
        onChange={(_, data) => setValue(data.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        resize="vertical"
        rows={3}
        aria-label="Message for Jarvis"
      />
      <div className={styles.row}>
        {toolbar}
        <div className={styles.spacer} />
        {busy && onCancel ? (
          <Button appearance="secondary" icon={<Dismiss24Regular />} onClick={onCancel}>
            Stop
          </Button>
        ) : null}
        <Button appearance="primary" icon={<Send24Filled />} onClick={submit} disabled={busy || disabled}>
          Send
        </Button>
      </div>
    </div>
  );
}
