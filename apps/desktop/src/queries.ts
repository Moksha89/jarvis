import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type {
  AuditQuery,
  BrowserPageInfo,
  BrowserShot,
  BrowserSnapshot,
  DesktopElement,
  DesktopShot,
  DesktopWindow,
  KnowledgeCorpus,
  KnowledgeIndexProgress,
  PermissionProfileId,
  SavedTaskInput,
  ToolCallRecord,
} from '@jarvis/types';
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
  knowledgeSources: ['knowledge', 'sources'] as const,
  knowledgeStats: ['knowledge', 'stats'] as const,
  knowledgeDocuments: (sourceId: string) => ['knowledge', 'documents', sourceId] as const,
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

export function useKnowledgeSources() {
  return useQuery({ queryKey: queryKeys.knowledgeSources, queryFn: () => coreClient.listKnowledgeSources() });
}

export function useKnowledgeStats() {
  return useQuery({ queryKey: queryKeys.knowledgeStats, queryFn: () => coreClient.getKnowledgeStats() });
}

export function useKnowledgeDocuments(sourceId: string | null) {
  return useQuery({
    queryKey: queryKeys.knowledgeDocuments(sourceId ?? 'none'),
    queryFn: () => coreClient.listKnowledgeDocuments(sourceId as string),
    enabled: Boolean(sourceId),
  });
}

export function useKnowledgeActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
  };

  const addSource = useMutation({ mutationFn: (path: string) => coreClient.addKnowledgeSource(path), onSuccess: invalidate });
  const removeSource = useMutation({
    mutationFn: (id: string) => coreClient.deleteKnowledgeSource(id),
    onSuccess: invalidate,
  });
  const reindex = useMutation({
    mutationFn: (id: string) => coreClient.reindexKnowledgeSource(id),
    onSuccess: invalidate,
  });
  const search = useMutation({
    mutationFn: ({ query, corpus }: { query: string; corpus?: KnowledgeCorpus }) =>
      coreClient.searchKnowledge(query, { corpus }),
  });

  return { addSource, removeSource, reindex, search };
}

/**
 * Desktop control runs through the ordinary tool path, so a click or keystroke is
 * classified, approved and audited exactly like a filesystem or shell call.
 */
export function useDesktopActions() {
  const queryClient = useQueryClient();
  const afterCall = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.toolCalls });
  };

  const windows = useMutation({
    mutationFn: async (): Promise<DesktopWindow[]> =>
      unwrapToolCall<DesktopWindow[]>(await coreClient.callTool('desktop.windows', {})) ?? [],
    onSuccess: afterCall,
  });
  const inspect = useMutation({
    mutationFn: async (handle: string): Promise<DesktopElement[]> =>
      unwrapToolCall<DesktopElement[]>(await coreClient.callTool('desktop.inspect', { handle })) ?? [],
    onSuccess: afterCall,
  });
  const screenshot = useMutation({
    mutationFn: async (handle?: string): Promise<DesktopShot | undefined> =>
      unwrapToolCall<DesktopShot>(await coreClient.callTool('desktop.screenshot', handle ? { handle } : {})),
    onSuccess: afterCall,
  });
  const focus = useMutation({
    mutationFn: async (handle: string) => unwrapToolCall(await coreClient.callTool('desktop.focus', { handle })),
    onSuccess: afterCall,
  });
  const click = useMutation({
    mutationFn: async ({ handle, element }: { handle: string; element: string }) =>
      unwrapToolCall(await coreClient.callTool('desktop.click', { handle, element })),
    onSuccess: afterCall,
  });
  const type = useMutation({
    mutationFn: async (text: string) => unwrapToolCall(await coreClient.callTool('desktop.type', { text })),
    onSuccess: afterCall,
  });
  const keys = useMutation({
    mutationFn: async (value: string) => unwrapToolCall(await coreClient.callTool('desktop.keys', { keys: value })),
    onSuccess: afterCall,
  });

  return { windows, inspect, screenshot, focus, click, type, keys };
}

