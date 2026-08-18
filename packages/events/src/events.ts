import type {
  ApprovalRequest,
  AuditEvent,
  ChatStreamEvent,
  KnowledgeIndexProgress,
  KnowledgeSource,
  McpServer,
  ModelPullProgress,
  ModelRuntimeInfo,
  SavedTask,
  Task,
  TaskRun,
  ToolCallRecord,
} from '@jarvis/types';

/** The single event vocabulary shared by Core, adapters and the UI. */
export interface JarvisEventMap {
  'chat.stream': ChatStreamEvent;
  'task.changed': Task;
  'task.saved.changed': SavedTask;
  'task.saved.deleted': { id: string };
  'task.run.changed': TaskRun;
  'model.pull.progress': ModelPullProgress & { model: string };
  'knowledge.index.progress': KnowledgeIndexProgress;
  'knowledge.source.changed': KnowledgeSource;
  'knowledge.source.deleted': { id: string };
  'mcp.server.changed': McpServer;
  'mcp.server.deleted': { id: string };
  'tool.call.changed': ToolCallRecord;
  'approval.requested': ApprovalRequest;
  'approval.resolved': ApprovalRequest;
  'audit.appended': AuditEvent;
  'runtime.status': ModelRuntimeInfo;
  'core.log': { level: 'debug' | 'info' | 'warn' | 'error'; message: string; time: string };
}

export type JarvisEventName = keyof JarvisEventMap;

export type JarvisEvent = {
  [K in JarvisEventName]: { name: K; payload: JarvisEventMap[K]; time: string };
}[JarvisEventName];
