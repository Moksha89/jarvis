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
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeSearchOptions,
  KnowledgeSource,
  KnowledgeStats,
  McpServer,
  McpServerInput,
  ModelInfo,
  ModelPullProgress,
  PathScope,
  PermissionProfileId,
  PermissionRule,
  ResourceSnapshot,
  SavedTask,
  SavedTaskInput,
  SystemStatus,
  Task,
  TaskRun,
  ToolCallRecord,
} from '@jarvis/types';
import { EventBus } from '@jarvis/events';
import { PermissionEngine } from '@jarvis/permissions';
import {
  createBrowserTools,
  createDesktopTools,
  createFilesystemTools,
  createPathGuard,
  createShellTools,
  PlaywrightBrowserBridge,
  ToolRegistry,
} from '@jarvis/tools';
import { OllamaAdapter, QwenCodeAgentAdapter, StubAgentAdapter } from '@jarvis/adapters';
import { openDatabase, type JarvisDatabase } from './db/database.js';
import { AuditStore } from './store/audit-store.js';
import { ConversationStore } from './store/conversation-store.js';
import { KnowledgeStore } from './store/knowledge-store.js';
import { McpStore } from './store/mcp-store.js';
import { PermissionStore } from './store/permission-store.js';
import { SavedTaskStore } from './store/saved-task-store.js';
import { DEFAULT_SETTINGS, SettingsStore, type JarvisSettings } from './store/settings-store.js';
import { AgentRunner } from './services/agent-runner.js';
import { ChatService } from './services/chat-service.js';
import { KnowledgeService } from './services/knowledge-service.js';
import { McpManager, type McpConnect } from './services/mcp-manager.js';
import { createKnowledgeSearchTool } from './services/knowledge-tool.js';
import { ModelRouter } from './services/model-router.js';
import { TaskManager } from './services/task-manager.js';
import { TaskScheduler } from './services/task-scheduler.js';
import { ToolExecutor, type ApproveOptions, type ToolCallOptions } from './services/tool-executor.js';

export const CORE_VERSION = '0.1.0';

export interface JarvisCoreOptions {
  /** SQLite file path, or `:memory:` for tests. */
  databaseFile?: string;
  /** Set false in tests to avoid spawning `qwen serve`. */
  enableAgent?: boolean;
  /** Set false in tests so no background schedule fires. */
  enableScheduler?: boolean;
  /** Set false in tests so no skill server is spawned. */
  enableSkillServers?: boolean;
  /** Test seam: connect to a skill server without spawning a process. */
  mcpConnect?: McpConnect;
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
  private readonly savedTasks: SavedTaskStore;
  private readonly scheduler: TaskScheduler;
  private readonly chat: ChatService;
  private readonly knowledgeStore: KnowledgeStore;
  private readonly knowledge: KnowledgeService;
  private readonly browserBridge = new PlaywrightBrowserBridge();
  private readonly mcpStore: McpStore;
  private readonly mcp: McpManager;
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
    const desktopTools =
      platform() === 'win32'
        ? createDesktopTools({ controlEnabled: () => this.settingsStore.getAll().desktopControlEnabled })
        : [];
    const browserTools = createBrowserTools({
      controlEnabled: () => this.settingsStore.getAll().browserControlEnabled,
      bridge: this.browserBridge,
    });
    for (const tool of [
      ...createFilesystemTools(guard),
      ...createShellTools(guard),
      ...desktopTools,
      ...browserTools,
    ]) {
      this.registry.register(tool);
    }

    this.runtime = new OllamaAdapter({ endpoint: settings.ollamaEndpoint });
    this.knowledgeStore = new KnowledgeStore(this.db);
    this.knowledge = new KnowledgeService({
      store: this.knowledgeStore,
      runtime: this.runtime,
      guard,
      settings: () => this.settingsStore.getAll(),
      bus: this.bus,
    });
    this.registry.register(createKnowledgeSearchTool(this.knowledge));
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
    const agentRunner = new AgentRunner(this.runtime, this.registry, this.executor, this.bus);
    this.chat = new ChatService(
      this.conversationStore,
      router,
      this.runtime,
      this.tasks,
      this.bus,
      agentRunner,
      this.knowledge,
      this.agentMode === 'qwen-serve' ? this.agent : undefined,
    );

