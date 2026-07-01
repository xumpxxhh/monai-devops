import { Controller, Get } from '@nestjs/common';
import { EngineService } from '../engine/engine.service.js';

@Controller()
export class HealthController {
  constructor(private readonly engineService: EngineService) {}

  @Get('healthz')
  healthz() {
    return {
      status: 'ok',
      engineReady: this.engineService.isReady(),
    };
  }
}
