import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { getContext } from '@monai-devops/plugin-sdk';
import {
  createPlugin,
  getLogger,
  PluginCancelledError,
  PluginFailureCodes,
  throwIfAborted,
  z,
} from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';

const fileEntrySchema = z.object({
  /** 相对 workspaceDir 的目标路径 */
  path: z.string().min(1),
  content: z.string(),
});

const configSchema = z.object({
  files: z.array(fileEntrySchema).min(1),
});

function getWorkspaceDir(context: PluginContext): string | undefined {
  const value = getContext<unknown>(context, 'workspaceDir');
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveSafePath(workspaceDir: string, relativePath: string): string | { error: string } {
  const root = resolve(workspaceDir);
  const target = resolve(root, relativePath.trim());
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    return { error: `path 逃逸工作区：${relativePath} → ${target}（workspace=${root}）` };
  }
  return target;
}

async function executeFileInjectPlugin(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);
  const workspaceDir = getWorkspaceDir(context);

  if (!workspaceDir) {
    return {
      success: false,
      code: PluginFailureCodes.PLUGIN_CONFIG_INVALID,
      message: '缺少 workspaceDir：file-inject-plugin 必须在带 Run 级工作区的执行中使用',
    };
  }

  const written: string[] = [];

  try {
    throwIfAborted(context);

    for (const file of config.files) {
      throwIfAborted(context);
      const dest = resolveSafePath(workspaceDir, file.path);
      if (typeof dest === 'object' && 'error' in dest) {
        return {
          success: false,
          code: PluginFailureCodes.PLUGIN_CONFIG_INVALID,
          message: dest.error,
        };
      }

      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content, 'utf8');
      written.push(file.path);
      log.info('已写入文件', { path: dest, bytes: Buffer.byteLength(file.content, 'utf8') });
      log.append(`write: ${file.path}\n`, 'stdout');
    }

    return {
      success: true,
      message: `已写入 ${written.length} 个文件`,
      data: { written },
    };
  } catch (error) {
    if (error instanceof PluginCancelledError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    log.append(`file-inject 失败: ${message}\n`, 'stderr');
    return {
      success: false,
      code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
      message: `file-inject 失败: ${message}`,
    };
  }
}

export const fileInjectPlugin = createPlugin({
  name: 'file-inject-plugin',
  version: '1.0.0',
  description: '按相对路径把文件内容写入 Run 级工作区（CI PoC）',
  configSchema,
  resultSchema: z.object({
    written: z.array(z.string()),
  }),
  execute: executeFileInjectPlugin,
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default fileInjectPlugin;
