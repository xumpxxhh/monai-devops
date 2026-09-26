import { createHash, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Body, Controller, Headers, HttpException, HttpStatus, Inject, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EXECUTION_REPOSITORY, type ExecutionRepository } from './execution.repository.js';

@Controller('executor-workers')
export class WorkerTransportController {
  constructor(
    @Inject(EXECUTION_REPOSITORY) private readonly repository: ExecutionRepository,
    private readonly config: ConfigService,
  ) {}

  private authorize(header: string | undefined): void {
    const expected = this.config.get<string>('EXECUTOR_WORKER_HTTP_TOKEN')?.trim();
    if (!expected || expected.length < 32) {
      throw new HttpException('Worker transport is disabled', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const supplied = /^Bearer ([^\s]+)$/.exec(header ?? '')?.[1];
    if (!supplied) throw new HttpException('Unauthorized worker', HttpStatus.UNAUTHORIZED);
    const left = createHash('sha256').update(supplied).digest();
    const right = createHash('sha256').update(expected).digest();
    if (!timingSafeEqual(left, right)) {
      throw new HttpException('Unauthorized worker', HttpStatus.UNAUTHORIZED);
    }
  }

  private leaseTtlMs(): number {
    const value = Number(this.config.get('EXECUTOR_WORKER_LEASE_TTL_MS') ?? 30_000);
    if (!Number.isInteger(value) || value < 3_000 || value > 300_000) {
      throw new HttpException('Invalid worker lease TTL', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return value;
  }

  @Post('claim')
  async claim(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    this.authorize(authorization);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).workerId !== 'string'
    ) {
      throw new HttpException('Invalid worker claim', HttpStatus.BAD_REQUEST);
    }
    const workerId = (body as { workerId: string }).workerId.trim();
    const waitMs = (body as Record<string, unknown>).waitMs ?? 0;
    if (!workerId || workerId.length > 128) {
      throw new HttpException('Invalid worker claim', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(waitMs) || (waitMs as number) < 0 || (waitMs as number) > 20_000) {
      throw new HttpException('Invalid worker claim wait', HttpStatus.BAD_REQUEST);
    }
    const ttlMs = this.leaseTtlMs();
    const deadline = Date.now() + (waitMs as number);
    while (true) {
      const assignment = await this.repository.claimWorkerDispatch(workerId, ttlMs);
      if (assignment || Date.now() >= deadline) return { assignment: assignment ?? null };
      await delay(Math.min(250, deadline - Date.now()));
    }
  }

  @Post('messages')
  async message(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    this.authorize(authorization);
    return this.repository.acceptRegisteredWorkerMessage(body, this.leaseTtlMs());
  }
}
