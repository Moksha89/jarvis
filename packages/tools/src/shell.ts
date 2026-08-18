import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import type { JarvisTool } from '@jarvis/types';
import { RiskLevel } from '@jarvis/types';
import type { PathGuard } from './path-guard.js';
import { classifyShellCommand } from './shell-classify.js';

const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunOutput {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  classification: string;
}

export function createShellRunTool(guard: PathGuard): JarvisTool<RunInput, RunOutput> {
  return {
    id: 'shell.run',
    name: 'Run a command',
    version: '1.0.0',
    category: 'shell',
    description: 'Run a single shell command. Risk is derived from the command classifier.',
    baseRiskLevel: RiskLevel.High,
    reversible: false,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        cwd: { type: 'string', description: 'Working directory; must be an allowed folder.' },
        timeoutMs: { type: 'number', description: 'Kill the command after this many milliseconds.', default: DEFAULT_TIMEOUT_MS },
      },
      required: ['command'],
    },
    describe: (input) => {
      const classification = classifyShellCommand(input.command);
      return {
        summary: `Run "${input.command}". ${classification.reason}`,
        target: input.command,
        riskLevel: classification.riskLevel,
        reversible: classification.reversible,
        paths: input.cwd ? [{ path: input.cwd, mode: 'read-write' }] : undefined,
      };
    },
    async execute(input, ctx) {
      const classification = classifyShellCommand(input.command);
      if (classification.class === 'DANGEROUS') {
        // Refused in code even if an approval somehow reached this point.
        return { ok: false, error: `Refused: ${classification.reason}`, summary: `Refused dangerous command: ${input.command}` };
      }
      if (input.cwd) guard.assert(input.cwd, 'read-write');

      const [file, args] =
        platform === 'win32'
          ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', input.command]]
          : ['/bin/bash', ['-lc', input.command]];

      return await new Promise<{ ok: boolean; data: RunOutput; summary: string; error?: string }>((resolvePromise) => {
        const child = spawn(file as string, args as string[], {
          cwd: input.cwd,
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5 * 60_000));

        const onAbort = () => child.kill();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout.on('data', (chunk: Buffer) => {
          stdout = clamp(stdout + chunk.toString('utf8'));
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = clamp(stderr + chunk.toString('utf8'));
        });
        child.on('error', (error) => {
          clearTimeout(timeout);
          resolvePromise({
            ok: false,
            error: error.message,
            data: { command: input.command, exitCode: null, stdout, stderr, timedOut, classification: classification.class },
            summary: `Command failed to start: ${error.message}`,
          });
        });
        child.on('close', (code) => {
          clearTimeout(timeout);
          ctx.signal?.removeEventListener('abort', onAbort);
          resolvePromise({
            ok: !timedOut && code === 0,
            data: { command: input.command, exitCode: code, stdout, stderr, timedOut, classification: classification.class },
            summary: timedOut
              ? `Command timed out: ${input.command}`
              : `Command exited with code ${code}: ${input.command}`,
          });
        });
      });
    },
  };
}

export function createShellClassifyTool(): JarvisTool<{ command: string }, ReturnType<typeof classifyShellCommand>> {
  return {
    id: 'shell.classify',
    name: 'Explain a command',
    version: '1.0.0',
    category: 'shell',
    description: 'Explain what a command would change and how risky it is, without running it.',
    baseRiskLevel: RiskLevel.Safe,
    reversible: true,
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command line to classify.' } },
      required: ['command'],
    },
    describe: (input) => ({
      summary: `Explain what "${input.command}" would do.`,
      target: input.command,
      riskLevel: RiskLevel.Safe,
      reversible: true,
    }),
    async execute(input) {
      const classification = classifyShellCommand(input.command);
      return { ok: true, data: classification, summary: `Classified as ${classification.class}.` };
    },
  };
}

function clamp(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(0, MAX_OUTPUT_CHARS) : value;
}

export function createShellTools(guard: PathGuard) {
  return [createShellRunTool(guard), createShellClassifyTool()];
}
