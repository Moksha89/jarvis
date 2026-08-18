import type { JarvisDatabase } from '../db/database.js';

export interface JarvisSettings {
  permissionProfile: 'locked' | 'balanced';
  defaultModel: string | null;
  ollamaEndpoint: string;
  qwenEndpoint: string;
  qwenAutoStart: boolean;
  theme: 'system' | 'light' | 'dark';
  /** Model used for retrieval embeddings; pulled separately from the chat model. */
  embeddingModel: string;
  /** Retrieve from indexed files and past chats before answering. */
  memoryEnabled: boolean;
  /** Embed each finished chat turn so later conversations can recall it. */
  rememberConversations: boolean;
}

export const DEFAULT_SETTINGS: JarvisSettings = {
  permissionProfile: 'balanced',
  defaultModel: null,
  ollamaEndpoint: 'http://127.0.0.1:11434',
  qwenEndpoint: 'http://127.0.0.1:8765',
  qwenAutoStart: true,
  theme: 'system',
  embeddingModel: 'nomic-embed-text',
  memoryEnabled: true,
  rememberConversations: true,
};

export class SettingsStore {
  constructor(private readonly db: JarvisDatabase) {}

  getAll(): JarvisSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: JarvisSettings = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (!(row.key in settings)) continue;
      try {
        Object.assign(settings, { [row.key]: JSON.parse(row.value) as unknown });
      } catch {
        // Ignore malformed rows and keep the default.
      }
    }
    return settings;
  }

  patch(patch: Partial<JarvisSettings>): JarvisSettings {
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
      statement.run(key, JSON.stringify(value), now);
    }
    return this.getAll();
  }
}
