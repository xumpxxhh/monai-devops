import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { getContext } from '@monai-devops/plugin-sdk';
import {
  createPlugin,
  getAbortSignal,
  getLogger,
  PluginCancelledError,
  PluginFailureCodes,
  throwIfAborted,
  z,
} from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const configSchema = z.object({
  command: z.string().min(1),
  /** 相对 workspaceDir 的子目录；省略则在 workspace 根目录执行 */
  cwd: z.string().optional(),
  /** 单步超时（毫秒），默认 10 分钟 */
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
});

function getWorkspaceDir(context: PluginContext): string | undefined {
  const value = getContext<unknown>(context, 'workspaceDir');
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 解析 cwd 并确保仍落在 workspace 内（防路径逃逸） */
function resolveSafeCwd(workspaceDir: string, relativeCwd?: string): string | { error: string } {
  const root = resolve(workspaceDir);
  const target = relativeCwd?.trim() ? resolve(root, relativeCwd.trim()) : root;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    return { error: `cwd 逃逸工作区：${relativeCwd} → ${target}（workspace=${root}）` };
  }
  return target;
}

function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const defined = signals.filter(Boolean);
  if (defined.length === 0) {
    return new AbortController().signal;
  }
  if (defined.length === 1) {
    return defined[0]!;
  }
  return AbortSignal.any(defined);
}

/**
 * shell-exec-plugin：在 Run 级 workspaceDir 内执行 shell 命令（非隔离，仅 PoC）
 */
async function executeShellExecPlugin(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);
  const workflowSignal = getAbortSignal(context);
  const workspaceDir = getWorkspaceDir(context);

  if (!workspaceDir) {
    return {
      success: false,
      code: PluginFailureCodes.PLUGIN_CONFIG_INVALID,
      message: '缺少 workspaceDir：shell-exec-plugin 必须在带 Run 级工作区的执行中使用',
    };
  }

  const cwdResult = resolveSafeCwd(workspaceDir, config.cwd);
  if (typeof cwdResult === 'object' && 'error' in cwdResult) {
    return {
      success: false,
      code: PluginFailureCodes.PLUGIN_CONFIG_INVALID,
      message: cwdResult.error,
    };
  }
  const cwd = cwdResult;

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs);
  const signal = mergeSignals(
    [workflowSignal, timeoutController.signal].filter((s): s is AbortSignal => Boolean(s)),
  );

  log.info('开始执行命令', {
    command: config.command,
    cwd,
    timeoutMs: config.timeoutMs,
  });
  log.append(`$ ${config.command}\n`, 'stdout');

  try {
    throwIfAborted(context);

    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      const child = spawn(config.command, {
        cwd,
        shell: true,
        signal,
        windowsHide: true,
        env: process.env,
      });

      child.stdout?.on('data', (buf: Buffer) => {
        log.append(buf.toString('utf8'), 'stdout');
      });
      child.stderr?.on('data', (buf: Buffer) => {
        log.append(buf.toString('utf8'), 'stderr');
      });

      child.on('error', (error) => {
        if (signal.aborted || (error as NodeJS.ErrnoException).name === 'AbortError') {
          reject(
            new PluginCancelledError(
              timeoutController.signal.aborted ? '命令执行超时' : '命令已取消',
            ),
          );
          return;
        }
        reject(error);
      });

      child.on('close', (code) => {
        if (signal.aborted) {
          reject(
            new PluginCancelledError(
              timeoutController.signal.aborted ? '命令执行超时' : '命令已取消',
            ),
          );
          return;
        }
        resolvePromise(code);
      });
    });

    if (exitCode !== 0) {
      return {
        success: false,
        code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
        message: `命令退出码 ${exitCode}`,
        data: { exitCode, command: config.command, cwd },
      };
    }

    log.info('命令执行成功', { command: config.command, exitCode: 0 });
    return {
      success: true,
      message: '命令执行成功',
      data: { exitCode: 0, command: config.command, cwd },
    };
  } catch (error) {
    if (error instanceof PluginCancelledError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    log.append(`shell-exec 失败: ${message}\n`, 'stderr');
    return {
      success: false,
      code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
      message: `shell-exec 失败: ${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const shellExecPlugin = createPlugin({
  name: 'shell-exec-plugin',
  version: '1.0.0',
  description:
    '在 Run 级共享工作区执行 shell 命令（CI PoC；与 server 同机同权限，勿接入不受信任输入）',
  configSchema,
  resultSchema: z.object({
    exitCode: z.number().nullable(),
    command: z.string(),
    cwd: z.string(),
  }),
  execute: executeShellExecPlugin,
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default shellExecPlugin;
