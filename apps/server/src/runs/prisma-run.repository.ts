import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { toInputJson } from '../prisma/prisma-json.js';
import { applyAppendRunEvent, getRunEventRowIdsToDelete } from './run-event-merge.js';
import {
  ACTIVE_RUN_STATUSES,
  toRunCreateData,
  toRunRecord,
  toRunUpdateData,
} from './run-record.mapper.js';
import {
  type RunListFilter,
  type RunRecord,
  type RunRepository,
  type RunStatus,
} from './runs.repository.js';

@Injectable()
export class PrismaRunRepository implements RunRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async save(record: RunRecord, recoveryState?: unknown): Promise<void> {
    await this.prisma.run.create({
      data: {
        ...toRunCreateData(record),
        recoveryState:
          recoveryState === undefined ? Prisma.DbNull : toInputJson({ value: recoveryState }),
        events: {
          create: record.events.map((event, index) => ({
            eventIndex: index,
            type: String(event.type),
            payload: toInputJson(event),
          })),
        },
      },
    });
  }

  async getRecoveryState(runId: string): Promise<{ present: boolean; value?: unknown }> {
    const row = await this.prisma.run.findUnique({
      where: { runId },
      select: { recoveryState: true },
    });
    const payload = row?.recoveryState;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { present: false };
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'value')) return { present: false };
    return { present: true, value: (payload as Record<string, unknown>).value };
  }

  async acquireRunLease(
    runId: string,
    ownerId: string,
    token: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const now = new Date();
    if (expiresAt <= now) return false;
    const result = await this.prisma.run.updateMany({
      where: {
        runId,
        isActive: true,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        leaseOwner: ownerId,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
        leaseHeartbeatAt: now,
      },
    });
    return result.count === 1;
  }

  async heartbeatRunLease(runId: string, token: string, expiresAt: Date): Promise<boolean> {
    const now = new Date();
    if (expiresAt <= now) return false;
    const result = await this.prisma.run.updateMany({
      where: { runId, leaseToken: token, leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: expiresAt, leaseHeartbeatAt: now },
    });
    return result.count === 1;
  }

  async releaseRunLease(runId: string, token: string): Promise<boolean> {
    const result = await this.prisma.run.updateMany({
      where: { runId, leaseToken: token },
      data: {
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        leaseHeartbeatAt: null,
      },
    });
    return result.count === 1;
  }

  async listRecoverableRunIds(
    now: Date,
    unleasedBefore: Date,
    limit: number,
    excludeRunIds: string[] = [],
  ): Promise<string[]> {
    const rows = await this.prisma.run.findMany({
      where: {
        isActive: true,
        parentRunId: null,
        status: { in: ['queued', 'running'] },
        executionJobs: {
          none: { attempts: { some: { status: 'waiting', wakeReadyAt: null } } },
        },
        ...(excludeRunIds.length > 0 ? { runId: { notIn: excludeRunIds } } : {}),
        OR: [
          { leaseExpiresAt: { lt: now } },
          { leaseExpiresAt: null, createdAt: { lt: unleasedBefore } },
        ],
      },
      select: { runId: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.runId);
  }

  async update(runId: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
    const existing = await this.prisma.run.findUnique({ where: { runId } });
    if (!existing) return undefined;

    const updated = await this.prisma.run.update({
      where: { runId },
      data: toRunUpdateData(patch),
      include: {
        events: { orderBy: { eventIndex: 'asc' } },
      },
    });

    return toRunRecord(updated, updated.events);
  }

  async findById(runId: string): Promise<RunRecord | undefined> {
    const run = await this.prisma.run.findUnique({
      where: { runId },
      include: {
        events: { orderBy: { eventIndex: 'asc' } },
      },
    });
    if (!run) return undefined;
    return toRunRecord(run, run.events);
  }

  async list(filter: RunListFilter): Promise<{ items: RunRecord[]; total: number }> {
    const where = this.buildListWhere(filter);

    const [total, rows] = await Promise.all([
      this.prisma.run.count({ where }),
      this.prisma.run.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
        include: {
          events: { orderBy: { eventIndex: 'asc' } },
        },
      }),
    ]);

    return {
      items: rows.map((row) => toRunRecord(row, row.events)),
      total,
    };
  }

  async listByParentRunId(parentRunId: string): Promise<RunRecord[]> {
    const rows = await this.prisma.run.findMany({
      where: { parentRunId },
      orderBy: { createdAt: 'asc' },
      include: {
        events: { orderBy: { eventIndex: 'asc' } },
      },
    });
    return rows.map((row) => toRunRecord(row, row.events));
  }

  async appendEvent(
    runId: string,
    event: RunRecord['events'][number],
  ): Promise<number | undefined> {
    const limit = this.config.get<number>('RUN_HISTORY_LIMIT', 500);

    return this.prisma.$transaction(async (tx) => {
      const run = await tx.run.findUnique({ where: { runId } });
      if (!run) return undefined;

      const rows = await tx.runEvent.findMany({
        where: { runId },
        orderBy: { eventIndex: 'asc' },
      });
      const events = rows.map((row) => structuredClone(row.payload) as RunRecord['events'][number]);
      const { action } = applyAppendRunEvent(events, structuredClone(event), limit);
      const latestPayload = events[events.length - 1];
      if (!latestPayload) return undefined;

      let persistedOffset: number;

      if (action === 'merge' && rows.length > 0) {
        const lastRow = rows[rows.length - 1]!;
        await tx.runEvent.update({
          where: { id: lastRow.id },
          data: { payload: toInputJson(latestPayload) },
        });
        persistedOffset = lastRow.eventIndex;
      } else {
        const lastRow = rows[rows.length - 1];
        persistedOffset = lastRow ? lastRow.eventIndex + 1 : 0;
        await tx.runEvent.create({
          data: {
            runId,
            eventIndex: persistedOffset,
            type: String(latestPayload.type),
            payload: toInputJson(latestPayload),
          },
        });
      }

      const refreshed = await tx.runEvent.findMany({
        where: { runId },
        orderBy: { eventIndex: 'asc' },
      });
      const deleteIds = getRunEventRowIdsToDelete(refreshed, limit);
      if (deleteIds.length > 0) {
        await tx.runEvent.deleteMany({
          where: { id: { in: deleteIds } },
        });
      }
      return persistedOffset;
    });
  }

  async delete(runId: string): Promise<boolean> {
    try {
      await this.prisma.run.delete({ where: { runId } });
      return true;
    } catch {
      return false;
    }
  }

  async countActive(): Promise<number> {
    return this.prisma.run.count({
      where: { status: { in: ACTIVE_RUN_STATUSES } },
    });
  }

  async countByStatus(status: RunStatus): Promise<number> {
    return this.prisma.run.count({ where: { status } });
  }

  private buildListWhere(filter: RunListFilter): Prisma.RunWhereInput {
    const where: Prisma.RunWhereInput = {};

    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.workflowId) {
      where.workflowId = filter.workflowId;
    }
    if (filter.search?.trim()) {
      const keyword = filter.search.trim();
      where.OR = [
        { runId: { contains: keyword, mode: 'insensitive' } },
        { workflowId: { contains: keyword, mode: 'insensitive' } },
        { workflowName: { contains: keyword, mode: 'insensitive' } },
      ];
    }
    if (filter.metadata && Object.keys(filter.metadata).length > 0) {
      where.metadata = { equals: toInputJson(filter.metadata) };
    }
    if (filter.parentRunId) {
      where.parentRunId = filter.parentRunId;
    }

    return where;
  }
}
