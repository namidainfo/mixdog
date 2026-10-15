import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import {
  expandEnvVars,
  resolveMcpCallTimeoutMs,
  resolveMcpStdioEnvironment,
  resolveMcpTransportKind,
} from './client-config.mjs';

const runFile = promisify(execFile);

function windowsDrivePath(value) {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value)
    ? value.replaceAll('\\', '/')
    : null;
}

export async function normalizeWorktrailToolArguments(
  serverName,
  cfg,
  args,
  { platform = process.platform, signal = null, run = runFile } = {}
) {
  if (serverName !== 'worktrail' || platform !== 'win32') return args;
  const worktree = windowsDrivePath(args?.worktree);
  const factsWorktree = windowsDrivePath(args?.facts?.worktree);
  const paths = [...new Set([worktree, factsWorktree].filter(Boolean))];
  if (!paths.length || resolveMcpTransportKind(cfg) !== 'stdio') return args;
  const command = expandEnvVars(String(cfg.command ?? ''));
  if (win32.basename(command).toLowerCase() !== 'wsl.exe') return args;

  const launchArgs = expandEnvVars(cfg.args || []);
  const separator = launchArgs.findIndex((arg) => ['--', '--exec', '-e'].includes(arg));
  if (separator < 0) {
    throw new Error('Worktrail WSL arguments must separate the Linux command with --, --exec, or -e.');
  }
  const prefix = launchArgs.slice(0, separator);
  const options = {
    cwd: cfg.cwd,
    env: resolveMcpStdioEnvironment(cfg),
    timeout: resolveMcpCallTimeoutMs(cfg),
    windowsHide: true,
    ...(signal ? { signal } : {}),
  };
  const translated = new Map();
  for (const path of paths) {
    signal?.throwIfAborted();
    let stdout;
    try {
      ({ stdout } = await run(command, [...prefix, '--exec', 'wslpath', '-u', path], options));
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      // Child-process errors can contain arguments, stderr and environment
      // values. Only an exit code is safe to propagate into work records.
      const code = Number.isInteger(error?.code) ? ` (exit code ${error.code})` : '';
      throw new Error(`Worktrail worktree conversion failed${code}; inspect the configured WSL distribution, user and worktree.`);
    }
    signal?.throwIfAborted();
    const value = stdout.trim();
    if (!value.startsWith('/')) {
      throw new Error('WSL worktree conversion did not return an absolute Linux path.');
    }
    translated.set(path, value);
  }
  return {
    ...args,
    ...(worktree ? { worktree: translated.get(worktree) } : {}),
    ...(factsWorktree ? { facts: { ...args.facts, worktree: translated.get(factsWorktree) } } : {}),
  };
}
