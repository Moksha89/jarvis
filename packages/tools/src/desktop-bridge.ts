import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import type { DesktopElement, DesktopShot, DesktopWindow, MouseButton } from '@jarvis/types';

export interface WindowQuery {
  /** Exact handle, preferred when it came from `desktop.windows`. */
  handle?: string;
  /** Case-insensitive substring of the window title. */
  title?: string;
}

/**
 * Everything the desktop tools need from the operating system. Kept behind an
 * interface so the tools can be tested without a real desktop session.
 */
export interface DesktopBridge {
  listWindows(): Promise<DesktopWindow[]>;
  inspect(query: WindowQuery & { maxDepth: number; limit: number }): Promise<DesktopElement[]>;
  screenshot(options: WindowQuery & { path: string }): Promise<DesktopShot>;
  focus(query: WindowQuery): Promise<DesktopWindow>;
  click(options: { x: number; y: number; button: MouseButton }): Promise<void>;
  typeText(options: { text: string }): Promise<void>;
  pressKeys(options: { keys: string }): Promise<void>;
}

const POWERSHELL_TIMEOUT_MS = 30_000;

/** Shared Win32/UIA helpers injected in front of every script. */
const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes | Out-Null
if (-not ('Jarvis.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Jarvis {
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public class Native {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr param);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr window, out int pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);

    public delegate bool EnumProc(IntPtr window, IntPtr param);

    public static List<IntPtr> TopLevelWindows() {
      List<IntPtr> found = new List<IntPtr>();
      EnumWindows(delegate(IntPtr window, IntPtr param) {
        if (IsWindowVisible(window)) found.Add(window);
        return true;
      }, IntPtr.Zero);
      return found;
    }

    public static string Title(IntPtr window) {
      StringBuilder text = new StringBuilder(512);
      GetWindowTextW(window, text, text.Capacity);
      return text.ToString();
    }
  }
}
'@ | Out-Null
}

function Get-JarvisWindows {
  $foreground = [Jarvis.Native]::GetForegroundWindow()
  foreach ($handle in [Jarvis.Native]::TopLevelWindows()) {
    $title = [Jarvis.Native]::Title($handle)
    if ([string]::IsNullOrWhiteSpace($title)) { continue }
    $rect = New-Object Jarvis.RECT
    [void][Jarvis.Native]::GetWindowRect($handle, [ref] $rect)
    $processId = 0
    [void][Jarvis.Native]::GetWindowThreadProcessId($handle, [ref] $processId)
    $name = ''
    try { $name = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { $name = '' }
    [pscustomobject]@{
      handle = $handle.ToString()
      title = $title
      process = $name
      pid = $processId
      bounds = [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
      foreground = ($handle -eq $foreground)
    }
  }
}

function Resolve-JarvisWindow($handleText, $titleText) {
  $windows = @(Get-JarvisWindows)
  if ($handleText) {
    $match = $windows | Where-Object { $_.handle -eq $handleText } | Select-Object -First 1
    if (-not $match) { throw "No open window has handle $handleText." }
    return $match
  }
  if ($titleText) {
    $match = $windows | Where-Object { $_.title -like "*$titleText*" } | Select-Object -First 1
    if (-not $match) { throw "No open window title contains '$titleText'." }
    return $match
  }
  throw 'Give either a window handle or part of a window title.'
}

function Write-JarvisJson($value) {
  ConvertTo-Json -InputObject @($value) -Depth 6 -Compress
}
`;

/** Drives the real Windows desktop through short PowerShell scripts. */
export class WindowsDesktopBridge implements DesktopBridge {
  async listWindows(): Promise<DesktopWindow[]> {
    return await this.run<DesktopWindow>('Write-JarvisJson (Get-JarvisWindows)');
  }

  async inspect(query: WindowQuery & { maxDepth: number; limit: number }): Promise<DesktopElement[]> {
    const script = `
$window = Resolve-JarvisWindow ${literal(query.handle)} ${literal(query.title)}
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$window.handle))
if (-not $root) { throw "That window does not expose an accessibility tree." }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$queue = New-Object System.Collections.Generic.Queue[object]
$queue.Enqueue(@($root, 0))
$out = New-Object System.Collections.Generic.List[object]
while ($queue.Count -gt 0 -and $out.Count -lt ${integer(query.limit)}) {
  $entry = $queue.Dequeue()
  $element = $entry[0]
  $depth = $entry[1]
  try { $current = $element.Current } catch { continue }
  $rect = $current.BoundingRectangle
  $bounds = $null
  if (-not [double]::IsInfinity($rect.X)) {
    $bounds = [pscustomobject]@{ x = [int]$rect.X; y = [int]$rect.Y; width = [int]$rect.Width; height = [int]$rect.Height }
  }
  $out.Add([pscustomobject]@{
    name = $current.Name
    role = $current.ControlType.ProgrammaticName.Replace('ControlType.', '')
    automationId = $current.AutomationId
    enabled = $current.IsEnabled
    depth = $depth
    bounds = $bounds
  })
  if ($depth -ge ${integer(query.maxDepth)}) { continue }
  $child = $walker.GetFirstChild($element)
  while ($child -ne $null) {
    $queue.Enqueue(@($child, $depth + 1))
    $child = $walker.GetNextSibling($child)
  }
}
Write-JarvisJson $out`;
    return await this.run<DesktopElement>(script);
  }

  async screenshot(options: WindowQuery & { path: string }): Promise<DesktopShot> {
    const scoped = options.handle !== undefined || options.title !== undefined;
    const script = `
