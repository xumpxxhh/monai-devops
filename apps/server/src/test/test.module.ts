import { Module } from '@nestjs/common';
import { TestController } from './test.controller.js';
import { TestService } from './test.service.js';

@Module({
  controllers: [TestController],
  providers: [TestService],
})
export class TestModule {}
