import type {
  ApprovalRequest,
  AuditEvent,
  ChatStreamEvent,
  ModelRuntimeInfo,
  Task,
  ToolCallRecord,
} from '@jarvis/types';

/** The single event vocabulary shared by Core, adapters and the UI. */
export interface JarvisEventMap {
  'chat.stream': ChatStreamEvent;
  'task.changed': Task;
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
