import { useMutation, useQueryClient } from '@tanstack/react-query';
import { coreClient } from '../core-client.js';
import { queryKeys } from '../queries.js';

/** Phrase Core requires for level 3+ approvals. Mirrors CONFIRMATION_PHRASE in Core. */
export const CONFIRMATION_PHRASE = 'I understand';

export function useApprovalActions() {
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
    void queryClient.invalidateQueries({ queryKey: queryKeys.toolCalls });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    void queryClient.invalidateQueries({ queryKey: ['audit'] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.status });
  };

  const approveMutation = useMutation({
    mutationFn: ({ id, confirmationPhrase, remember }: { id: string; confirmationPhrase?: string; remember: boolean }) =>
      coreClient.approve(id, { confirmationPhrase, remember }),
    onSuccess: invalidate,
  });

  const denyMutation = useMutation({
    mutationFn: (id: string) => coreClient.denyApproval(id),
    onSuccess: invalidate,
  });

  return {
    confirmationPhrase: CONFIRMATION_PHRASE,
    busy: approveMutation.isPending || denyMutation.isPending,
    error: approveMutation.error ?? denyMutation.error,
    approve: (id: string, options: { confirmationPhrase?: string; remember: boolean }) =>
      approveMutation.mutate({ id, ...options }),
    deny: (id: string) => denyMutation.mutate(id),
  };
}
