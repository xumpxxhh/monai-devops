import { Controller, Get } from '@nestjs/common';
import { TestDevopsService } from './test-devops.service.js';

@Controller('test-devops')
export class TestDevopsController {
  constructor(private readonly testDevopsService: TestDevopsService) {}

  @Get()
  runIntegrationTest() {
    return this.testDevopsService.runIntegrationTest();
  }
}
