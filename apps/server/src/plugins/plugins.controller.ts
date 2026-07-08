import { Body, Controller, Get, Param, Post, Sse, type MessageEvent } from '@nestjs/common';
import type { PluginConfig } from '@monai-devops/plugin-sdk';
import type { Observable } from 'rxjs';
import { PluginsService } from './plugins.service.js';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly pluginsService: PluginsService) {}

  @Get()
  list() {
    return this.pluginsService.list();
  }

  @Get('config-schemas')
  listConfigSchemas() {
    return this.pluginsService.listConfigSchemas();
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
  @Sse()
  dryRun(
    @Param('name') name: string,
    @Body() body: { config: PluginConfig },
  ): Observable<MessageEvent> {
    return this.pluginsService.dryRun(name, body?.config ?? {});
  }
}
