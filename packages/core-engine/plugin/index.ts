/**
 * 插件管理器
 * @module plugin
 */

import {
  PluginFailureCodes,
  type PluginDefinition,
  type PluginConfig,
  type PluginContext,
  type PluginResult,
} from '@monai-devops/plugin-sdk';

/**
 * 插件注册信息
 */
export interface PluginRegistry {
  [name: string]: PluginDefinition;
}

/**
 * 创建插件管理器
 */
export function createPluginManager() {
  const plugins: PluginRegistry = {};
  /**
   * 注册插件
   */
  function registerPlugin(plugin: PluginDefinition): void {
    plugins[plugin.name] = plugin;
  }
  /**
   * 批量注册插件
   */
  function registerPlugins(pluginList: PluginDefinition[]): void {
    pluginList.forEach((plugin) => registerPlugin(plugin));
  }
  /**
   * 卸载插件
   */
  function unregisterPlugin(name: string): boolean {
    if (plugins[name]) {
      delete plugins[name];
      return true;
    }
    return false;
  }
  /**
   * 获取插件
   */
  function getPlugin(name: string): PluginDefinition | undefined {
    return plugins[name];
  }
  /**
   * 获取所有已注册的插件
   */
  function getAllPlugins(): PluginDefinition[] {
    return Object.values(plugins);
  }
  /**
   * 获取插件名称列表
   */
  function getPluginNames(): string[] {
    return Object.keys(plugins);
  }
  /**
   * 检查插件是否存在
   */
  function hasPlugin(name: string): boolean {
    return name in plugins;
  }
  /**
   * 执行插件
   */
  async function executePlugin(
    name: string,
    config: PluginConfig,
    context: PluginContext = {},
  ): Promise<PluginResult> {
    const plugin = getPlugin(name);
    if (!plugin) {
      return {
        success: false,
        code: PluginFailureCodes.PLUGIN_NOT_FOUND,
        message: `插件 ${name} 未找到`,
      };
    }

    try {
      return await plugin.execute(config, context);
    } catch (error) {
      return {
        success: false,
        code: PluginFailureCodes.PLUGIN_EXECUTION_ERROR,
        message: `插件执行失败: ${(error as Error).message}`,
      };
    }
  }

  /**
   * 清空所有插件
   */
  function clearPlugins(): void {
    Object.keys(plugins).forEach((key) => delete plugins[key]);
  }

  /**
   * 获取插件统计信息
   */
  function getStats() {
    return {
      total: Object.keys(plugins).length,
      plugins: Object.keys(plugins),
    };
  }

  return {
    registerPlugin,
    registerPlugins,
    unregisterPlugin,
    getPlugin,
    getAllPlugins,
    getPluginNames,
    hasPlugin,
    executePlugin,
    clearPlugins,
    getStats,
  };
}

/**
 * 默认导出插件管理器工厂函数
 */
export const createManager = createPluginManager;
