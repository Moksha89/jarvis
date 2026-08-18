import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatMode } from '@jarvis/types';
import { coreClient } from '../core-client.js';
import { queryKeys } from '../queries.js';

export interface StreamingState {
  /** Text accumulated for the in-flight assistant message. */
  text: string;
  busy: boolean;
  error: string | null;
}

export function useChatStream(conversationId: string | null) {
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<StreamingState>({ text: '', busy: false, error: null });

  const send = useCallback(
    async (content: string, mode: ChatMode, options?: { retryFromMessageId?: string; model?: string }) => {
      if (!conversationId) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ text: '', busy: true, error: null });

      try {
        const stream = coreClient.sendChat(
          {
            conversationId,
            content,
            mode,
            model: options?.model,
            retryFromMessageId: options?.retryFromMessageId,
          },
          controller.signal,
        );
        for await (const event of stream) {
          if (event.type === 'delta') {
            setState((prev) => ({ ...prev, text: prev.text + event.text }));
          } else if (event.type === 'error') {
            setState((prev) => ({ ...prev, error: event.error }));
          }
        }
        setState({ text: '', busy: false, error: null });
      } catch (error) {
        // Aborting is a user action ("Stop"), not a failure.
        const aborted = controller.signal.aborted;
        setState({ text: '', busy: false, error: aborted ? null : (error as Error).message });
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
