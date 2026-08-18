import { describe, expect, it } from 'vitest';
import { classifyShellCommand } from './shell-classify.js';

describe('classifyShellCommand', () => {
  it('recognises read-only commands as safe', () => {
    expect(classifyShellCommand('git status').class).toBe('READ_ONLY');
    expect(classifyShellCommand('dir C:/Users').riskLevel).toBe(0);
  });

  it('classifies ordinary writes as medium risk', () => {
    const c = classifyShellCommand('pnpm install');
    expect(c.class).toBe('NORMAL_WRITE');
    expect(c.riskLevel).toBe(2);
  });

  it('classifies deletes as destructive and irreversible', () => {
    const c = classifyShellCommand('del C:/temp/a.txt');
    expect(c.class).toBe('DESTRUCTIVE');
    expect(c.reversible).toBe(false);
  });

  it('classifies system configuration commands as high risk', () => {
    expect(classifyShellCommand('reg add HKLM\\Software\\X /v Y').class).toBe('SYSTEM');
    expect(classifyShellCommand('winget install Foo').riskLevel).toBe(3);
  });

  it('flags security-defeating commands as dangerous', () => {
    expect(classifyShellCommand('Set-MpPreference -DisableRealtimeMonitoring $true').class).toBe('DANGEROUS');
    expect(classifyShellCommand('format C:').riskLevel).toBe(4);
    expect(classifyShellCommand('vssadmin delete shadows /all').class).toBe('DANGEROUS');
  });

  it('treats chained or piped commands as unclassifiable', () => {
    expect(classifyShellCommand('git status && del C:/x').class).toBe('UNKNOWN');
  });

  it('treats unknown executables as unclassifiable high risk', () => {
    const c = classifyShellCommand('weird-tool.exe --do-something');
    expect(c.class).toBe('UNKNOWN');
    expect(c.riskLevel).toBe(3);
  });

  it('strips paths and extensions when identifying the executable', () => {
    expect(classifyShellCommand('C:/Windows/System32/reg.exe query HKCU').class).toBe('SYSTEM');
  });
});
