import { execFile } from 'node:child_process';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { platform } from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Deletes are always recoverable: the Windows Recycle Bin, or the freedesktop
 * trash folder when developing on Linux/macOS. Nothing is ever unlinked directly.
 */
export async function recycle(target: string): Promise<string> {
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName Microsoft.VisualBasic;',
      `$path = ${quotePowerShell(target)};`,
      'if (Test-Path -LiteralPath $path -PathType Container) {',
      "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin')",
      '} else {',
      "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin')",
      '}',
    ].join(' ');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return 'the Recycle Bin';
  }

  const trash = join(homedir(), '.local', 'share', 'Trash', 'files');
  await mkdir(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = join(trash, `${basename(target)}.${stamp}`);
  try {
    await rename(target, destination);
  } catch (error) {
    // rename() cannot cross filesystems, which is common between /tmp and $HOME.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(target, destination, { recursive: true });
    await rm(target, { recursive: true, force: true });
  }
  return 'the trash folder';
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
