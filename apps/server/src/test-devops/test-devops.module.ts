import { Module } from '@nestjs/common';
import { TestDevopsController } from './test-devops.controller.js';
import { TestDevopsService } from './test-devops.service.js';

@Module({
  controllers: [TestDevopsController],
  providers: [TestDevopsService],
})
export class TestDevopsModule {}
