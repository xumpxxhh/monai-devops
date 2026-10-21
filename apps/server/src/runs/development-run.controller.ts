import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EXECUTION_REPOSITORY,
  type ExecutionRepository,
} from '../execution/execution.repository.js';
import { ExecutionWakeService } from '../execution/execution-wake.service.js';
import { developmentRunTenantCanDispatch } from './development-run-tenant.js';
import { RUN_REPOSITORY, type RunRepository } from './runs.repository.js';

/** Local development inspection only; never expose Worker credentials to the browser. */
@Controller('runs')
export class DevelopmentRunController {
  constructor(
    private readonly config: ConfigService,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(EXECUTION_REPOSITORY) private readonly executions: ExecutionRepository,
    private readonly wake: ExecutionWakeService,
  ) {}

  private async assertLocalDevelopmentRun(runId: string): Promise<void> {
    if (
      this.config.get<string>('APP_ENV') !== 'local-dev' ||
      process.env.NODE_ENV === 'production'
    ) {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }
    const run = await this.runs.findById(runId);
    if (!run || !developmentRunTenantCanDispatch(run)) {
      throw new HttpException('Run not found', HttpStatus.NOT_FOUND);
    }
  }

  @Get(':runId/execution')
  async listAttempts(@Param('runId') runId: string) {
    await this.assertLocalDevelopmentRun(runId);
    return { runId, attempts: await this.executions.listDevelopmentAttemptsForRun(runId) };
  }

  @Post(':runId/attempts/:attemptId/signal')
  async signalWait(
    @Param('runId') runId: string,
    @Param('attemptId') attemptId: string,
    @Body() body: unknown,
  ) {
    await this.assertLocalDevelopmentRun(runId);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpException('Invalid signal body', HttpStatus.BAD_REQUEST);
    }
    const { key, payload } = body as { key?: unknown; payload?: unknown };
    if (typeof key !== 'string' || !key.trim() || key.length > 128) {
      throw new HttpException('Invalid signal key', HttpStatus.BAD_REQUEST);
    }
    if (JSON.stringify(payload ?? null).length > 16_384) {
      throw new HttpException('Signal payload too large', HttpStatus.BAD_REQUEST);
    }
    const attempts = await this.executions.listDevelopmentAttemptsForRun(runId);
    const attempt = attempts.find((item) => item.attemptId === attemptId);
    if (!attempt || attempt.status !== 'waiting') {
      throw new HttpException('Waiting Attempt not found', HttpStatus.NOT_FOUND);
    }
    if (!(await this.wake.signal(attemptId, key.trim(), payload ?? null))) {
      throw new HttpException('Signal did not match current wait', HttpStatus.CONFLICT);
    }
    return { runId, attemptId, accepted: true };
  }

  @Get(':runId/objects/:objectId')
  async readObject(@Param('runId') runId: string, @Param('objectId') objectId: string) {
    await this.assertLocalDevelopmentRun(runId);
    const object = await this.executions.readDevelopmentRunObject(runId, objectId);
    if (!object) throw new HttpException('Object not found', HttpStatus.NOT_FOUND);
    return { objectRef: object.ref, bodyBase64: object.content.toString('base64') };
  }
}
