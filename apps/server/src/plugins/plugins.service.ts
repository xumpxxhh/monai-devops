import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { PluginConfig } from '@monai-devops/plugin-sdk';
import { EngineService } from '../engine/engine.service.js';

@Injectable()
export class PluginsService {
  constructor(private readonly engineService: EngineService) {}

  list() {
    return this.engineService.getPlugins();
  }

  get(name: string) {
    const plugin = this.engineService.getPlugin(name);
    if (!plugin) {
      throw new HttpException('插件不存在', HttpStatus.NOT_FOUND);
    }
    return plugin;
  }

  getConfigSchema(name: string) {
    const schema = this.engineService.getPluginConfigJsonSchema(name);
    if (!schema) {
      throw new HttpException('插件不存在或未声明 configSchema', HttpStatus.NOT_FOUND);
    }
    return { name, configJsonSchema: schema };
  }

  dryRun(name: string, config: PluginConfig) {
    if (!this.engineService.getPlugin(name)) {
      throw new HttpException('插件不存在', HttpStatus.NOT_FOUND);
    }
    return this.engineService.dryRunPlugin(name, config);
  }
}
