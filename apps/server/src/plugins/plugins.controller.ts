import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { PluginConfig } from '@monai-devops/plugin-sdk';
import { PluginsService } from './plugins.service.js';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly pluginsService: PluginsService) {}

  @Get()
  list() {
    return this.pluginsService.list();
  }

  @Get(':name/config-schema')
  getConfigSchema(@Param('name') name: string) {
    return this.pluginsService.getConfigSchema(name);
  }

  @Get(':name')
  get(@Param('name') name: string) {
    return this.pluginsService.get(name);
  }

  @Post(':name/dry-run')
  dryRun(@Param('name') name: string, @Body() body: { config: PluginConfig }) {
    return this.pluginsService.dryRun(name, body?.config ?? {});
  }
}
