import { Controller, Get } from '@nestjs/common';
import { ResourcesService } from './resources.service.js';

@Controller('resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Get()
  list() {
    return this.resourcesService.list();
  }

  @Get('queue')
  queue() {
    return this.resourcesService.queue();
  }
}
