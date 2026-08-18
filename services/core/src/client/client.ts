import type {
  ApprovalRequest,
  AuditEvent,
  AuditQuery,
  ChatMessage,
  ChatStreamEvent,
  Conversation,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeSearchOptions,
  KnowledgeSource,
  KnowledgeStats,
  ModelInfo,
  ModelPullProgress,
  PathScope,
  PermissionProfileId,
  PermissionRule,
  ResourceSnapshot,
  SavedTask,
  SystemStatus,
  Task,
  TaskRun,
  ToolCallRecord,
} from '@jarvis/types';
import type { JarvisEvent } from '@jarvis/events';
import {
  CORE_DEFAULT_PORT,
  type AddRuleBody,
  type AddScopeBody,
  type ApproveBody,
  type CreateConversationBody,
  type KnowledgeSearchBody,
  type SavedTaskBody,
  type SendChatBody,
} from './contract.js';

export interface ToolDescriptorDto {
  id: string;
  name: string;
  category: string;
  description: string;
  baseRiskLevel: number;
  reversible: boolean;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: readonly string[] };
}

export interface CoreSettingsDto {
  permissionProfile: PermissionProfileId;
  defaultModel: string | null;
  ollamaEndpoint: string;
  qwenEndpoint: string;
  qwenAutoStart: boolean;
  theme: 'system' | 'light' | 'dark';
  embeddingModel: string;
  memoryEnabled: boolean;
  rememberConversations: boolean;
  desktopControlEnabled: boolean;
  browserControlEnabled: boolean;
}

/**
 * Typed client for Jarvis Core. This is the only way the UI reaches Core, and it
 * contains no Node-only imports so it runs inside the Tauri webview.
 */
export class JarvisClient {
  private readonly baseUrl: string;

  constructor(baseUrl = `http://127.0.0.1:${CORE_DEFAULT_PORT}`) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  getSystemStatus(): Promise<SystemStatus> {
    return this.get('/api/system/status');
  }
  getResources(): Promise<ResourceSnapshot> {
    return this.get('/api/system/resources');
  }

