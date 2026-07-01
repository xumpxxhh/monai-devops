import { Module } from '@nestjs/common';
import { PluginsController } from './plugins.controller.js';
import { PluginsService } from './plugins.service.js';

@Module({
  controllers: [PluginsController],
  providers: [PluginsService],
})
export class PluginsModule {}
