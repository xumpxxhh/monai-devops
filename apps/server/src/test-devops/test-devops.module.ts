import { Module } from '@nestjs/common';
import { TestDevopsController } from './test-devops.controller.js';
import { TestDevopsGateway } from './test-devops.gateway.js';
import { TestDevopsService } from './test-devops.service.js';

@Module({
  controllers: [TestDevopsController],
  providers: [TestDevopsService, TestDevopsGateway],
})
export class TestDevopsModule {}