  listModels(): Promise<ModelInfo[]> {
    return this.get('/api/models');
  }
  loadModel(id: string): Promise<{ ok: boolean }> {
    return this.post(`/api/models/${encodeURIComponent(id)}/load`, {});
  }
  unloadModel(id: string): Promise<{ ok: boolean }> {
    return this.post(`/api/models/${encodeURIComponent(id)}/unload`, {});
  }
  deleteModel(id: string): Promise<{ ok: boolean }> {
    return this.delete(`/api/models/${encodeURIComponent(id)}`);
  }
  /** Streams download progress for a model that is not installed yet. */
  async *pullModel(id: string, signal?: AbortSignal): AsyncGenerator<ModelPullProgress> {
    const response = await fetch(`${this.baseUrl}/api/models/${encodeURIComponent(id)}/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Core rejected the pull request (${response.status}).`);
    }
    for await (const payload of readSse(response.body)) {
      if (payload === '[DONE]') return;
      const parsed = JSON.parse(payload) as ModelPullProgress | { error: string };
      if ('error' in parsed) throw new Error(parsed.error);
      yield parsed;
    }
  }

  listConversations(): Promise<Conversation[]> {
    return this.get('/api/conversations');
  }
  createConversation(body: CreateConversationBody): Promise<Conversation> {
    return this.post('/api/conversations', body);
  }
  deleteConversation(id: string): Promise<{ ok: boolean }> {
    return this.delete(`/api/conversations/${encodeURIComponent(id)}`);
  }
  listMessages(conversationId: string): Promise<ChatMessage[]> {
    return this.get(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
  }

  /** Streams assistant output. Abort the signal to stop generation. */
  async *sendChat(body: SendChatBody, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Core rejected the chat request (${response.status}).`);
    }
    for await (const payload of readSse(response.body)) {
      if (payload === '[DONE]') return;
      yield JSON.parse(payload) as ChatStreamEvent;
    }
  }

  listTasks(limit?: number): Promise<Task[]> {
    return this.get(`/api/tasks${limit ? `?limit=${limit}` : ''}`);
  }

  listSavedTasks(): Promise<SavedTask[]> {
    return this.get('/api/saved-tasks');
  }
  createSavedTask(body: SavedTaskBody): Promise<SavedTask> {
    return this.post('/api/saved-tasks', body);
  }
  updateSavedTask(id: string, body: SavedTaskBody): Promise<SavedTask> {
    return this.request('PATCH', `/api/saved-tasks/${encodeURIComponent(id)}`, body);
  }
  setSavedTaskEnabled(id: string, enabled: boolean): Promise<SavedTask> {
    return this.post(`/api/saved-tasks/${encodeURIComponent(id)}/enabled`, { enabled });
  }
  deleteSavedTask(id: string): Promise<{ ok: boolean }> {
    return this.delete(`/api/saved-tasks/${encodeURIComponent(id)}`);
  }
  runSavedTask(id: string): Promise<TaskRun> {
    return this.post(`/api/saved-tasks/${encodeURIComponent(id)}/run`, {});
  }
  listTaskRuns(options: { taskId?: string; limit?: number } = {}): Promise<TaskRun[]> {
    const params = new URLSearchParams();
    if (options.taskId) params.set('taskId', options.taskId);
    if (options.limit) params.set('limit', String(options.limit));
    const suffix = params.toString();
    return this.get(`/api/task-runs${suffix ? `?${suffix}` : ''}`);
  }
  cancelTaskRun(runId: string): Promise<TaskRun> {
    return this.post(`/api/task-runs/${encodeURIComponent(runId)}/cancel`, {});
  }

  listTools(): Promise<ToolDescriptorDto[]> {
    return this.get('/api/tools');
  }
  listToolCalls(limit?: number): Promise<ToolCallRecord[]> {
    return this.get(`/api/tools/calls${limit ? `?limit=${limit}` : ''}`);
  }
  callTool(toolId: string, input: unknown, conversationId?: string): Promise<ToolCallRecord> {
    return this.post('/api/tools/call', { toolId, input, conversationId });
  }

  listApprovals(pendingOnly = false): Promise<ApprovalRequest[]> {
    return this.get(`/api/approvals${pendingOnly ? '?pending=true' : ''}`);
  }
  approve(id: string, body: ApproveBody = {}): Promise<ToolCallRecord> {
    return this.post(`/api/approvals/${encodeURIComponent(id)}/approve`, body);
  }
  denyApproval(id: string, reason?: string): Promise<ToolCallRecord> {
    return this.post(`/api/approvals/${encodeURIComponent(id)}/deny`, { reason });
  }

  getPermissions(): Promise<{ profile: PermissionProfileId; rules: PermissionRule[]; scopes: PathScope[] }> {
    return this.get('/api/permissions');
  }
  setPermissionProfile(profile: PermissionProfileId): Promise<unknown> {
    return this.post('/api/permissions/profile', { profile });
  }
  addRule(body: AddRuleBody): Promise<PermissionRule> {
    return this.post('/api/permissions/rules', body);
  }
  deleteRule(id: string): Promise<{ ok: boolean }> {
    return this.delete(`/api/permissions/rules/${encodeURIComponent(id)}`);
  }
  addScope(body: AddScopeBody): Promise<PathScope> {
    return this.post('/api/permissions/scopes', body);
  }
  deleteScope(id: string): Promise<{ ok: boolean }> {
    return this.delete(`/api/permissions/scopes/${encodeURIComponent(id)}`);
  }

  listKnowledgeSources(): Promise<KnowledgeSource[]> {
    return this.get('/api/knowledge/sources');
  }
  addKnowledgeSource(path: string): Promise<KnowledgeSource> {
    return this.post('/api/knowledge/sources', { path });
  }
  deleteKnowledgeSource(id: string): Promise<{ ok: boolean }> {
    return this.delete(`/api/knowledge/sources/${encodeURIComponent(id)}`);
  }
  reindexKnowledgeSource(id: string): Promise<KnowledgeSource> {
    return this.post(`/api/knowledge/sources/${encodeURIComponent(id)}/reindex`, {});
  }
  listKnowledgeDocuments(sourceId: string): Promise<KnowledgeDocument[]> {
    return this.get(`/api/knowledge/sources/${encodeURIComponent(sourceId)}/documents`);
  }
  searchKnowledge(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeHit[]> {
    const body: KnowledgeSearchBody = { query, ...options };
    return this.post('/api/knowledge/search', body);
  }
  getKnowledgeStats(): Promise<KnowledgeStats> {
    return this.get('/api/knowledge/stats');
  }

  queryAudit(query: AuditQuery = {}): Promise<AuditEvent[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const suffix = params.toString();
    return this.get(`/api/audit${suffix ? `?${suffix}` : ''}`);
  }

  getSettings(): Promise<CoreSettingsDto> {
    return this.get('/api/settings');
  }
  updateSettings(patch: Partial<CoreSettingsDto>): Promise<CoreSettingsDto> {
    return this.request('PATCH', '/api/settings', patch);
  }

  /** Subscribe to Core's event stream. Returns an unsubscribe function. */
  subscribe(onEvent: (event: JarvisEvent) => void): () => void {
    const source = new EventSource(`${this.baseUrl}/api/events`);
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data as string) as JarvisEvent);
      } catch {
        // Ignore malformed frames rather than tearing down the stream.
      }
    };
    return () => source.close();
  }

  private get<T>(path: string): Promise<T> {
    return this.request('GET', path);
  }
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request('POST', path, body);
  }
  private delete<T>(path: string): Promise<T> {
    return this.request('DELETE', path);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : `${method} ${path} failed (${response.status}).`;
      throw new Error(message);
    }
    return payload as T;
  }
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
        index = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
