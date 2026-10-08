import { createHash, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Body, Controller, Headers, HttpException, HttpStatus, Inject, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EXECUTION_REPOSITORY,
  type ExecutionRepository,
  type WorkerPluginOffer,
} from './execution.repository.js';
import {
  authenticateWorker,
  parseWorkerIdentities,
  workerOffersAllowed,
  type WorkerIdentity,
} from './worker-identity-policy.js';

function validOffers(value: unknown): value is WorkerPluginOffer[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every(
      (offer) =>
        offer &&
        typeof offer === 'object' &&
        !Array.isArray(offer) &&
        typeof offer.name === 'string' &&
        offer.name.length > 0 &&
        offer.name.length <= 128 &&
        typeof offer.version === 'string' &&
        offer.version.length > 0 &&
        offer.version.length <= 128 &&
        Array.isArray(offer.capabilities) &&
        offer.capabilities.length <= 32 &&
        offer.capabilities.every(
          (capability: unknown) =>
            typeof capability === 'string' && capability.length > 0 && capability.length <= 128,
        ) &&
        new Set(offer.capabilities).size === offer.capabilities.length,
    ) &&
    new Set(value.map((offer: WorkerPluginOffer) => offer.name)).size === value.length
  );
}

@Controller('executor-workers')
export class WorkerTransportController {
  constructor(
    @Inject(EXECUTION_REPOSITORY) private readonly repository: ExecutionRepository,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  private authorize(header: string | undefined): WorkerIdentity | undefined {
    const configured = this.config.get<string>('EXECUTOR_WORKER_IDENTITIES_JSON');
    let identities: WorkerIdentity[];
    try {
      identities = parseWorkerIdentities(configured);
    } catch {
      throw new HttpException(
        'Invalid worker identity configuration',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const expected = this.config.get<string>('EXECUTOR_WORKER_HTTP_TOKEN')?.trim();
    if (identities.length === 0 && (!expected || expected.length < 32)) {
      throw new HttpException('Worker transport is disabled', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const supplied = /^Bearer ([^\s]+)$/.exec(header ?? '')?.[1];
    if (!supplied) throw new HttpException('Unauthorized worker', HttpStatus.UNAUTHORIZED);
    if (identities.length > 0) {
      const identity = authenticateWorker(supplied, identities);
      if (!identity) throw new HttpException('Unauthorized worker', HttpStatus.UNAUTHORIZED);
      return identity;
    }
    const left = createHash('sha256').update(supplied).digest();
    const right = createHash('sha256').update(expected!).digest();
    if (!timingSafeEqual(left, right)) {
      throw new HttpException('Unauthorized worker', HttpStatus.UNAUTHORIZED);
    }
    return undefined;
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
    const identity = this.authorize(authorization);
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
    const plugins = (body as Record<string, unknown>).plugins;
    if (!workerId || workerId.length > 128) {
      throw new HttpException('Invalid worker claim', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(waitMs) || (waitMs as number) < 0 || (waitMs as number) > 20_000) {
      throw new HttpException('Invalid worker claim wait', HttpStatus.BAD_REQUEST);
    }
    if (!validOffers(plugins)) {
      throw new HttpException('Invalid worker plugin offers', HttpStatus.BAD_REQUEST);
    }
    if (identity && (workerId !== identity.workerId || !workerOffersAllowed(plugins, identity))) {
      throw new HttpException('Worker identity or plugin offer denied', HttpStatus.FORBIDDEN);
    }
    const ttlMs = this.leaseTtlMs();
    const deadline = Date.now() + (waitMs as number);
    while (true) {
      const assignment = await this.repository.claimWorkerDispatch(workerId, ttlMs, plugins);
      if (assignment || Date.now() >= deadline) return { assignment: assignment ?? null };
      await delay(Math.min(250, deadline - Date.now()));
    }
  }

  @Post('messages')
  async message(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const identity = this.authorize(authorization);
    return identity
      ? this.repository.acceptRegisteredWorkerMessage(body, this.leaseTtlMs(), identity.workerId)
      : this.repository.acceptRegisteredWorkerMessage(body, this.leaseTtlMs());
  }
}
