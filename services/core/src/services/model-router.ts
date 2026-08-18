import type { ChatMode, ModelInfo, ModelRuntimeAdapter } from '@jarvis/types';

export interface RouteDecision {
  model: string;
  reason: string;
}

/**
 * Chooses which local model answers a request. The MVP rule set is deliberately
 * small: honour the explicit choice, then the configured default, then whatever is
 * already loaded (cheapest), then the first installed model.
 */
export class ModelRouter {
  constructor(
    private readonly runtime: ModelRuntimeAdapter,
    private readonly getDefaultModel: () => string | null,
  ) {}

  async route(options: { requested?: string; mode: ChatMode }): Promise<RouteDecision> {
    if (options.requested) {
      return { model: options.requested, reason: 'requested-by-user' };
    }
    const configured = this.getDefaultModel();
    let models: ModelInfo[] = [];
    try {
      models = await this.runtime.listModels();
    } catch {
      // Fall through: without a runtime we can still honour the configured default.
    }
    if (configured && (models.length === 0 || models.some((model) => model.id === configured))) {
      return { model: configured, reason: 'configured-default' };
    }
    const loaded = models.find((model) => model.loaded);
    if (loaded) return { model: loaded.id, reason: 'already-loaded' };
    const first = models[0];
    if (first) return { model: first.id, reason: 'only-installed-model' };
    throw new Error('No local model is available. Install one with "ollama pull llama3.1" and try again.');
  }
}
