import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { parsePagination } from '../common/dto/pagination.dto.js';
import type { SubmitRunOptions } from '../runs/run-manager.service.js';
import { WorkflowsService } from './workflows.service.js';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const pagination = parsePagination({ page: Number(page), pageSize: Number(pageSize) });
    return this.workflowsService.list({ search, ...pagination });
  }

  @Post()
  create(@Body() definition: WorkflowDefinition) {
    return this.workflowsService.create(definition);
  }

  @Post('validate')
  validate(@Body() definition: WorkflowDefinition) {
    return this.workflowsService.validate(definition);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.workflowsService.get(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() definition: WorkflowDefinition) {
    return this.workflowsService.update(id, definition);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.workflowsService.remove(id);
  }

  @Post(':id/run')
  run(@Param('id') id: string, @Body() options: SubmitRunOptions = {}) {
    return this.workflowsService.triggerRun(id, options);
  }
}
