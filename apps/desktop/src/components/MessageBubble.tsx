import { useState } from 'react';
import { Button, Caption1, Tooltip, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowClockwise20Regular, Copy20Regular, CheckmarkCircle20Regular } from '@fluentui/react-icons';
import { jarvisRadius, jarvisSpacing } from '@jarvis/ui';
import type { ChatMessage } from '@jarvis/types';
import { Markdown } from './Markdown.js';

const useStyles = makeStyles({
  row: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs },
  bubble: {
    padding: jarvisSpacing.m,
    borderRadius: jarvisRadius.large,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    maxWidth: '100%',
  },
  user: { backgroundColor: tokens.colorBrandBackground2, alignSelf: 'flex-end' },
  assistant: { backgroundColor: tokens.colorNeutralBackground1 },
  meta: { display: 'flex', alignItems: 'center', gap: jarvisSpacing.xs, color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
});

export interface MessageBubbleProps {
  message: ChatMessage;
  /** Assistant messages can be regenerated; user messages can be retried. */
  onRetry?: () => void;
  retryLabel?: string;
}

export function MessageBubble({ message, onRetry, retryLabel = 'Regenerate' }: MessageBubbleProps) {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className={styles.row}>
      <div className={mergeClasses(styles.bubble, isUser ? styles.user : styles.assistant)}>
        <Markdown content={message.content} />
        {message.error ? <Caption1 className={styles.error}>{message.error}</Caption1> : null}
      </div>
      <div className={styles.meta}>
        <Caption1>
          {`${isUser ? 'You' : (message.model ?? 'Jarvis')} · ${new Date(message.createdAt).toLocaleTimeString()}`}
        </Caption1>
        <Tooltip content={copied ? 'Copied' : 'Copy message'} relationship="label" withArrow>
          <Button
            appearance="subtle"
            size="small"
            icon={copied ? <CheckmarkCircle20Regular /> : <Copy20Regular />}
            onClick={() => void copy()}
            aria-label="Copy message"
          />
        </Tooltip>
        {onRetry ? (
          <Tooltip content={retryLabel} relationship="label" withArrow>
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowClockwise20Regular />}
              onClick={onRetry}
              aria-label={retryLabel}
            />
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
