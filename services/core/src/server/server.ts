import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AuditQuery, ChatMode, PermissionProfileId, Plan, WorkflowStepInput } from '@jarvis/types';
import { isRiskLevel } from '@jarvis/types';
import { JarvisCore, type JarvisCoreOptions } from '../core.js';
import {
  CORE_DEFAULT_PORT,
  type AddRuleBody,
  type AddScopeBody,
  type AddKnowledgeSourceBody,
  type AddSkillServerBody,
  type ApproveBody,
  type CallToolBody,
  type KnowledgeSearchBody,
  type CreateConversationBody,
  type DenyBody,
  type SavedTaskBody,
  type SendChatBody,
  type SetProfileBody,
  type SetSkillServerEnabledBody,
  type SetTaskEnabledBody,
  type SetWorkflowEnabledBody,
  type PlanBody,
  type RunPlanBody,
  type RunWorkflowBody,
  type WorkflowBody,
} from '../client/contract.js';
import { Router, type RequestContext } from './router.js';
import type { JarvisSettings } from '../store/settings-store.js';

export interface ServerHandle {
  core: JarvisCore;
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export interface CreateServerOptions extends JarvisCoreOptions {
  port?: number;
  host?: string;
  /** Origins allowed to call Core. Only the local Tauri webview needs access. */
  allowedOrigins?: readonly string[];
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Core has no authentication because it is a localhost service, so the origin check is
 * what keeps a random web page the user visits from driving the tool loop. Tauri serves
 * the app from `tauri://localhost` (Windows uses the `.localhost` spelling); the Vite
 * dev server is the other legitimate caller.
 */
const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
];

/**
 * Core runs as a localhost HTTP service so the Tauri webview never links against
 * Node-only code (SQLite, child processes) and the boundary stays explicit.
 */
export async function createServer(options: CreateServerOptions = {}): Promise<ServerHandle> {
  const core = new JarvisCore(options);
  const router = buildRouter(core);
  const host = options.host ?? '127.0.0.1';
  const allowedOrigins = options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;

  const server = createHttpServer((request, response) => {
    void handle(router, request, response, allowedOrigins);
  });

  const port = await listen(server, options.port ?? CORE_DEFAULT_PORT, host);
  return {
    core,
    server,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await core.close();
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

async function handle(
  router: Router,
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: readonly string[],
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const origin = request.headers.origin;
  // A browser always sends `Origin` on cross-origin requests; native clients send none.
  if (origin !== undefined && !allowedOrigins.includes(origin)) {
    send(response, 403, { error: `Origin ${origin} may not call Jarvis Core.` });
    return;
  }
  if (origin !== undefined) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'origin');
  }
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }

  const match = router.match(request.method ?? 'GET', url.pathname);
  if (!match) {
    send(response, 404, { error: `No route for ${request.method} ${url.pathname}` });
    return;
  }

  const ctx: RequestContext = {
    request,
    response,
    params: match.params,
    query: url.searchParams,
    json: <T>() => readJson<T>(request),
    send: (status, body) => send(response, status, body),
  };

