import { Body, Controller, Get, Param, Post, Sse, type MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { PluginDryRunDto } from './dto/plugin-dry-run.dto.js';
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

  @Get('result-schemas')
  listResultSchemas() {
    return this.pluginsService.listResultSchemas();
  }

  @Get(':name/config-schema')
  getConfigSchema(@Param('name') name: string) {
    return this.pluginsService.getConfigSchema(name);
  }

  @Get(':name/result-schema')
  getResultSchema(@Param('name') name: string) {
    return this.pluginsService.getResultSchema(name);
  }

  @Get(':name')
  get(@Param('name') name: string) {
    return this.pluginsService.get(name);
  }

  @Post(':name/dry-run')
  @Sse()
  dryRun(
    @Param('name') name: string,
    @Body() body: PluginDryRunDto = {},
  ): Observable<MessageEvent> {
    return this.pluginsService.dryRun(name, body.config ?? {});
  }
}
