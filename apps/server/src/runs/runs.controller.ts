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
import { resolvePagination } from '../common/dto/pagination.dto.js';
import { CancelRunDto } from './dto/cancel-run.dto.js';
import { ListRunsQueryDto } from './dto/list-runs.query.dto.js';
import { PauseRunDto } from './dto/pause-run.dto.js';
import { SubmitRunDto } from './dto/submit-run.dto.js';
import { RunManagerService } from './run-manager.service.js';

@Controller('runs')
export class RunsController {
  constructor(private readonly runManager: RunManagerService) {}

  @Get()
  async list(@Query() query: ListRunsQueryDto) {
    const pagination = resolvePagination(query);
    const result = await this.runManager.listRuns({
      status: query.status,
      workflowId: query.workflowId,
      search: query.search,
      ...pagination,
    });
    return { ...result, ...pagination };
  }

  @Post()
  submit(@Body() body: SubmitRunDto) {
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

  /** 子执行不再落独立 Run；保留路由兼容，children 恒为空数组 */
  @Get(':runId/children')
  async getChildren(@Param('runId') runId: string) {
    const children = await this.runManager.listChildren(runId);
    return { runId, children };
  }

  @Post(':runId/cancel')
  cancel(@Param('runId') runId: string, @Body() body: CancelRunDto = {}) {
    return this.runManager.cancelRun(runId, body);
  }

  @Post(':runId/pause')
  pause(@Param('runId') runId: string, @Body() body: PauseRunDto = {}) {
    return this.runManager.pauseRun(runId, body);
  }

  @Post(':runId/resume')
  resume(@Param('runId') runId: string) {
    return this.runManager.resumeRun(runId);
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
