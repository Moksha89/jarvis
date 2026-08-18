import { useEffect, useMemo } from 'react';
import {
  Body1,
  Button,
  Card,
  Dropdown,
  MessageBar,
  MessageBarBody,
  Option,
  Radio,
  RadioGroup,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ChatMode } from '@jarvis/types';
import { PromptComposer, StatusBadge, jarvisSpacing } from '@jarvis/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { coreClient } from '../core-client.js';
import { MessageBubble } from '../components/MessageBubble.js';
import { Markdown } from '../components/Markdown.js';
import { PageHeader } from '../components/PageHeader.js';
import { useChatStream } from '../hooks/useChatStream.js';
import { queryKeys, useConversations, useMessages, useModels } from '../queries.js';
import { useUiStore } from '../store.js';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.m, height: '100%' },
  thread: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.m, flex: 1, minHeight: '240px' },
  streaming: { padding: jarvisSpacing.m, border: `1px solid ${tokens.colorNeutralStroke2}` },
  toolbar: { display: 'flex', alignItems: 'center', gap: jarvisSpacing.m, flexWrap: 'wrap' },
  empty: { color: tokens.colorNeutralForeground3 },
  trail: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xs, marginTop: jarvisSpacing.s },
  trailRow: { display: 'flex', alignItems: 'center', gap: jarvisSpacing.xs },
});

const ACTIVITY_TONE = {
  running: 'info',
  'awaiting-approval': 'warning',
  done: 'ok',
  failed: 'error',
} as const;

const ACTIVITY_LABEL = {
  running: 'Running',
  'awaiting-approval': 'Needs approval',
  done: 'Done',
  failed: 'Failed',
} as const;

export function ChatPage() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { chatMode, setChatMode, activeConversationId, setActiveConversation } = useUiStore();
  const conversations = useConversations();
  const models = useModels();
  const messages = useMessages(activeConversationId);
  const stream = useChatStream(activeConversationId);

  const createConversation = useMutation({
    mutationFn: (mode: ChatMode) => coreClient.createConversation({ mode }),
    onSuccess: (conversation) => {
      setActiveConversation(conversation.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });

  // Reuse the newest conversation, or open one lazily so Chat works on first launch.
  useEffect(() => {
    if (activeConversationId || conversations.isPending) return;
    const existing = conversations.data?.[0];
    if (existing) setActiveConversation(existing.id);
    else if (!createConversation.isPending) createConversation.mutate(chatMode);
  }, [activeConversationId, chatMode, conversations.data, conversations.isPending, createConversation, setActiveConversation]);

  const lastUserMessage = useMemo(
    () => [...(messages.data ?? [])].reverse().find((message) => message.role === 'user'),
    [messages.data],
  );

  const modelOptions = models.data ?? [];

  return (
    <div className={styles.root}>
      <PageHeader
        title="Chat"
        description="Streamed, local conversation. Ask answers questions, Plan drafts steps without acting, Agent uses permission-gated tools."
      />

      {stream.error ? (
        <MessageBar intent="error">
          <MessageBarBody>{stream.error}</MessageBarBody>
        </MessageBar>
      ) : null}

      <div className={styles.thread}>
        {messages.isPending && activeConversationId ? <Spinner size="tiny" label="Loading conversation…" /> : null}
        {(messages.data ?? []).length === 0 && !stream.busy ? (
          <Body1 className={styles.empty}>No messages yet. Ask Jarvis something to get started.</Body1>
        ) : null}
        {(messages.data ?? [])
          .filter((message) => message.role !== 'system')
          .map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              retryLabel={message.role === 'user' ? 'Retry from here' : 'Regenerate'}
              onRetry={
                message.role === 'user'
                  ? () => void stream.send(message.content, chatMode, { retryFromMessageId: message.id })
                  : lastUserMessage
                    ? () => void stream.send(lastUserMessage.content, chatMode, { retryFromMessageId: lastUserMessage.id })
                    : undefined
              }
            />
          ))}
        {stream.busy ? (
          <Card className={styles.streaming}>
            {stream.text ? <Markdown content={stream.text} /> : <Spinner size="tiny" label="Thinking…" />}
            {stream.step ? (
              <div className={styles.trail}>
                <Body1 className={styles.empty}>{`Step ${stream.step.current} of ${stream.step.max}`}</Body1>
                {stream.activity.map((entry) => (
                  <div key={entry.callId} className={styles.trailRow}>
                    <StatusBadge tone={ACTIVITY_TONE[entry.state]} label={ACTIVITY_LABEL[entry.state]} />
                    <Body1>{`${entry.toolId} · ${entry.summary}`}</Body1>
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>

      <PromptComposer
        busy={stream.busy}
        disabled={!activeConversationId}
        onCancel={stream.cancel}
        onSubmit={(value) => void stream.send(value, chatMode)}
        toolbar={
          <div className={styles.toolbar}>
            <RadioGroup layout="horizontal" value={chatMode} onChange={(_, data) => setChatMode(data.value as ChatMode)}>
              <Radio value="ask" label="Ask" />
              <Radio value="plan" label="Plan" />
              <Radio value="agent" label="Agent" />
            </RadioGroup>
            <Dropdown
              placeholder={modelOptions.length ? 'Default model' : 'No models available'}
              disabled={modelOptions.length === 0}
              onOptionSelect={(_, data) => {
                if (data.optionValue) void coreClient.updateSettings({ defaultModel: data.optionValue });
              }}
            >
              {modelOptions.map((model) => (
                <Option key={model.id} value={model.id}>
                  {model.name}
                </Option>
              ))}
            </Dropdown>
            <Button
              size="small"
              disabled={stream.busy || createConversation.isPending}
              onClick={() => createConversation.mutate(chatMode)}
            >
              New conversation
            </Button>
          </div>
        }
      />
    </div>
  );
}
