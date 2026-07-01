import { Global, Module } from '@nestjs/common';
import { EngineService } from './engine.service.js';

@Global()
@Module({
  providers: [EngineService],
  exports: [EngineService],
})
export class EngineModule {}
