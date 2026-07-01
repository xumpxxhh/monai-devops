import { access, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pluginsDir = path.join(repoRoot, 'plugins');
const serverDir = path.join(repoRoot, 'apps', 'server');
const configPath = path.join(serverDir, 'plugins.config.json');
const registryPath = path.join(serverDir, 'src', 'plugins', 'plugin-registry.ts');
const serverPackagePath = path.join(serverDir, 'package.json');

const PLUGIN_NAMESPACE = '@monai-devops';

function toCamelCase(name) {
  return name.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function toPackageName(pluginName) {
  return `${PLUGIN_NAMESPACE}/${pluginName}`;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listPluginDirNames() {
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  const names = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageJsonPath = path.join(pluginsDir, entry.name, 'package.json');
    if (await pathExists(packageJsonPath)) {
      names.push(entry.name);
    }
  }

  return names.sort();
}

function isManagedPluginDependency(depName, pluginDirNames) {
  if (!depName.startsWith(`${PLUGIN_NAMESPACE}/`)) {
    return false;
  }
  const pluginName = depName.slice(`${PLUGIN_NAMESPACE}/`.length);
  return pluginDirNames.includes(pluginName);
}

function generateRegistryContent(pluginNames) {
  const lines = [
    '// AUTO-GENERATED — 请勿手工编辑，运行 pnpm sync:plugins 更新',
    '',
  ];

  for (const pluginName of pluginNames) {
    const exportName = toCamelCase(pluginName);
    lines.push(`import ${exportName} from '${toPackageName(pluginName)}';`);
  }

  lines.push('');
  lines.push(
    `export const registeredPlugins = [${pluginNames.map(toCamelCase).join(', ')}];`,
  );
  lines.push('');

  return lines.join('\n');
}

function syncServerDependencies(serverPackage, pluginNames, pluginDirNames) {
  const configured = new Set(pluginNames.map(toPackageName));
  const dependencies = { ...serverPackage.dependencies };

  for (const depName of Object.keys(dependencies)) {
    if (isManagedPluginDependency(depName, pluginDirNames) && !configured.has(depName)) {
      delete dependencies[depName];
    }
  }

  for (const pluginName of pluginNames) {
    const packageName = toPackageName(pluginName);
    dependencies[packageName] = 'workspace:*';
  }

  return dependencies;
}

async function main() {
  if (!(await pathExists(configPath))) {
    console.error(`错误: 未找到配置文件 ${configPath}`);
    process.exit(1);
  }

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const pluginNames = config.plugins;

  if (!Array.isArray(pluginNames)) {
    console.error('错误: plugins.config.json 中 "plugins" 必须是数组');
    process.exit(1);
  }

  const seen = new Set();
  for (const pluginName of pluginNames) {
    if (typeof pluginName !== 'string' || pluginName.length === 0) {
      console.error('错误: plugins 数组中的每一项必须是非空字符串');
      process.exit(1);
    }
    if (seen.has(pluginName)) {
      console.error(`错误: 插件 "${pluginName}" 在配置中重复`);
      process.exit(1);
    }
    seen.add(pluginName);

    const pluginPackagePath = path.join(pluginsDir, pluginName, 'package.json');
    if (!(await pathExists(pluginPackagePath))) {
      console.error(`错误: 插件 "${pluginName}" 不存在（缺少 plugins/${pluginName}/package.json）`);
      process.exit(1);
    }
  }

  const pluginDirNames = await listPluginDirNames();
  const registryContent = generateRegistryContent(pluginNames);
  await writeFile(registryPath, registryContent, 'utf8');

  const serverPackage = JSON.parse(await readFile(serverPackagePath, 'utf8'));
  serverPackage.dependencies = syncServerDependencies(
    serverPackage,
    pluginNames,
    pluginDirNames,
  );
  await writeFile(serverPackagePath, `${JSON.stringify(serverPackage, null, 2)}\n`, 'utf8');

  console.log(`已同步 ${pluginNames.length} 个插件: ${pluginNames.join(', ')}`);
  console.log(`  → ${path.relative(repoRoot, registryPath)}`);
  console.log(`  → ${path.relative(repoRoot, serverPackagePath)}`);
}

main().catch((error) => {
  console.error('同步插件注册表失败:', error);
  process.exit(1);
});
