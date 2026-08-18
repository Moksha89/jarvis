import { JarvisClient, CORE_DEFAULT_PORT } from '@jarvis/core/client';

const baseUrl =
  (import.meta.env.VITE_JARVIS_CORE_URL as string | undefined) ?? `http://127.0.0.1:${CORE_DEFAULT_PORT}`;

/** Single Core client for the whole app. The UI never talks to Ollama or Qwen directly. */
export const coreClient = new JarvisClient(baseUrl);
export const coreBaseUrl = baseUrl;
