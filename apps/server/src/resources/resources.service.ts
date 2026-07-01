import { Injectable } from '@nestjs/common';
import { EngineService } from '../engine/engine.service.js';

@Injectable()
export class ResourcesService {
  constructor(private readonly engineService: EngineService) {}

  list() {
    return this.engineService.getResources();
  }

  queue() {
    return this.engineService.getQueueStatus();
  }
}
