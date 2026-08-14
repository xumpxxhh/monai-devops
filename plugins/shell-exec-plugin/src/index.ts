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
import {
  buildDockerRunInvocation,
  resolveDockerImage,
  resolveDockerNetwork,
  resolveProcessIds,
  type DockerNetworkMode,
} from './docker-sandbox.js';
import { mergeSignals, runCommand, runShellCommand } from './run-command.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const configSchema = z.object({
  command: z.string().min(1),
  /** 相对 workspaceDir 的子目录；省略则在 workspace 根目录执行 */
  cwd: z.string().optional(),
  /** 单步超时（毫秒），默认 10 分钟 */
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  /** none=与 server 同机同权限；docker=在容器内执行（需宿主机可用 docker CLI） */
  sandbox: z.enum(['none', 'docker']).default('none'),
  /** sandbox=docker 时使用的镜像；省略则读 SANDBOX_DOCKER_IMAGE 或 node:20-bookworm */
  dockerImage: z.string().min(1).optional(),
  /** sandbox=docker 时的网络模式；省略则读 SANDBOX_DOCKER_NETWORK 或 bridge */
  dockerNetwork: z.enum(['none', 'bridge', 'host']).optional(),
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

async function executeInDockerSandbox(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
  workspaceDir: string,
  cwd: string,
  signal: AbortSignal,
): Promise<PluginResult> {
  const log = getLogger(context);
  const image = resolveDockerImage(config.dockerImage);
  const network = resolveDockerNetwork(config.dockerNetwork as DockerNetworkMode | undefined);
  const { uid, gid } = resolveProcessIds();

  let invocation;
  try {
    invocation = buildDockerRunInvocation({
      workspaceDir,
      cwd,
      command: config.command,
      image,
      network,
      uid,
      gid,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      code: PluginFailureCodes.PLUGIN_CONFIG_INVALID,
      message,
    };
  }

  log.info('Docker sandbox 执行', {
    image,
    network,
    cwd,
    dockerArgs: invocation.args.join(' '),
  });
  log.append(`$ docker ${invocation.args.join(' ')}\n`, 'stdout');

  const exitCode = await runCommand({
    command: invocation.command,
    args: invocation.args,
    signal,
    onStdout: (chunk) => log.append(chunk, 'stdout'),
    onStderr: (chunk) => log.append(chunk, 'stderr'),
  });

  if (exitCode !== 0) {
    return {
      success: false,
      code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
      message: `Docker sandbox 命令退出码 ${exitCode}`,
      data: { exitCode, command: config.command, cwd, sandbox: 'docker', image, network },
    };
  }

  return {
    success: true,
    message: 'Docker sandbox 命令执行成功',
    data: { exitCode: 0, command: config.command, cwd, sandbox: 'docker', image, network },
  };
}

/**
 * shell-exec-plugin：在 Run 级 workspaceDir 内执行 shell 命令
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

  const cancelledMessage = () => (timeoutController.signal.aborted ? '命令执行超时' : '命令已取消');

  log.info('开始执行命令', {
    command: config.command,
    cwd,
    timeoutMs: config.timeoutMs,
    sandbox: config.sandbox,
  });
  log.append(`$ ${config.command}\n`, 'stdout');

  try {
    throwIfAborted(context);

    if (config.sandbox === 'docker') {
      try {
        return await executeInDockerSandbox(config, context, workspaceDir, cwd, signal);
      } catch (error) {
        if (error instanceof PluginCancelledError) {
          throw new PluginCancelledError(cancelledMessage());
        }
        throw error;
      }
    }

    const exitCode = await runShellCommand({
      command: config.command,
      cwd,
      signal,
      onStdout: (chunk) => log.append(chunk, 'stdout'),
      onStderr: (chunk) => log.append(chunk, 'stderr'),
    });

    if (exitCode !== 0) {
      return {
        success: false,
        code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
        message: `命令退出码 ${exitCode}`,
        data: { exitCode, command: config.command, cwd, sandbox: 'none' },
      };
    }

    log.info('命令执行成功', { command: config.command, exitCode: 0 });
    return {
      success: true,
      message: '命令执行成功',
      data: { exitCode: 0, command: config.command, cwd, sandbox: 'none' },
    };
  } catch (error) {
    if (error instanceof PluginCancelledError) {
      throw new PluginCancelledError(cancelledMessage());
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
    '在 Run 级共享工作区执行 shell 命令；可选 Docker sandbox（CI PoC；none 模式与 server 同机同权限）',
  configSchema,
  resultSchema: z.object({
    exitCode: z.number().nullable(),
    command: z.string(),
    cwd: z.string(),
    sandbox: z.enum(['none', 'docker']),
    image: z.string().optional(),
    network: z.enum(['none', 'bridge', 'host']).optional(),
  }),
  execute: executeShellExecPlugin,
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default shellExecPlugin;
