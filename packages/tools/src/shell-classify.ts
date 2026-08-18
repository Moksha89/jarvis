import type { RiskLevel } from '@jarvis/types';
import { RiskLevel as Risk } from '@jarvis/types';

export type ShellCommandClass =
  | 'READ_ONLY'
  | 'NORMAL_WRITE'
  | 'DESTRUCTIVE'
  | 'SYSTEM'
  | 'DANGEROUS'
  | 'UNKNOWN';

export interface ShellClassification {
  class: ShellCommandClass;
  riskLevel: RiskLevel;
  reversible: boolean;
  reason: string;
  executable: string;
}

const READ_ONLY = new Set([
  'dir', 'ls', 'gci', 'get-childitem', 'type', 'cat', 'get-content', 'echo', 'write-output',
  'pwd', 'cd', 'whoami', 'hostname', 'date', 'ver', 'where', 'which', 'findstr', 'select-string',
  'git', 'node', 'python', 'pwsh-version', 'systeminfo', 'tasklist', 'get-process', 'get-date',
]);

const NORMAL_WRITE = new Set([
  'mkdir', 'md', 'new-item', 'copy', 'cp', 'copy-item', 'move', 'mv', 'move-item', 'ren', 'rename',
  'rename-item', 'set-content', 'add-content', 'out-file', 'touch', 'npm', 'pnpm', 'yarn', 'dotnet',
  'cargo', 'pip', 'robocopy', 'tar', 'unzip', 'expand-archive', 'compress-archive',
]);

const DESTRUCTIVE = new Set(['del', 'erase', 'rm', 'remove-item', 'rmdir', 'rd', 'clear-content', 'truncate']);

const SYSTEM = new Set([
  'reg', 'regedit', 'sc', 'net', 'netsh', 'schtasks', 'shutdown', 'restart-computer', 'stop-computer',
  'winget', 'choco', 'msiexec', 'setx', 'bcdedit', 'dism', 'sfc', 'wmic', 'set-service', 'stop-service',
  'start-service', 'new-service', 'set-itemproperty', 'new-localuser', 'add-localgroupmember',
]);

/** Patterns that are refused or escalated regardless of the executable. */
const DANGEROUS_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /format\s+[a-z]:/i, reason: 'formats a drive' },
  { pattern: /\brm\b[^|]*\s-\w*[rf]\w*\s+\/(\s|$)/i, reason: 'recursive delete of the filesystem root' },
  { pattern: /remove-item[^|]*-recurse[^|]*(c:\\?|\\\\)(\s|$)/i, reason: 'recursive delete of a drive root' },
  { pattern: /\bcipher\s+\/w/i, reason: 'wipes free space' },
  { pattern: /\b(vssadmin|wbadmin)\b/i, reason: 'deletes shadow copies or backups' },
  { pattern: /set-mppreference[^|]*-disable/i, reason: 'disables Microsoft Defender' },
  { pattern: /add-mppreference[^|]*-exclusion/i, reason: 'adds a Defender exclusion' },
  { pattern: /netsh\s+advfirewall\s+set[^|]*off/i, reason: 'turns off the firewall' },
  { pattern: /\btakeown\b|\bicacls\b/i, reason: 'changes filesystem ownership or ACLs' },
  { pattern: /(invoke-expression|iex)\s*\(/i, reason: 'executes a dynamically built command' },
  { pattern: /(invoke-webrequest|curl|wget)[^|]*\|\s*(iex|invoke-expression|bash|sh|pwsh|powershell)/i, reason: 'pipes downloaded content into a shell' },
  { pattern: /-encodedcommand/i, reason: 'runs a base64-encoded command' },
  { pattern: /\bcmdkey\b|\bgpupdate\b|\bmimikatz\b/i, reason: 'touches stored credentials or policy' },
  { pattern: /\b(diskpart|fsutil)\b/i, reason: 'performs raw disk operations' },
];

/** Command separators mean we cannot reason about a single executable. */
const CHAINING = /(\|\||&&|;|\||`|\$\()/;

function firstExecutable(command: string): string {
  const trimmed = command.trim().replace(/^["']/, '');
  const token = trimmed.split(/[\s"']/, 1)[0] ?? '';
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * Classify a shell command. The classifier is deliberately pessimistic: anything it
 * does not positively recognise is UNKNOWN, which always requires approval.
 */
export function classifyShellCommand(command: string): ShellClassification {
  const executable = firstExecutable(command);

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        class: 'DANGEROUS',
        riskLevel: Risk.Critical,
        reversible: false,
        reason: `Command ${reason}.`,
        executable,
      };
    }
  }

  if (CHAINING.test(command)) {
    return {
      class: 'UNKNOWN',
      riskLevel: Risk.High,
      reversible: false,
      reason: 'Command chains or pipes several commands, so it cannot be classified as a single action.',
      executable,
    };
  }

  if (SYSTEM.has(executable)) {
    return {
      class: 'SYSTEM',
      riskLevel: Risk.High,
      reversible: false,
      reason: `"${executable}" changes system configuration, services or installed software.`,
      executable,
    };
  }
  if (DESTRUCTIVE.has(executable)) {
    return {
      class: 'DESTRUCTIVE',
      riskLevel: Risk.Medium,
      reversible: false,
      reason: `"${executable}" removes data and does not use the Recycle Bin.`,
      executable,
    };
  }
  if (NORMAL_WRITE.has(executable)) {
    return {
      class: 'NORMAL_WRITE',
      riskLevel: Risk.Medium,
      reversible: true,
      reason: `"${executable}" writes files or installs project dependencies.`,
      executable,
    };
  }
  if (READ_ONLY.has(executable)) {
    return {
      class: 'READ_ONLY',
      riskLevel: Risk.Safe,
      reversible: true,
      reason: `"${executable}" only reads information.`,
      executable,
    };
  }
  return {
    class: 'UNKNOWN',
    riskLevel: Risk.High,
    reversible: false,
    reason: `"${executable}" is not a recognised command, so Jarvis cannot predict what it changes.`,
    executable,
  };
}