    this.savedTasks = new SavedTaskStore(this.db);
    this.scheduler = new TaskScheduler(this.savedTasks, this.conversationStore, this.bus, (invocation) =>
      this.chat.send({
        conversationId: invocation.conversationId,
        content: invocation.prompt,
        mode: invocation.mode,
        model: invocation.model,
        maxSteps: invocation.maxSteps,
        signal: invocation.signal,
        unattended: true,
      }),
    );
    if (options.enableScheduler !== false) {
      this.scheduler.start();
    }

    this.mcpStore = new McpStore(this.db);
    this.mcp = new McpManager({
      store: this.mcpStore,
      registry: this.registry,
      bus: this.bus,
      connect: options.mcpConnect,
    });
    // Skill servers are external processes: connecting is best-effort and never
    // delays startup, so a broken server shows as disconnected instead of hanging Core.
    if (options.enableSkillServers !== false) {
      void this.mcp.start();
    }
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

  /** Download a model, republishing the runtime's progress on the event bus. */
  async *pullModel(model: string, signal?: AbortSignal): AsyncGenerator<ModelPullProgress> {
    for await (const progress of this.runtime.pullModel(model, signal)) {
      this.bus.emit('model.pull.progress', { ...progress, model });
      yield progress;
    }
  }

  async deleteModel(model: string): Promise<void> {
    await this.runtime.deleteModel(model);
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
    // Deleting a conversation has to delete what Jarvis remembered from it too,
    // otherwise it keeps answering from a transcript the user removed.
    this.knowledge.forgetConversation(id);
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
    /** Agent mode only: tool-step budget for this turn. */
    maxSteps?: number;
  }): AsyncGenerator<ChatStreamEvent> {
    return this.chat.send(options);
  }

  // ---------------------------------------------------------------- tasks

  listTasks(limit?: number): Task[] {
    return this.tasks.list({ limit });
  }

  listSavedTasks(): SavedTask[] {
    return this.savedTasks.list();
  }

  createSavedTask(input: SavedTaskInput): SavedTask {
    const created = this.savedTasks.create(input);
    this.bus.emit('task.saved.changed', created);
    return created;
  }

  updateSavedTask(id: string, input: SavedTaskInput): SavedTask {
    const updated = this.savedTasks.update(id, input);
    this.bus.emit('task.saved.changed', updated);
    return updated;
  }

  setSavedTaskEnabled(id: string, enabled: boolean): SavedTask {
    const updated = this.savedTasks.setEnabled(id, enabled);
    this.bus.emit('task.saved.changed', updated);
    return updated;
  }

  deleteSavedTask(id: string): void {
    // Stop the work first: deleting the rows under a live run leaves it writing to nothing.
    this.scheduler.cancelRunsForTask(id);
    this.savedTasks.delete(id);
    this.bus.emit('task.saved.deleted', { id });
  }

  runSavedTask(id: string): TaskRun {
    return this.scheduler.runNow(id);
  }

  cancelTaskRun(runId: string): TaskRun {
    return this.scheduler.cancelRun(runId);
  }

  listTaskRuns(options: { taskId?: string; limit?: number } = {}): TaskRun[] {
    return this.savedTasks.listRuns(options);
  }

  // ---------------------------------------------------------------- knowledge

  listKnowledgeSources(): KnowledgeSource[] {
    return this.knowledge.listSources();
  }

  async addKnowledgeSource(path: string): Promise<KnowledgeSource> {
    return await this.knowledge.addSource(path);
  }

  deleteKnowledgeSource(id: string): void {
    this.knowledge.removeSource(id);
  }

  async reindexKnowledgeSource(id: string): Promise<KnowledgeSource> {
    return await this.knowledge.indexSource(id);
  }

  listKnowledgeDocuments(sourceId: string): KnowledgeDocument[] {
    return this.knowledge.listDocuments(sourceId);
  }

  async searchKnowledge(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeHit[]> {
    return await this.knowledge.search(query, options);
  }

  async getKnowledgeStats(): Promise<KnowledgeStats> {
    return await this.knowledge.stats();
  }

  // ---------------------------------------------------------------- skill servers

  listSkillServers(): McpServer[] {
    return this.mcp.list();
  }

  async addSkillServer(input: McpServerInput): Promise<McpServer> {
    return await this.mcp.add(input);
  }

  async setSkillServerEnabled(id: string, enabled: boolean): Promise<McpServer> {
    return await this.mcp.setEnabled(id, enabled);
  }

  async reconnectSkillServer(id: string): Promise<McpServer> {
    return await this.mcp.reconnect(id);
  }

  async deleteSkillServer(id: string): Promise<void> {
    await this.mcp.remove(id);
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
    const previous = this.settingsStore.getAll().permissionProfile;
    this.settingsStore.patch({ permissionProfile: profile });
    this.refreshPermissionContext();
    this.auditPermissionChange('set-profile', profile, `Permission profile changed from ${previous} to ${profile}.`, 3);
  }

  addPermissionRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): PermissionRule {
    const created = this.permissionStore.addRule(rule);
    this.refreshPermissionContext();
    this.auditPermissionChange(
      'add-rule',
      created.toolPattern,
      `Rule added: ${created.effect} ${created.toolPattern}${created.targetPattern ? ` on ${created.targetPattern}` : ''} up to risk L${created.maxRiskLevel}.`,
      created.effect === 'allow' ? 3 : 1,
    );
    return created;
  }

  deletePermissionRule(id: string): void {
    const removed = this.permissionStore.listRules().find((rule) => rule.id === id);
    this.permissionStore.deleteRule(id);
    this.refreshPermissionContext();
    this.auditPermissionChange(
      'delete-rule',
      removed?.toolPattern ?? id,
      `Rule removed: ${removed ? `${removed.effect} ${removed.toolPattern}` : id}.`,
      1,
    );
  }

  addPathScope(scope: Omit<PathScope, 'id' | 'createdAt'>): PathScope {
    const created = this.permissionStore.addScope(scope);
    this.refreshPermissionContext();
    this.auditPermissionChange(
      'add-scope',
      created.path,
      `Folder scope added: ${created.effect} ${created.mode} on ${created.path}.`,
      created.effect === 'allow' && created.mode === 'read-write' ? 3 : 2,
    );
    return created;
  }

  deletePathScope(id: string): void {
    const removed = this.permissionStore.listScopes().find((scope) => scope.id === id);
    this.permissionStore.deleteScope(id);
    this.refreshPermissionContext();
    this.auditPermissionChange('delete-scope', removed?.path ?? id, `Folder scope removed: ${removed?.path ?? id}.`, 1);
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

  /**
   * Awaitable because the browser and the skill servers are child processes of their
   * own: a caller that exits the process without waiting leaves a headed browser
   * window and its profile lock behind.
   */
  async close(): Promise<void> {
    this.scheduler.stop();
    await Promise.allSettled([this.browserBridge.close(), this.mcp.stop()]);
    this.bus.clear();
    this.db.close();
  }

  /**
   * Permission changes are themselves security-relevant, so they land in the same
   * audit trail as tool calls under the synthetic `permissions` tool.
   */
  private auditPermissionChange(
    action: string,
    target: string,
    detail: string,
    riskLevel: AuditEvent['riskLevel'],
  ): void {
    const event = this.auditStore.append({
      toolId: 'permissions',
      action,
      target,
      riskLevel,
      permission: 'allow',
      permissionReason: 'You changed this yourself in Jarvis.',
      result: 'succeeded',
      reversible: true,
      detail,
    });
    this.bus.emit('audit.appended', event);
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
