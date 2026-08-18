import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AuditQuery, PermissionProfileId, SavedTaskInput } from '@jarvis/types';
import type { CoreSettingsDto } from '@jarvis/core/client';
import { coreClient } from './core-client.js';

export const queryKeys = {
  status: ['system', 'status'] as const,
  models: ['models'] as const,
  conversations: ['conversations'] as const,
  messages: (id: string) => ['messages', id] as const,
  tasks: ['tasks'] as const,
  savedTasks: ['saved-tasks'] as const,
  taskRuns: ['task-runs'] as const,
  tools: ['tools'] as const,
  toolCalls: ['tool-calls'] as const,
  approvals: ['approvals'] as const,
  permissions: ['permissions'] as const,
  audit: (query: AuditQuery) => ['audit', query] as const,
  settings: ['settings'] as const,
};

export function useSystemStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: () => coreClient.getSystemStatus(),
    refetchInterval: 5_000,
  });
}

export function useModels() {
  return useQuery({ queryKey: queryKeys.models, queryFn: () => coreClient.listModels() });
}

export function useConversations() {
  return useQuery({ queryKey: queryKeys.conversations, queryFn: () => coreClient.listConversations() });
}

export function useMessages(conversationId: string | null) {
  return useQuery({
    queryKey: queryKeys.messages(conversationId ?? 'none'),
    queryFn: () => coreClient.listMessages(conversationId as string),
    enabled: Boolean(conversationId),
  });
}

export function useTasks() {
  return useQuery({ queryKey: queryKeys.tasks, queryFn: () => coreClient.listTasks(100) });
}

export function useSavedTasks() {
  return useQuery({ queryKey: queryKeys.savedTasks, queryFn: () => coreClient.listSavedTasks() });
}

export function useTaskRuns(taskId?: string) {
  return useQuery({
    queryKey: [...queryKeys.taskRuns, taskId ?? 'all'] as const,
    queryFn: () => coreClient.listTaskRuns({ taskId, limit: 50 }),
  });
}

/** Saved-task mutations all refresh the task list and its run history together. */
export function useSavedTaskActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.savedTasks });
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskRuns });
  };

  const create = useMutation({ mutationFn: (input: SavedTaskInput) => coreClient.createSavedTask(input), onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: SavedTaskInput }) => coreClient.updateSavedTask(id, input),
    onSuccess: invalidate,
  });
  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => coreClient.setSavedTaskEnabled(id, enabled),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => coreClient.deleteSavedTask(id), onSuccess: invalidate });
  const runNow = useMutation({ mutationFn: (id: string) => coreClient.runSavedTask(id), onSuccess: invalidate });
  const cancelRun = useMutation({ mutationFn: (runId: string) => coreClient.cancelTaskRun(runId), onSuccess: invalidate });

  return { create, update, setEnabled, remove, runNow, cancelRun };
}

export function useTools() {
  return useQuery({ queryKey: queryKeys.tools, queryFn: () => coreClient.listTools() });
}

export function usePendingApprovals() {
  return useQuery({
    queryKey: queryKeys.approvals,
    queryFn: () => coreClient.listApprovals(true),
    refetchInterval: 3_000,
  });
}

export function usePermissions() {
  return useQuery({ queryKey: queryKeys.permissions, queryFn: () => coreClient.getPermissions() });
}

export function useAudit(query: AuditQuery) {
  return useQuery({ queryKey: queryKeys.audit(query), queryFn: () => coreClient.queryAudit(query) });
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => coreClient.getSettings() });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<CoreSettingsDto>) => coreClient.updateSettings(patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.status });
    },
  });
}

export function useSetProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile: PermissionProfileId) => coreClient.setPermissionProfile(profile),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.permissions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.status });
    },
  });
}

/** Bridges Core's SSE event stream into TanStack Query cache invalidation. */
export function useCoreEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    return coreClient.subscribe((event) => {
      switch (event.name) {
        case 'task.changed':
          void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
          break;
        case 'task.saved.changed':
        case 'task.saved.deleted':
          void queryClient.invalidateQueries({ queryKey: queryKeys.savedTasks });
          break;
        case 'task.run.changed':
          void queryClient.invalidateQueries({ queryKey: queryKeys.taskRuns });
          void queryClient.invalidateQueries({ queryKey: queryKeys.savedTasks });
          break;
        case 'approval.requested':
        case 'approval.resolved':
          void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
          void queryClient.invalidateQueries({ queryKey: queryKeys.status });
          break;
        case 'tool.call.changed':
          void queryClient.invalidateQueries({ queryKey: queryKeys.toolCalls });
          break;
        case 'audit.appended':
          void queryClient.invalidateQueries({ queryKey: ['audit'] });
          break;
        case 'runtime.status':
          void queryClient.invalidateQueries({ queryKey: queryKeys.status });
          break;
        default:
          break;
      }
    });
  }, [queryClient]);
}
