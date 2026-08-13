import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
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

const configSchema = z.object({
  repoUrl: z.string().min(1),
  /** 分支 / tag / commit；省略则使用远程默认分支 */
  ref: z.string().min(1).optional(),
});

function getWorkspaceDir(context: PluginContext): string | undefined {
  const value = getContext<unknown>(context, 'workspaceDir');
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 以纯文本树形字符串输出工作区一级目录（含文件；目录名带 `/`） */
async function formatTopLevelTree(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => a.localeCompare(b));

  if (names.length === 0) {
    return '.\n(empty)';
  }

  const lines = names.map((name, i) => {
    const prefix = i === names.length - 1 ? '└── ' : '├── ';
    return `${prefix}${name}`;
  });
  return `.\n${lines.join('\n')}`;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
  },
): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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
      if (options.signal?.aborted || (error as NodeJS.ErrnoException).name === 'AbortError') {
        reject(new PluginCancelledError());
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (options.signal?.aborted) {
        reject(new PluginCancelledError());
        return;
      }
      resolve({ code });
    });
  });
}

/**
 * git-checkout-plugin：将仓库克隆到 Run 级 workspaceDir
 */
async function executeGitCheckoutPlugin(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);
  const signal = getAbortSignal(context);
  const workspaceDir = getWorkspaceDir(context);

  if (!workspaceDir) {
    return {
      success: false,
      code: PluginFailureCodes.PLUGIN_CONFIG_INVALID,
      message: '缺少 workspaceDir：git-checkout-plugin 必须在带 Run 级工作区的执行中使用',
    };
  }

  const { repoUrl, ref } = config;
  log.info('开始 git clone', { repoUrl, ref, workspaceDir });

  const pipe = {
    onStdout: (chunk: string) => log.append(chunk, 'stdout'),
    onStderr: (chunk: string) => log.append(chunk, 'stderr'),
  };

  try {
    throwIfAborted(context);

    const clone = await runCommand('git', ['clone', repoUrl, '.'], {
      cwd: workspaceDir,
      signal,
      ...pipe,
    });
    if (clone.code !== 0) {
      return {
        success: false,
        code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
        message: `git clone 失败，退出码 ${clone.code}`,
        data: { exitCode: clone.code },
      };
    }

    if (ref) {
      throwIfAborted(context);
      const checkout = await runCommand('git', ['checkout', ref], {
        cwd: workspaceDir,
        signal,
        ...pipe,
      });
      if (checkout.code !== 0) {
        return {
          success: false,
          code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
          message: `git checkout ${ref} 失败，退出码 ${checkout.code}`,
          data: { exitCode: checkout.code },
        };
      }
    }

    throwIfAborted(context);

    let commit = '';
    const rev = await runCommand('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceDir,
      signal,
      onStdout: (chunk) => {
        commit += chunk;
        log.append(chunk, 'stdout');
      },
      onStderr: pipe.onStderr,
    });
    if (rev.code !== 0) {
      return {
        success: false,
        code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
        message: `无法读取 HEAD commit，退出码 ${rev.code}`,
        data: { exitCode: rev.code },
      };
    }

    commit = commit.trim();

    const tree = await formatTopLevelTree(workspaceDir);
    log.info('工作区目录树:');
    log.append(`${tree}\n`, 'stdout');
    log.info('checkout 完成', { commit, workspaceDir });

    return {
      success: true,
      message: `已 checkout ${commit.slice(0, 12)}`,
      data: { commit, workspaceDir, tree },
    };
  } catch (error) {
    if (error instanceof PluginCancelledError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    log.append(`git-checkout 失败: ${message}\n`, 'stderr');
    return {
      success: false,
      code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
      message: `git-checkout 失败: ${message}`,
    };
  }
}

export const gitCheckoutPlugin = createPlugin({
  name: 'git-checkout-plugin',
  version: '1.0.0',
  description: '将 Git 仓库克隆到 Run 级共享工作区（CI PoC）',
  configSchema,
  resultSchema: z.object({
    commit: z.string(),
    workspaceDir: z.string(),
    tree: z.string(),
  }),
  execute: executeGitCheckoutPlugin,
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default gitCheckoutPlugin;
