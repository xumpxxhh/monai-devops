import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pluginsDir = path.join(repoRoot, 'plugins');
const pluginsConfigPath = path.join(repoRoot, 'apps', 'server', 'plugins.config.json');
const syncScriptPath = path.join(repoRoot, 'scripts', 'sync-plugin-registry.mjs');

const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function printUsage() {
  console.log('用法: pnpm create:plugin <plugin-name>');
  console.log('');
  console.log('示例: pnpm create:plugin deploy-plugin');
  console.log('');
  console.log('说明:');
  console.log('  - 在 plugins/ 目录下创建新的插件包');
  console.log('  - 自动写入 apps/server/plugins.config.json 并同步 server 注册表');
  console.log('  - 插件名仅支持小写字母、数字和短横线（kebab-case）');
}

function toCamelCase(name) {
  return name.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function toTitleCase(name) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const PLUGIN_NAMESPACE = '@monai-devops';

function toPackageName(pluginName) {
  return `${PLUGIN_NAMESPACE}/${pluginName}`;
}

function createPackageJson(pluginName) {
  return {
    name: toPackageName(pluginName),
    version: '1.0.0',
    description: `${toTitleCase(pluginName)} plugin for monai-devops`,
    private: true,
    type: 'module',
    sideEffects: false,
    files: ['dist'],
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
    },
    scripts: {
      build: 'tsc',
      'check-types': 'tsc --noEmit',
      lint: 'eslint .',
      'lint:fix': 'eslint . --fix',
      format: 'prettier --write .',
      'format:check': 'prettier --check .',
    },
    dependencies: {
      '@monai-devops/plugin-sdk': 'workspace:*',
    },
    engines: {
      node: '>=20',
    },
    devDependencies: {
      '@types/node': '^24.0.0',
      typescript: 'catalog:',
    },
    packageManager: 'pnpm@10.18.2',
  };
}

function createTsconfig() {
  return {
    extends: '../tsconfig.base.json',
    compilerOptions: {
      outDir: 'dist',
      rootDir: 'src',
      types: ['node'],
    },
    include: ['src/**/*'],
  };
}

function createIndexTs(pluginName, exportName) {
  const executeFnName = `execute${exportName.charAt(0).toUpperCase()}${exportName.slice(1)}`;

  return `import { createPlugin, getLogger, z } from '@monai-devops/plugin-sdk';
import type { PluginContext, PluginResult } from '@monai-devops/plugin-sdk';

const configSchema = z.object({
  message: z.string().default('Hello from ${pluginName}'),
});

/**
 * ${pluginName} 插件执行函数
 */
async function ${executeFnName}(
  config: z.infer<typeof configSchema>,
  context: PluginContext,
): Promise<PluginResult> {
  const log = getLogger(context);
  const { message } = config;

  log.info('开始执行插件', { plugin: '${pluginName}', message });

  try {
    return {
      success: true,
      message: \`插件执行成功: \${message}\`,
      data: { message },
    };
  } catch (error) {
    return {
      success: false,
      message: \`插件执行失败: \${(error as Error).message}\`,
    };
  }
}

/**
 * ${pluginName} 插件定义
 */
export const ${exportName} = createPlugin({
  name: '${pluginName}',
  version: '1.0.0',
  configSchema,
  resultSchema: z.object({
    message: z.string(),
  }),
  execute: ${executeFnName},
  hooks: {
    beforeExecute: async () => {},
    afterExecute: async () => {},
    onError: async () => {},
  },
});

export default ${exportName};
`;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function appendPluginToConfig(pluginName) {
  const config = JSON.parse(await readFile(pluginsConfigPath, 'utf8'));
  if (!Array.isArray(config.plugins)) {
    throw new Error('plugins.config.json 中 "plugins" 必须是数组');
  }
  if (!config.plugins.includes(pluginName)) {
    config.plugins.push(pluginName);
    await writeFile(pluginsConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
}

function runSyncPluginRegistry() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [syncScriptPath], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`sync-plugin-registry 退出码 ${code}`));
    });
  });
}

async function main() {
  const pluginName = process.argv[2];

  if (!pluginName || pluginName === '--help' || pluginName === '-h') {
    printUsage();
    process.exit(pluginName ? 0 : 1);
  }

  if (!PLUGIN_NAME_PATTERN.test(pluginName)) {
    console.error(`错误: 无效的插件名 "${pluginName}"`);
    console.error('插件名必须为小写 kebab-case，例如 deploy-plugin');
    process.exit(1);
  }

  const pluginDir = path.join(pluginsDir, pluginName);

  if (await pathExists(pluginDir)) {
    console.error(`错误: 目录已存在 plugins/${pluginName}`);
    process.exit(1);
  }

  const exportName = toCamelCase(pluginName);

  await mkdir(path.join(pluginDir, 'src'), { recursive: true });

  await writeFile(
    path.join(pluginDir, 'package.json'),
    `${JSON.stringify(createPackageJson(pluginName), null, 2)}\n`,
    'utf8',
  );

  await writeFile(
    path.join(pluginDir, 'tsconfig.json'),
    `${JSON.stringify(createTsconfig(), null, 2)}\n`,
    'utf8',
  );

  await writeFile(
    path.join(pluginDir, 'src', 'index.ts'),
    createIndexTs(pluginName, exportName),
    'utf8',
  );

  await appendPluginToConfig(pluginName);
  await runSyncPluginRegistry();

  console.log(`已创建插件: plugins/${pluginName}`);
  console.log('');
  console.log('下一步:');
  console.log('  1. pnpm install');
  console.log(`  2. pnpm --filter ${toPackageName(pluginName)} check-types`);
  console.log(`  3. pnpm --filter ${toPackageName(pluginName)} build`);
  console.log('  4. pnpm --filter server build  （注册表已自动同步，无需手改 plugin-registry.ts）');
}

main().catch((error) => {
  console.error('创建插件失败:', error);
  process.exit(1);
});