${
  scoped
    ? `$window = Resolve-JarvisWindow ${literal(options.handle)} ${literal(options.title)}
[void][Jarvis.Native]::ShowWindow([IntPtr]::new([int64]$window.handle), 9)
[void][Jarvis.Native]::SetForegroundWindow([IntPtr]::new([int64]$window.handle))
Start-Sleep -Milliseconds 250
$window = Resolve-JarvisWindow $window.handle $null
$area = New-Object System.Drawing.Rectangle($window.bounds.x, $window.bounds.y, $window.bounds.width, $window.bounds.height)`
    : `$area = [System.Windows.Forms.SystemInformation]::VirtualScreen`
}
if ($area.Width -le 0 -or $area.Height -le 0) { throw 'That window is minimised or has no visible area.' }
$bitmap = New-Object System.Drawing.Bitmap($area.Width, $area.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($area.X, $area.Y, 0, 0, $bitmap.Size)
$bitmap.Save(${literal(options.path)}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-JarvisJson ([pscustomobject]@{
  path = ${literal(options.path)}
  width = $area.Width
  height = $area.Height
  bytes = (Get-Item ${literal(options.path)}).Length
})`;
    const [shot] = await this.run<DesktopShot>(script);
    if (!shot) throw new Error('The screen capture produced no file.');
    return shot;
  }

  async focus(query: WindowQuery): Promise<DesktopWindow> {
    const script = `
$window = Resolve-JarvisWindow ${literal(query.handle)} ${literal(query.title)}
$handle = [IntPtr]::new([int64]$window.handle)
[void][Jarvis.Native]::ShowWindow($handle, 9)
if (-not [Jarvis.Native]::SetForegroundWindow($handle)) { throw "Windows refused to bring '$($window.title)' to the front." }
Start-Sleep -Milliseconds 150
Write-JarvisJson (Resolve-JarvisWindow $window.handle $null)`;
    const [window] = await this.run<DesktopWindow>(script);
    if (!window) throw new Error('The window disappeared before it could be focused.');
    return window;
  }

  async click(options: { x: number; y: number; button: MouseButton }): Promise<void> {
    const down = options.button === 'right' ? '0x0008' : '0x0002';
    const up = options.button === 'right' ? '0x0010' : '0x0004';
    const clicks = options.button === 'double' ? 2 : 1;
    const script = `
if (-not [Jarvis.Native]::SetCursorPos(${integer(options.x)}, ${integer(options.y)})) { throw 'That point is outside the screen.' }
for ($i = 0; $i -lt ${clicks}; $i++) {
  [Jarvis.Native]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
  [Jarvis.Native]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
}
Write-JarvisJson ([pscustomobject]@{ ok = $true })`;
    await this.run(script);
  }

  async typeText(options: { text: string }): Promise<void> {
    await this.sendKeys(escapeSendKeys(options.text));
  }

  async pressKeys(options: { keys: string }): Promise<void> {
    await this.sendKeys(options.keys);
  }

  private async sendKeys(keys: string): Promise<void> {
    await this.run(`
[System.Windows.Forms.SendKeys]::SendWait(${literal(keys)})
Start-Sleep -Milliseconds 120
Write-JarvisJson ([pscustomobject]@{ ok = $true })`);
  }

  private async run<T>(body: string): Promise<T[]> {
    if (platform !== 'win32') throw new Error('Desktop control only works on Windows.');
    const output = await runPowerShell(`${PRELUDE}\n${body}`);
    if (output.trim().length === 0) return [];
    const parsed: unknown = JSON.parse(output);
    return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T];
  }
}

/** Turns literal text into SendKeys input, where several characters are syntax. */
export function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (character) => `{${character}}`);
}

function literal(value: string | undefined): string {
  if (value === undefined) return '$null';
  return `'${value.replace(/'/g, "''")}'`;
}

function integer(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Expected a number, received ${String(value)}.`);
  return String(Math.round(value));
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error('The desktop command took too long and was stopped.'));
    }, POWERSHELL_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(stderr.trim() || `PowerShell exited with code ${String(code)}.`));
    });

    child.stdin.end(script);
  });
}
