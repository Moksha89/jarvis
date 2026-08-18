import type { ModelRuntimeInfo } from './model.js';

export interface ResourceSnapshot {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  time: string;
}

/** Powers the Home dashboard system strip. */
export interface SystemStatus {
  core: { version: string; uptimeSeconds: number; platform: string };
  runtime: ModelRuntimeInfo;
  agent: { id: string; available: boolean; mode: 'qwen-serve' | 'stub'; message: string };
  resources: ResourceSnapshot;
  pendingApprovals: number;
  profile: string;
}
