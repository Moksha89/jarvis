import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:process';
import type { JarvisTool, ToolInputSchema } from '@jarvis/types';
import { RiskLevel } from '@jarvis/types';
import type { PathGuard } from './path-guard.js';
import { recycle } from './recycle.js';

const MAX_READ_BYTES = 512 * 1024;

export interface FsEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
}

function schema(properties: ToolInputSchema['properties'], required: string[]): ToolInputSchema {
  return { type: 'object', properties, required };
}

export interface ListInput {
  path: string;
  recursive?: boolean;
}
export interface ReadInput {
  path: string;
  maxBytes?: number;
}
export interface WriteInput {
  path: string;
  content: string;
  createDirectories?: boolean;
}
export interface DeleteInput {
  path: string;
}

export function createListTool(guard: PathGuard): JarvisTool<ListInput, FsEntry[]> {
  return {
    id: 'filesystem.list',
    name: 'List folder contents',
    version: '1.0.0',
    category: 'filesystem',
    description: 'List files and folders inside a folder you allowed.',
    baseRiskLevel: RiskLevel.Safe,
    reversible: true,
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Absolute folder path.' },
        recursive: { type: 'boolean', description: 'Include nested folders (one extra level).', default: false },
      },
      ['path'],
    ),
    describe: (input) => ({
      summary: `List the contents of "${input.path}".`,
      target: input.path,
      riskLevel: RiskLevel.Safe,
      reversible: true,
      paths: [{ path: input.path, mode: 'read' }],
    }),
    async execute(input) {
      guard.assert(input.path, 'read');
      const root = resolve(input.path);
      const entries = await readdir(root, { withFileTypes: true });
      const result: FsEntry[] = [];
      for (const entry of entries) {
        const full = join(root, entry.name);
        const kind = entry.isDirectory() ? 'directory' : 'file';
        let sizeBytes: number | undefined;
        let modifiedAt: string | undefined;
        try {
          const info = await stat(full);
          sizeBytes = kind === 'file' ? info.size : undefined;
          modifiedAt = info.mtime.toISOString();
        } catch {
          // Unreadable entries are still listed, without metadata.
        }
        result.push({ name: entry.name, path: full, kind, sizeBytes, modifiedAt });
        if (input.recursive && kind === 'directory') {
          try {
            const nested = await readdir(full, { withFileTypes: true });
            for (const child of nested) {
              result.push({
                name: child.name,
                path: join(full, child.name),
                kind: child.isDirectory() ? 'directory' : 'file',
              });
            }
          } catch {
            // Ignore folders we cannot enumerate.
          }
        }
      }
      return { ok: true, data: result, summary: `Listed ${result.length} entries in ${root}.` };
    },
  };
}

export function createReadTool(guard: PathGuard): JarvisTool<ReadInput, { path: string; content: string; truncated: boolean }> {
  return {
    id: 'filesystem.read',
    name: 'Read a file',
    version: '1.0.0',
    category: 'filesystem',
    description: 'Read a text file inside a folder you allowed.',
    baseRiskLevel: RiskLevel.Safe,
    reversible: true,
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Absolute file path.' },
        maxBytes: { type: 'number', description: 'Maximum number of bytes to read.', default: MAX_READ_BYTES },
      },
      ['path'],
    ),
    describe: (input) => ({
      summary: `Read the file "${input.path}".`,
      target: input.path,
      riskLevel: RiskLevel.Safe,
      reversible: true,
      paths: [{ path: input.path, mode: 'read' }],
    }),
    async execute(input) {
      guard.assert(input.path, 'read');
      const limit = Math.min(input.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES);
      const buffer = await readFile(resolve(input.path));
      const truncated = buffer.byteLength > limit;
      const content = buffer.subarray(0, limit).toString('utf8');
      return {
        ok: true,
        data: { path: resolve(input.path), content, truncated },
        summary: `Read ${Math.min(buffer.byteLength, limit)} bytes from ${input.path}${truncated ? ' (truncated)' : ''}.`,
      };
    },
  };
}

export function createWriteTool(guard: PathGuard): JarvisTool<WriteInput, { path: string; bytesWritten: number }> {
  return {
    id: 'filesystem.write',
    name: 'Write a file',
    version: '1.0.0',
    category: 'filesystem',
    description: 'Create or replace a text file inside a folder you allowed.',
    baseRiskLevel: RiskLevel.Low,
    reversible: false,
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Absolute file path.' },
        content: { type: 'string', description: 'Full new file contents.' },
        createDirectories: { type: 'boolean', description: 'Create missing parent folders.', default: false },
      },
      ['path', 'content'],
    ),
    describe: (input) => {
      const overwrites = safeExists(input.path);
      return {
        // Creating a file is reversible (delete it); replacing one loses the old content.
        summary: overwrites
          ? `Replace the contents of the existing file "${input.path}".`
          : `Create the file "${input.path}".`,
        target: input.path,
        riskLevel: overwrites ? RiskLevel.Medium : RiskLevel.Low,
        reversible: !overwrites,
        paths: [{ path: input.path, mode: 'read-write' }],
      };
    },
    async execute(input) {
      guard.assert(input.path, 'read-write');
      const target = resolve(input.path);
      if (input.createDirectories) {
        guard.assert(dirname(target), 'read-write');
        await mkdir(dirname(target), { recursive: true });
      }
      await writeFile(target, input.content, 'utf8');
      return {
        ok: true,
        data: { path: target, bytesWritten: Buffer.byteLength(input.content, 'utf8') },
        summary: `Wrote ${Buffer.byteLength(input.content, 'utf8')} bytes to ${target}.`,
      };
    },
  };
}

export function createDeleteTool(guard: PathGuard): JarvisTool<DeleteInput, { path: string; method: string }> {
  return {
    id: 'filesystem.delete',
    name: 'Delete to Recycle Bin',
    version: '1.0.0',
    category: 'filesystem',
    description: 'Move a file or folder to the Recycle Bin so it can be restored.',
    baseRiskLevel: RiskLevel.Medium,
    reversible: true,
    inputSchema: schema({ path: { type: 'string', description: 'Absolute path to delete.' } }, ['path']),
    describe: (input) => ({
      summary: `Move "${input.path}" to the ${platform === 'win32' ? 'Recycle Bin' : 'trash'}, where it can be restored.`,
      target: input.path,
      riskLevel: RiskLevel.Medium,
      reversible: true,
      paths: [{ path: input.path, mode: 'read-write' }],
    }),
    async execute(input) {
      guard.assert(input.path, 'read-write');
      const target = resolve(input.path);
      const method = await recycle(target);
      return { ok: true, data: { path: target, method }, summary: `Moved ${target} to ${method}.` };
    },
  };
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function createFilesystemTools(guard: PathGuard) {
  return [createListTool(guard), createReadTool(guard), createWriteTool(guard), createDeleteTool(guard)];
}
