export type TaskStatus = 'queued' | 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  title: string;
  kind: 'chat' | 'tool' | 'agent';
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  conversationId?: string;
  detail?: string;
  error?: string;
}
