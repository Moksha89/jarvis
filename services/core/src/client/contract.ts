import type {
  ChatMode,
  KnowledgeCorpus,
  McpServerInput,
  PathScope,
  PermissionProfileId,
  PermissionRule,
  RiskLevel,
  SavedTaskInput,
  WorkflowInput,
} from '@jarvis/types';

export const CORE_DEFAULT_PORT = 47821;

export interface SendChatBody {
  conversationId: string;
  content: string;
  mode: ChatMode;
  model?: string;
  retryFromMessageId?: string;
  /** Agent mode only: tool-step budget for this turn. */
  maxSteps?: number;
}

export type SavedTaskBody = SavedTaskInput;

export interface SetTaskEnabledBody {
  enabled: boolean;
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

export interface AddKnowledgeSourceBody {
  path: string;
}

export interface KnowledgeSearchBody {
  query: string;
  limit?: number;
  corpus?: KnowledgeCorpus;
  minScore?: number;
}

export type AddSkillServerBody = McpServerInput;

export interface SetSkillServerEnabledBody {
  enabled: boolean;
}

export type WorkflowBody = WorkflowInput;

export interface SetWorkflowEnabledBody {
  enabled: boolean;
}

export interface RunWorkflowBody {
  input?: string;
}

export interface SetProfileBody {
  profile: PermissionProfileId;
}

export interface ApiError {
  error: string;
}