/**
 * Browsing runs through the same tool path: opening and reading a page are low
 * risk, while clicking and filling in a form need the browser control switch.
 */
export function useBrowserActions() {
  const queryClient = useQueryClient();
  const afterCall = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.toolCalls });
  };

  const read = useMutation({
    mutationFn: async (): Promise<BrowserSnapshot | undefined> =>
      unwrapToolCall<BrowserSnapshot>(await coreClient.callTool('browser.read', {})),
    onSuccess: afterCall,
  });
  const screenshot = useMutation({
    mutationFn: async (fullPage: boolean): Promise<BrowserShot | undefined> =>
      unwrapToolCall<BrowserShot>(await coreClient.callTool('browser.screenshot', { fullPage })),
    onSuccess: afterCall,
  });

  /**
   * Anything that navigates makes the last read stale, and a stale list of buttons
   * invites clicking a name that belongs to the page that was left.
   */
  const afterNavigation = () => {
    afterCall();
    read.reset();
    screenshot.reset();
  };

  const open = useMutation({
    mutationFn: async (url: string): Promise<BrowserPageInfo | undefined> =>
      unwrapToolCall<BrowserPageInfo>(await coreClient.callTool('browser.open', { url })),
    onSuccess: afterNavigation,
  });
  const click = useMutation({
    mutationFn: async (target: string): Promise<BrowserPageInfo | undefined> =>
      unwrapToolCall<BrowserPageInfo>(await coreClient.callTool('browser.click', { target })),
    onSuccess: afterNavigation,
  });
  const type = useMutation({
    mutationFn: async ({
      target,
      text,
      submit,
    }: {
      target: string;
      text: string;
      submit: boolean;
    }): Promise<BrowserPageInfo | undefined> =>
      unwrapToolCall<BrowserPageInfo>(
        await coreClient.callTool('browser.type', { target: target === '' ? undefined : target, text, submit }),
      ),
    onSuccess: afterNavigation,
  });
  const close = useMutation({
    mutationFn: async () => unwrapToolCall(await coreClient.callTool('browser.close', {})),
    onSuccess: () => {
      afterNavigation();
      open.reset();
      click.reset();
      type.reset();
    },
  });

  return { open, read, screenshot, click, type, close };
}

/**
 * A tool call that needs approval comes back pending with no data, and a refusal
 * comes back with an error, so both have to surface instead of an empty result.
 */
function unwrapToolCall<T>(record: ToolCallRecord): T | undefined {
  if (record.status === 'pending-approval') {
    throw new Error('Waiting for your approval — confirm it in the shield at the top right, then try again.');
  }
  if (record.result && !record.result.ok) {
    throw new Error(record.result.error ?? record.result.summary);
  }
  if (record.status !== 'succeeded') {
    throw new Error(`The call ended as ${record.status}.`);
  }
  return record.result?.data as T | undefined;
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

/**
 * Live indexing counts, held as component state instead of the query cache: progress
 * arrives once per file and is stale the moment it is read.
 */
export function useKnowledgeProgress(): Record<string, KnowledgeIndexProgress> {
  const [progress, setProgress] = useState<Record<string, KnowledgeIndexProgress>>({});
  useEffect(() => {
    return coreClient.subscribe((event) => {
      if (event.name !== 'knowledge.index.progress') return;
      const update = event.payload;
      setProgress((previous) => {
        if (update.done) {
          const rest = { ...previous };
          delete rest[update.sourceId];
          return rest;
        }
        return { ...previous, [update.sourceId]: update };
      });
    });
  }, []);
  return progress;
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
        case 'knowledge.source.changed':
        case 'knowledge.source.deleted':
          void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
          break;
        case 'knowledge.index.progress':
          // One event per file: refetching here would re-query Core (and Ollama, for
          // stats) thousands of times for one folder. Live counts come from
          // `useKnowledgeProgress`; the finished index invalidates once.
          if (event.payload.done) void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
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
