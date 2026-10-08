import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { PrismaWorkflowRepository } from './prisma-workflow.repository.js';
import { WORKFLOW_REPOSITORY } from './workflows.repository.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';
import { DevelopmentWorkflowSeeder } from './development-workflow-seeder.js';

@Module({
  imports: [RunsModule],
  controllers: [WorkflowsController],
  providers: [
    PrismaWorkflowRepository,
    { provide: WORKFLOW_REPOSITORY, useExisting: PrismaWorkflowRepository },
    WorkflowsService,
    DevelopmentWorkflowSeeder,
  ],
})
export class WorkflowsModule {}
