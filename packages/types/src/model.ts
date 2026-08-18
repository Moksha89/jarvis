export type RuntimeStatus = 'ready' | 'not-running' | 'not-installed' | 'error';

export interface ModelRuntimeInfo {
  id: string;
  name: string;
  status: RuntimeStatus;
  endpoint: string;
  version?: string;
  message?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  sizeBytes?: number;
  loaded: boolean;
  modifiedAt?: string;
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: readonly ChatCompletionMessage[];
  temperature?: number;
  maxTokens?: number;
}

export type ModelStreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'done'; finishReason?: string };

/** Every model runtime (Ollama today) is reached through this interface only. */
export interface ModelRuntimeAdapter {
  readonly id: string;
  readonly name: string;
  status(): Promise<ModelRuntimeInfo>;
  listModels(): Promise<ModelInfo[]>;
  loadModel(model: string): Promise<void>;
  unloadModel(model: string): Promise<void>;
  streamChat(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamChunk>;
}
