import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { parsePagination } from '../common/dto/pagination.dto.js';
import { RunManagerService, type SubmitRunOptions } from './run-manager.service.js';
import type { RunStatus } from './runs.repository.js';

interface InlineRunBody extends SubmitRunOptions {
  workflow: WorkflowDefinition;
}

@Controller('runs')
export class RunsController {
  constructor(private readonly runManager: RunManagerService) {}

  @Get()
  async list(
    @Query('status') status?: RunStatus,
    @Query('workflowId') workflowId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const pagination = parsePagination({ page: Number(page), pageSize: Number(pageSize) });
    const result = await this.runManager.listRuns({
      status,
      workflowId,
      search,
      ...pagination,
    });
    return { ...result, ...pagination };
  }

  @Post()
  submit(@Body() body: InlineRunBody) {
    if (!body?.workflow) {
      throw new HttpException('workflow 是必填字段', HttpStatus.BAD_REQUEST);
    }
    const { workflow, ...options } = body;
    return this.runManager.submitRun(workflow, options);
  }

  @Get(':runId')
  async get(@Param('runId') runId: string) {
    const record = await this.runManager.getRun(runId);
    if (!record) {
      throw new HttpException('Run 不存在', HttpStatus.NOT_FOUND);
    }
    return record;
  }

  @Get(':runId/events')
  async getEvents(@Param('runId') runId: string) {
    const events = await this.runManager.getEvents(runId);
    if (!events) {
      throw new HttpException('Run 不存在', HttpStatus.NOT_FOUND);
    }
    return { runId, events };
  }

  @Post(':runId/cancel')
  cancel(@Param('runId') runId: string) {
    return this.runManager.cancelRun(runId);
  }

  @Delete(':runId')
  async remove(@Param('runId') runId: string) {
    const deleted = await this.runManager.deleteRun(runId);
    if (!deleted) {
      throw new HttpException('Run 不存在', HttpStatus.NOT_FOUND);
    }
    return { runId, deleted: true };
  }
}
