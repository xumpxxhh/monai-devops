import { spawn } from 'node:child_process';
import { PluginCancelledError } from '@monai-devops/plugin-sdk';

export interface RunCommandOptions {
  command: string;
  args: string[];
  cwd?: string;
  signal: AbortSignal;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}

export function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const defined = signals.filter(Boolean);
  if (defined.length === 0) {
    return new AbortController().signal;
  }
  if (defined.length === 1) {
    return defined[0]!;
  }
  return AbortSignal.any(defined);
}

export function runCommand(options: RunCommandOptions): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      shell: false,
      signal: options.signal,
      windowsHide: true,
      env: process.env,
    });

    child.stdout?.on('data', (buf: Buffer) => {
      options.onStdout(buf.toString('utf8'));
    });
    child.stderr?.on('data', (buf: Buffer) => {
      options.onStderr(buf.toString('utf8'));
    });

    child.on('error', (error) => {
      if (options.signal.aborted || (error as NodeJS.ErrnoException).name === 'AbortError') {
        reject(new PluginCancelledError());
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (options.signal.aborted) {
        reject(new PluginCancelledError());
        return;
      }
      resolvePromise(code);
    });
  });
}

export function runShellCommand(options: {
  command: string;
  cwd: string;
  signal: AbortSignal;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      signal: options.signal,
      windowsHide: true,
      env: process.env,
    });

    child.stdout?.on('data', (buf: Buffer) => {
      options.onStdout(buf.toString('utf8'));
    });
    child.stderr?.on('data', (buf: Buffer) => {
      options.onStderr(buf.toString('utf8'));
    });

    child.on('error', (error) => {
      if (options.signal.aborted || (error as NodeJS.ErrnoException).name === 'AbortError') {
        reject(new PluginCancelledError());
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (options.signal.aborted) {
        reject(new PluginCancelledError());
        return;
      }
      resolvePromise(code);
    });
  });
}
