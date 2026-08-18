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
  /** Bytes currently resident on the GPU, when the model is loaded. */
  vramBytes?: number;
  /** When the runtime will evict the loaded model. */
  expiresAt?: string;
}

export interface ModelPullProgress {
  /** Runtime-supplied phase, e.g. "pulling manifest" or "verifying sha256". */
  status: string;
  completedBytes?: number;
  totalBytes?: number;
  /** 0-100, present once the runtime reports byte totals. */
  percent?: number;
  done: boolean;
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on `tool` messages so the model can match a result to its call. */
  toolName?: string;
  /** Set on `assistant` messages that requested tools, to replay the turn. */
  toolCalls?: readonly ModelToolCall[];
}

/** A tool offered to the model, in the shape every OpenAI-style runtime expects. */
export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: readonly string[];
  };
}

export interface ModelToolCall {
  name: string;
  /** Raw arguments as the model produced them; may be an object or a JSON string. */
  arguments: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: readonly ChatCompletionMessage[];
  temperature?: number;
  maxTokens?: number;
  /** When present the runtime is asked to use native function calling. */
  tools?: readonly ModelToolDefinition[];
}

export type ModelStreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'tool-calls'; calls: readonly ModelToolCall[] }
  | { type: 'done'; finishReason?: string };

export interface EmbeddingRequest {
  model: string;
  input: readonly string[];
}

/** Every model runtime (Ollama today) is reached through this interface only. */
export interface ModelRuntimeAdapter {
  readonly id: string;
  readonly name: string;
  status(): Promise<ModelRuntimeInfo>;
  listModels(): Promise<ModelInfo[]>;
  loadModel(model: string): Promise<void>;
  unloadModel(model: string): Promise<void>;
  /** Download a model, reporting progress until `done`. */
  pullModel(model: string, signal?: AbortSignal): AsyncIterable<ModelPullProgress>;
  deleteModel(model: string): Promise<void>;
  streamChat(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamChunk>;
  /** One vector per input, in the same order. Used for local retrieval. */
  embed(request: EmbeddingRequest, signal?: AbortSignal): Promise<number[][]>;
}