  try {
    await match.handler(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!response.headersSent) {
      send(response, 400, { error: message });
    } else {
      response.end();
    }
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(payload);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function startSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildRouter(core: JarvisCore): Router {
  const router = new Router();

  router.get('/api/health', (ctx) => ctx.send(200, { ok: true }));
  router.get('/api/system/status', async (ctx) => ctx.send(200, await core.getSystemStatus()));
  router.get('/api/system/resources', (ctx) => ctx.send(200, core.getResources()));

  router.get('/api/models', async (ctx) => ctx.send(200, await core.listModels()));
  router.post('/api/models/:id/load', async (ctx) => {
    await core.loadModel(ctx.params.id as string);
    ctx.send(200, { ok: true });
  });
  router.post('/api/models/:id/unload', async (ctx) => {
    await core.unloadModel(ctx.params.id as string);
    ctx.send(200, { ok: true });
  });
  // Pulls take minutes, so progress streams instead of blocking one response.
  router.post('/api/models/:id/pull', async (ctx) => {
    const controller = new AbortController();
    ctx.request.on('close', () => controller.abort());
    startSse(ctx.response);
    try {
      for await (const progress of core.pullModel(ctx.params.id as string, controller.signal)) {
        writeSse(ctx.response, progress);
      }
    } catch (error) {
      writeSse(ctx.response, { error: error instanceof Error ? error.message : String(error) });
    }
    ctx.response.write('data: [DONE]\n\n');
    ctx.response.end();
  });
  router.delete('/api/models/:id', async (ctx) => {
    await core.deleteModel(ctx.params.id as string);
    ctx.send(200, { ok: true });
  });

  router.get('/api/conversations', (ctx) => ctx.send(200, core.listConversations()));
  router.post('/api/conversations', async (ctx) => {
    const body = await ctx.json<CreateConversationBody>();
    ctx.send(200, core.createConversation({ mode: parseMode(body.mode), title: body.title, model: body.model }));
  });
  router.delete('/api/conversations/:id', (ctx) => {
    core.deleteConversation(ctx.params.id as string);
    ctx.send(200, { ok: true });
  });
  router.get('/api/conversations/:id/messages', (ctx) =>
    ctx.send(200, core.listMessages(ctx.params.id as string)),
  );

  router.post('/api/chat', async (ctx) => {
    const body = await ctx.json<SendChatBody>();
    const controller = new AbortController();
    ctx.request.on('close', () => controller.abort());
    startSse(ctx.response);
    try {
      for await (const event of core.sendChat({
        conversationId: body.conversationId,
        content: body.content,
        mode: parseMode(body.mode),
        model: body.model,
        retryFromMessageId: body.retryFromMessageId,
        maxSteps: body.maxSteps,
        signal: controller.signal,
      })) {
        writeSse(ctx.response, event);
      }
    } catch (error) {
      writeSse(ctx.response, { type: 'error', messageId: '', error: error instanceof Error ? error.message : String(error) });
    }
    ctx.response.write('data: [DONE]\n\n');
    ctx.response.end();
  });

  router.get('/api/events', (ctx) => {
    startSse(ctx.response);
    const heartbeat = setInterval(() => ctx.response.write(': ping\n\n'), 15_000);
    const unsubscribe = core.bus.onAny((event) => writeSse(ctx.response, event));
    ctx.request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.get('/api/tasks', (ctx) => ctx.send(200, core.listTasks(numberParam(ctx, 'limit'))));

  router.get('/api/saved-tasks', (ctx) => ctx.send(200, core.listSavedTasks()));
  router.post('/api/saved-tasks', async (ctx) => {
    const body = await ctx.json<SavedTaskBody>();
    ctx.send(200, core.createSavedTask(body));
  });
  router.patch('/api/saved-tasks/:id', async (ctx) => {
    const body = await ctx.json<SavedTaskBody>();
    ctx.send(200, core.updateSavedTask(ctx.params.id as string, body));
  });
  router.post('/api/saved-tasks/:id/enabled', async (ctx) => {
    const body = await ctx.json<SetTaskEnabledBody>();
    ctx.send(200, core.setSavedTaskEnabled(ctx.params.id as string, body.enabled === true));
  });
  router.post('/api/saved-tasks/:id/run', (ctx) => ctx.send(200, core.runSavedTask(ctx.params.id as string)));
  router.delete('/api/saved-tasks/:id', (ctx) => {
    core.deleteSavedTask(ctx.params.id as string);
    ctx.send(200, { ok: true });
  });
  router.get('/api/task-runs', (ctx) =>
    ctx.send(
      200,
      core.listTaskRuns({ taskId: ctx.query.get('taskId') ?? undefined, limit: numberParam(ctx, 'limit') }),
    ),
  );
  router.post('/api/task-runs/:id/cancel', (ctx) => ctx.send(200, core.cancelTaskRun(ctx.params.id as string)));

  router.get('/api/tools', (ctx) => ctx.send(200, core.listTools()));
  router.get('/api/tools/calls', (ctx) => ctx.send(200, core.listToolCalls(numberParam(ctx, 'limit'))));
  router.post('/api/tools/call', async (ctx) => {
    const body = await ctx.json<CallToolBody>();
    ctx.send(
      200,
      await core.callTool(body.toolId, body.input, {
        conversationId: body.conversationId,
        taskId: body.taskId,
      }),
    );
  });

  router.get('/api/approvals', (ctx) =>
    ctx.send(200, core.listApprovals({ pendingOnly: ctx.query.get('pending') === 'true' })),
  );
  router.post('/api/approvals/:id/approve', async (ctx) => {
    const body = await ctx.json<ApproveBody>();
    ctx.send(200, await core.approve(ctx.params.id as string, body));
  });
  router.post('/api/approvals/:id/deny', async (ctx) => {
    const body = await ctx.json<DenyBody>();
    ctx.send(200, await core.deny(ctx.params.id as string, body.reason));
  });

  router.get('/api/permissions', (ctx) => ctx.send(200, core.getPermissionState()));
  router.post('/api/permissions/profile', async (ctx) => {
    const body = await ctx.json<SetProfileBody>();
    core.setPermissionProfile(parseProfile(body.profile));
    ctx.send(200, core.getPermissionState());
  });
  router.post('/api/permissions/rules', async (ctx) => {
    const body = await ctx.json<AddRuleBody>();
    if (!isRiskLevel(body.maxRiskLevel)) throw new Error('maxRiskLevel must be an integer between 0 and 4.');
    ctx.send(200, core.addPermissionRule({ ...body, maxRiskLevel: body.maxRiskLevel }));
  });
  router.delete('/api/permissions/rules/:id', (ctx) => {
    core.deletePermissionRule(ctx.params.id as string);
    ctx.send(200, { ok: true });
  });
  router.post('/api/permissions/scopes', async (ctx) => {
    const body = await ctx.json<AddScopeBody>();
    if (!body.path?.trim()) throw new Error('A folder path is required.');
    ctx.send(200, core.addPathScope({ path: body.path.trim(), mode: body.mode, effect: body.effect }));
  });
  router.delete('/api/permissions/scopes/:id', (ctx) => {
    core.deletePathScope(ctx.params.id as string);
    ctx.send(200, { ok: true });
  });

  router.get('/api/knowledge/sources', (ctx) => ctx.send(200, core.listKnowledgeSources()));
  router.post('/api/knowledge/sources', async (ctx) => {
    const body = await ctx.json<AddKnowledgeSourceBody>();
    if (!body.path?.trim()) throw new Error('A folder or file path is required.');
    ctx.send(200, await core.addKnowledgeSource(body.path.trim()));
  });
  router.delete('/api/knowledge/sources/:id', (ctx) => {
    core.deleteKnowledgeSource(ctx.params.id as string);
    ctx.send(200, { ok: true });
  });
  router.post('/api/knowledge/sources/:id/reindex', async (ctx) =>
    ctx.send(200, await core.reindexKnowledgeSource(ctx.params.id as string)),
  );
  router.get('/api/knowledge/sources/:id/documents', (ctx) =>
    ctx.send(200, core.listKnowledgeDocuments(ctx.params.id as string)),
  );
  router.post('/api/knowledge/search', async (ctx) => {
    const body = await ctx.json<KnowledgeSearchBody>();
    if (!body.query?.trim()) throw new Error('A search query is required.');
    ctx.send(
      200,
      await core.searchKnowledge(body.query.trim(), {
        limit: body.limit,
        corpus: body.corpus,
        minScore: body.minScore,
      }),
    );
  });
  router.get('/api/knowledge/stats', async (ctx) => ctx.send(200, await core.getKnowledgeStats()));

  router.get('/api/skills/servers', (ctx) => ctx.send(200, core.listSkillServers()));
  router.post('/api/skills/servers', async (ctx) => {
    const body = await ctx.json<AddSkillServerBody>();
    ctx.send(200, await core.addSkillServer(body));
  });
  router.post('/api/skills/servers/:id/enabled', async (ctx) => {
    const body = await ctx.json<SetSkillServerEnabledBody>();
    ctx.send(200, await core.setSkillServerEnabled(ctx.params.id as string, body.enabled === true));
  });
  router.post('/api/skills/servers/:id/reconnect', async (ctx) =>
    ctx.send(200, await core.reconnectSkillServer(ctx.params.id as string)),
  );
  router.delete('/api/skills/servers/:id', async (ctx) => {
    await core.deleteSkillServer(ctx.params.id as string);
    ctx.send(200, { ok: true });
  });

  router.get('/api/workflows', (ctx) => ctx.send(200, core.listWorkflows()));
  router.post('/api/workflows', async (ctx) => {
    const body = await ctx.json<WorkflowBody>();
    ctx.send(200, core.createWorkflow(body));
  });
  router.patch('/api/workflows/:id', async (ctx) => {
    const body = await ctx.json<WorkflowBody>();
    ctx.send(200, core.updateWorkflow(ctx.params.id as string, body));
  });
  router.post('/api/workflows/:id/enabled', async (ctx) => {
    const body = await ctx.json<SetWorkflowEnabledBody>();
    ctx.send(200, core.setWorkflowEnabled(ctx.params.id as string, body.enabled === true));
  });
  router.post('/api/workflows/:id/run', async (ctx) => {
    const body = await ctx.json<RunWorkflowBody>();
    ctx.send(200, core.runWorkflow(ctx.params.id as string, body.input));
  });
  router.delete('/api/workflows/:id', (ctx) => {
    core.deleteWorkflow(ctx.params.id as string);
    ctx.send(200, { ok: true });
  });
  router.get('/api/workflows/runs', (ctx) =>
    ctx.send(
      200,
      core.listWorkflowRuns({
        workflowId: ctx.query.get('workflowId') ?? undefined,
        limit: numberParam(ctx, 'limit'),
      }),
    ),
  );
  router.post('/api/workflows/runs/:id/cancel', (ctx) =>
    ctx.send(200, core.cancelWorkflowRun(ctx.params.id as string)),
  );

  // Planning: `/plan` only proposes steps, `/plan/run` runs an approved or edited plan,
  // and `/do` is both in one request for the plain "just do this" path.
  router.post('/api/plan', async (ctx) => {
    const body = await ctx.json<PlanBody>();
    ctx.send(200, await core.planGoal(stringField(body.goal, 'goal'), optionalString(body.model, 'model')));
  });
  router.post('/api/plan/run', async (ctx) => {
    ctx.send(200, core.runPlan(parsePlan(await ctx.json<unknown>())));
  });
  router.post('/api/do', async (ctx) => {
    const body = await ctx.json<PlanBody>();
    ctx.send(200, await core.doGoal(stringField(body.goal, 'goal'), optionalString(body.model, 'model')));
  });

  router.get('/api/audit', (ctx) => ctx.send(200, core.queryAudit(parseAuditQuery(ctx))));

  router.get('/api/settings', (ctx) => ctx.send(200, core.getSettings()));
  router.patch('/api/settings', async (ctx) => {
    const body = await ctx.json<Partial<JarvisSettings>>();
    ctx.send(200, core.updateSettings(body));
  });

  return router;
}

/**
 * A request body is only JSON until it is checked, so the planning routes say what is
 * wrong with theirs (a 400) rather than failing on a missing field deeper in Core.
 */
function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`"${name}" must be text.`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : stringField(value, name);
}

function parsePlan(body: unknown): Plan {
  if (typeof body !== 'object' || body === null) throw new Error('A plan must be an object.');
  const candidate = body as Partial<RunPlanBody>;
  if (typeof candidate.goal !== 'string') throw new Error('"goal" must be text.');
  if (!Array.isArray(candidate.steps)) throw new Error('"steps" must be a list.');
  return {
    goal: candidate.goal,
    summary: typeof candidate.summary === 'string' ? candidate.summary : '',
    steps: candidate.steps as WorkflowStepInput[],
    notes: Array.isArray(candidate.notes) ? candidate.notes.filter((note) => typeof note === 'string') : [],
    model: typeof candidate.model === 'string' ? candidate.model : '',
    fallback: candidate.fallback === true,
  };
}

function numberParam(ctx: RequestContext, name: string): number | undefined {
  const raw = ctx.query.get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseAuditQuery(ctx: RequestContext): AuditQuery {
  const minRisk = numberParam(ctx, 'minRiskLevel');
  return {
    toolId: ctx.query.get('toolId') ?? undefined,
    result: (ctx.query.get('result') as AuditQuery['result']) ?? undefined,
    permission: (ctx.query.get('permission') as AuditQuery['permission']) ?? undefined,
    minRiskLevel: isRiskLevel(minRisk) ? minRisk : undefined,
    since: ctx.query.get('since') ?? undefined,
    until: ctx.query.get('until') ?? undefined,
    search: ctx.query.get('search') ?? undefined,
    limit: numberParam(ctx, 'limit'),
    offset: numberParam(ctx, 'offset'),
  };
}

function parseMode(mode: string): ChatMode {
  if (mode === 'ask' || mode === 'plan' || mode === 'agent') return mode;
  throw new Error(`Unsupported chat mode: ${mode}. Jarvis ships Ask, Plan and Agent.`);
}

function parseProfile(profile: string): PermissionProfileId {
  if (profile === 'locked' || profile === 'balanced') return profile;
  throw new Error(`Unsupported permission profile: ${profile}.`);
}
