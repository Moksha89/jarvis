import type { ChatMessage, ChatMode, Conversation, MessageRole } from '@jarvis/types';
import type { JarvisDatabase } from '../db/database.js';

interface ConversationRow {
  id: string;
  title: string;
  mode: string;
  model: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  mode: string | null;
  error: string | null;
  created_at: string;
}

export class ConversationStore {
  constructor(private readonly db: JarvisDatabase) {}

  create(options: { title?: string; mode: ChatMode; model?: string }): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title: options.title ?? 'New conversation',
      mode: options.mode,
      model: options.model,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare('INSERT INTO conversations (id, title, mode, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(conversation.id, conversation.title, conversation.mode, conversation.model ?? null, now, now);
    return conversation;
  }

  list(): Conversation[] {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as ConversationRow[];
    return rows.map(toConversation);
  }

  get(id: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row ? toConversation(row) : undefined;
  }

  rename(id: string, title: string): void {
    this.db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.slice(0, 120), new Date().toISOString(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  addMessage(message: {
    conversationId: string;
    role: MessageRole;
    content: string;
    model?: string;
    mode?: ChatMode;
    error?: string;
    id?: string;
  }): ChatMessage {
    const now = new Date().toISOString();
    const record: ChatMessage = {
      id: message.id ?? crypto.randomUUID(),
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      model: message.model,
      mode: message.mode,
      error: message.error,
      createdAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, model, mode, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.conversationId,
        record.role,
        record.content,
        record.model ?? null,
        record.mode ?? null,
        record.error ?? null,
        now,
      );
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, message.conversationId);
    return record;
  }

  updateMessage(id: string, patch: { content?: string; error?: string }): void {
    if (patch.content !== undefined) {
      this.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(patch.content, id);
    }
    if (patch.error !== undefined) {
      this.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(patch.error, id);
    }
  }

  deleteMessagesFrom(conversationId: string, messageId: string): void {
    const row = this.db.prepare('SELECT created_at FROM messages WHERE id = ?').get(messageId) as
      | { created_at: string }
      | undefined;
    if (!row) return;
    this.db
      .prepare('DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?')
      .run(conversationId, row.created_at);
  }

  listMessages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId) as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as MessageRole,
      content: row.content,
      model: row.model ?? undefined,
      mode: (row.mode as ChatMode | null) ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
    }));
  }
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode as ChatMode,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
