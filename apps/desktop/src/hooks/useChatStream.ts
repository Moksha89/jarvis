import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatMode, KnowledgeCitation } from '@jarvis/types';
import { coreClient } from '../core-client.js';
import { queryKeys } from '../queries.js';

export interface AgentActivity {
  callId: string;
  toolId: string;
  summary: string;
  state: 'running' | 'awaiting-approval' | 'done' | 'failed';
}

export interface StreamingState {
  /** Text accumulated for the in-flight assistant message. */
  text: string;
  busy: boolean;
  error: string | null;
  /** Agent mode only: which step of the budget is running. */
  step: { current: number; max: number } | null;
  /** Agent mode only: the tools this turn has reached for, newest last. */
  activity: AgentActivity[];
  /** Files or past turns retrieved for this answer. */
  citations: readonly KnowledgeCitation[];
}

const IDLE: StreamingState = { text: '', busy: false, error: null, step: null, activity: [], citations: [] };

export function useChatStream(conversationId: string | null) {
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<StreamingState>(IDLE);

  const send = useCallback(
    async (
      content: string,
      mode: ChatMode,
      options?: { retryFromMessageId?: string; model?: string; maxSteps?: number },
    ) => {
      if (!conversationId) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ ...IDLE, busy: true });

      try {
        const stream = coreClient.sendChat(
          {
            conversationId,
            content,
            mode,
            model: options?.model,
            retryFromMessageId: options?.retryFromMessageId,
            maxSteps: options?.maxSteps,
          },
          controller.signal,
        );
        for await (const event of stream) {
          switch (event.type) {
            case 'delta':
              setState((prev) => ({ ...prev, text: prev.text + event.text }));
              break;
            case 'context':
              setState((prev) => ({ ...prev, citations: event.citations }));
              break;
            case 'step':
              setState((prev) => ({ ...prev, step: { current: event.step, max: event.maxSteps } }));
              break;
            case 'tool-call':
              setState((prev) => ({
                ...prev,
                activity: [
                  ...prev.activity,
                  { callId: event.callId, toolId: event.toolId, summary: event.summary, state: 'running' },
                ],
              }));
              break;
            case 'awaiting-approval':
              setState((prev) => ({ ...prev, activity: patch(prev.activity, event.callId, 'awaiting-approval') }));
              break;
            case 'tool-result':
              setState((prev) => ({
                ...prev,
                activity: patch(prev.activity, event.callId, event.ok ? 'done' : 'failed', event.summary),
              }));
              break;
            case 'error':
              setState((prev) => ({ ...prev, error: event.error }));
              break;
            default:
              break;
          }
        }
        // Core reports a failed turn as an `error` event followed by a normal end of
        // stream, so the reset must not wipe what the stream just told us.
        setState((prev) => ({ ...IDLE, error: prev.error }));
      } catch (error) {
        // Aborting is a user action ("Stop"), not a failure.
        const aborted = controller.signal.aborted;
        setState({ ...IDLE, error: aborted ? null : (error as Error).message });
      } finally {
        await queryClient.invalidateQueries({ queryKey: queryKeys.messages(conversationId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      }
    },
    [conversationId, queryClient],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({ ...prev, busy: false }));
  }, []);

  return { ...state, send, cancel };
}

function patch(
  activity: readonly AgentActivity[],
  callId: string,
  state: AgentActivity['state'],
  summary?: string,
): AgentActivity[] {
  return activity.map((entry) =>
    entry.callId === callId ? { ...entry, state, summary: summary ?? entry.summary } : entry,
  );
}
