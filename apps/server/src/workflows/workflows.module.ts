import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { provideWorkflowRepository } from './in-memory-workflow.repository.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';

@Module({
  imports: [RunsModule],
  controllers: [WorkflowsController],
  providers: [provideWorkflowRepository(), WorkflowsService],
})
export class WorkflowsModule {}
