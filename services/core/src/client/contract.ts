import type { ChatMode, PathScope, PermissionProfileId, PermissionRule, RiskLevel } from '@jarvis/types';

export const CORE_DEFAULT_PORT = 47821;

export interface SendChatBody {
  conversationId: string;
  content: string;
  mode: ChatMode;
  model?: string;
  retryFromMessageId?: string;
}

export interface CallToolBody {
  toolId: string;
  input: unknown;
  conversationId?: string;
  taskId?: string;
}

export interface ApproveBody {
  confirmationPhrase?: string;
  remember?: boolean;
}

export interface DenyBody {
  reason?: string;
}

export interface CreateConversationBody {
  mode: ChatMode;
  title?: string;
  model?: string;
}

export interface AddRuleBody {
  toolPattern: string;
  targetPattern?: string;
  effect: PermissionRule['effect'];
  maxRiskLevel: RiskLevel;
  note?: string;
  expiresAt?: string;
}

export interface AddScopeBody {
  path: string;
  mode: PathScope['mode'];
  effect: PathScope['effect'];
}

export interface SetProfileBody {
  profile: PermissionProfileId;
}

export interface ApiError {
  error: string;
}
