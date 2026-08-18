import { cpus, freemem, homedir, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import type {
  ApprovalRequest,
  AuditEvent,
  AuditQuery,
  ChatMode,
  ChatStreamEvent,
  Conversation,
  ChatMessage,
  JarvisTool,
  ModelInfo,
  PathScope,
  PermissionProfileId,
  PermissionRule,
  ResourceSnapshot,
  SystemStatus,
  Task,
  ToolCallRecord,
} from '@jarvis/types';
import { EventBus } from '@jarvis/events';
import { PermissionEngine } from '@jarvis/permissions';
import { createFilesystemTools, createPathGuard, createShellTools, ToolRegistry } from '@jarvis/tools';
import { OllamaAdapter, QwenCodeAgentAdapter, StubAgentAdapter } from '@jarvis/adapters';
import { openDatabase, type JarvisDatabase } from './db/database.js';
import { AuditStore } from './store/audit-store.js';
import { ConversationStore } from './store/conversation-store.js';
import { PermissionStore } from './store/permission-store.js';
import { DEFAULT_SETTINGS, SettingsStore, type JarvisSettings } from './store/settings-store.js';
import { ChatService } from './services/chat-service.js';
import { ModelRouter } from './services/model-router.js';
import { TaskManager } from './services/task-manager.js';
import { ToolExecutor, type ApproveOptions, type ToolCallOptions } from './services/tool-executor.js';

export const CORE_VERSION = '0.1.0';

export interface JarvisCoreOptions {
  /** SQLite file path, or `:memory:` for tests. */
  databaseFile?: string;
  /** Set false in tests to avoid spawning `qwen serve`. */
  enableAgent?: boolean;
}

export interface ToolDescriptor {
  id: string;
  name: string;
  category: JarvisTool['category'];
  description: string;
  baseRiskLevel: JarvisTool['baseRiskLevel'];
  reversible: boolean;
  inputSchema: JarvisTool['inputSchema'];
}

/**
 * The typed boundary the UI (and any future client) talks to. Nothing outside this
 * class touches SQLite, the permission engine, adapters or tools directly.
 */
export class JarvisCore {
  readonly bus = new EventBus();
  private readonly db: JarvisDatabase;
  private readonly settingsStore: SettingsStore;
  private readonly permissionStore: PermissionStore;
  private readonly conversationStore: ConversationStore;
  private readonly auditStore: AuditStore;
  private readonly registry = new ToolRegistry();
  private readonly engine: PermissionEngine;
  private readonly executor: ToolExecutor;
  private readonly runtime: OllamaAdapter;
  private readonly agent: QwenCodeAgentAdapter | StubAgentAdapter;
  private readonly agentMode: 'qwen-serve' | 'stub';
  private readonly tasks: TaskManager;
  private readonly chat: ChatService;
  private readonly startedAt = Date.now();

  constructor(options: JarvisCoreOptions = {}) {
    this.db = openDatabase(options.databaseFile ?? defaultDatabaseFile());
    this.settingsStore = new SettingsStore(this.db);
    this.permissionStore = new PermissionStore(this.db);
    this.conversationStore = new ConversationStore(this.db);
    this.auditStore = new AuditStore(this.db);

    const settings = this.settingsStore.getAll();
    this.engine = new PermissionEngine({
      profile: settings.permissionProfile,
      rules: this.permissionStore.listRules(),
      scopes: this.permissionStore.listScopes(),
    });

    const guard = createPathGuard(() => this.permissionStore.listScopes());
    for (const tool of [...createFilesystemTools(guard), ...createShellTools(guard)]) {
      this.registry.register(tool);
    }

    this.runtime = new OllamaAdapter({ endpoint: settings.ollamaEndpoint });
    const router = new ModelRouter(this.runtime, () => this.settingsStore.getAll().defaultModel);

    // Qwen Code is opt-in: when it cannot be reached, the stub keeps the same
    // interface and routes chat through the model runtime instead.
    if (options.enableAgent === false) {
      this.agent = new StubAgentAdapter(this.runtime, () => this.settingsStore.getAll().defaultModel ?? undefined);
      this.agentMode = 'stub';
    } else {
      this.agent = new QwenCodeAgentAdapter({
        endpoint: settings.qwenEndpoint,
        autoStart: settings.qwenAutoStart,
      });
      this.agentMode = 'qwen-serve';
    }

    this.tasks = new TaskManager(this.db, this.bus);
    this.executor = new ToolExecutor(this.db, this.registry, this.engine, this.auditStore, this.bus, (rule) =>
      this.addPermissionRule({ ...rule, effect: 'allow', note: 'Created from an approval dialog' }),
    );
    this.chat = new ChatService(
      this.conversationStore,
      router,
      this.runtime,
      this.tasks,
      this.bus,
      this.agentMode === 'qwen-serve' ? this.agent : undefined,
    );
  }

  // ---------------------------------------------------------------- system

  async getSystemStatus(): Promise<SystemStatus> {
    const settings = this.settingsStore.getAll();
    const runtime = await this.runtime.status();
    const agentStatus = await this.agent.getStatus();
    const available = 'available' in agentStatus ? agentStatus.available : true;
    const message = 'message' in agentStatus ? agentStatus.message : 'Session active.';
    return {
      core: {
        version: CORE_VERSION,
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
        platform: platform(),
      },
      runtime,
      agent: { id: this.agent.id, available, mode: this.agentMode, message },
      resources: this.getResources(),
      pendingApprovals: this.executor.listPendingApprovals().length,
      profile: settings.permissionProfile,
    };
  }

  getResources(): ResourceSnapshot {
    const load = cpus();
    const busy = load.reduce((total, cpu) => total + cpu.times.user + cpu.times.sys, 0);
    const idle = load.reduce((total, cpu) => total + cpu.times.idle, 0);
    return {
      cpuPercent: Math.round((busy / Math.max(busy + idle, 1)) * 100),
      memoryUsedBytes: totalmem() - freemem(),
      memoryTotalBytes: totalmem(),
      time: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------- models

  async listModels(): Promise<ModelInfo[]> {
    return await this.runtime.listModels();
  }

  async loadModel(model: string): Promise<void> {
    await this.runtime.loadModel(model);
    this.bus.emit('runtime.status', await this.runtime.status());
  }

  async unloadModel(model: string): Promise<void> {
    await this.runtime.unloadModel(model);
    this.bus.emit('runtime.status', await this.runtime.status());
  }

  // ---------------------------------------------------------------- chat

  listConversations(): Conversation[] {
    return this.conversationStore.list();
  }

  createConversation(options: { mode: ChatMode; title?: string; model?: string }): Conversation {
    return this.conversationStore.create(options);
  }

  deleteConversation(id: string): void {
    this.conversationStore.delete(id);
  }

  listMessages(conversationId: string): ChatMessage[] {
    return this.conversationStore.listMessages(conversationId);
  }

  sendChat(options: {
    conversationId: string;
    content: string;
    mode: ChatMode;
    model?: string;
    retryFromMessageId?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<ChatStreamEvent> {
    return this.chat.send(options);
  }

  // ---------------------------------------------------------------- tasks

  listTasks(limit?: number): Task[] {
    return this.tasks.list({ limit });
  }

  // ---------------------------------------------------------------- tools

  listTools(): ToolDescriptor[] {
    return this.registry.list().map((tool) => ({
      id: tool.id,
      name: tool.name,
      category: tool.category,
      description: tool.description,
      baseRiskLevel: tool.baseRiskLevel,
      reversible: tool.reversible,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(toolId: string, input: unknown, options: ToolCallOptions = {}): Promise<ToolCallRecord> {
    return await this.executor.call(toolId, input, options);
  }

  listToolCalls(limit?: number): ToolCallRecord[] {
    return this.executor.listCalls(limit);
  }

  // ---------------------------------------------------------------- approvals

  listApprovals(options: { pendingOnly?: boolean } = {}): ApprovalRequest[] {
    return options.pendingOnly ? this.executor.listPendingApprovals() : this.executor.listApprovals();
  }

  async approve(approvalId: string, options: ApproveOptions = {}): Promise<ToolCallRecord> {
    return await this.executor.approve(approvalId, options);
  }

  async deny(approvalId: string, reason?: string): Promise<ToolCallRecord> {
    return await this.executor.deny(approvalId, reason);
  }

  // ---------------------------------------------------------------- permissions

  getPermissionState(): { profile: PermissionProfileId; rules: PermissionRule[]; scopes: PathScope[] } {
    return {
      profile: this.settingsStore.getAll().permissionProfile,
      rules: this.permissionStore.listRules(),
      scopes: this.permissionStore.listScopes(),
    };
  }

  setPermissionProfile(profile: PermissionProfileId): void {
    this.settingsStore.patch({ permissionProfile: profile });
    this.refreshPermissionContext();
  }

  addPermissionRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): PermissionRule {
    const created = this.permissionStore.addRule(rule);
    this.refreshPermissionContext();
    return created;
  }

  deletePermissionRule(id: string): void {
    this.permissionStore.deleteRule(id);
    this.refreshPermissionContext();
  }

  addPathScope(scope: Omit<PathScope, 'id' | 'createdAt'>): PathScope {
    const created = this.permissionStore.addScope(scope);
    this.refreshPermissionContext();
    return created;
  }

  deletePathScope(id: string): void {
    this.permissionStore.deleteScope(id);
    this.refreshPermissionContext();
  }

  // ---------------------------------------------------------------- audit & settings

  queryAudit(query: AuditQuery = {}): AuditEvent[] {
    return this.auditStore.query(query);
  }

  getSettings(): JarvisSettings {
    return this.settingsStore.getAll();
  }

  updateSettings(patch: Partial<JarvisSettings>): JarvisSettings {
    const updated = this.settingsStore.patch(patch);
    this.refreshPermissionContext();
    return updated;
  }

  close(): void {
    this.bus.clear();
    this.db.close();
  }

  private refreshPermissionContext(): void {
    this.engine.setContext({
      profile: this.settingsStore.getAll().permissionProfile,
      rules: this.permissionStore.listRules(),
      scopes: this.permissionStore.listScopes(),
    });
  }
}

export function defaultDatabaseFile(): string {
  const base =
    platform() === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : join(homedir(), '.local', 'share');
  return join(base, 'Jarvis', 'jarvis.sqlite');
}

export { DEFAULT_SETTINGS };
export type { JarvisSettings, ApproveOptions, ToolCallOptions };
