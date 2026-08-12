import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
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

  async save(record: RunRecord): Promise<void> {
    await this.prisma.run.create({
      data: {
        ...toRunCreateData(record),
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

  async appendEvent(runId: string, event: RunRecord['events'][number]): Promise<void> {
    const limit = this.config.get<number>('RUN_HISTORY_LIMIT', 500);

    await this.prisma.$transaction(async (tx) => {
      const run = await tx.run.findUnique({ where: { runId } });
      if (!run) return;

      const rows = await tx.runEvent.findMany({
        where: { runId },
        orderBy: { eventIndex: 'asc' },
      });
      const events = rows.map((row) => structuredClone(row.payload) as RunRecord['events'][number]);
      const { action } = applyAppendRunEvent(events, structuredClone(event), limit);
      const latestPayload = events[events.length - 1];
      if (!latestPayload) return;

      if (action === 'merge' && rows.length > 0) {
        const lastRow = rows[rows.length - 1]!;
        await tx.runEvent.update({
          where: { id: lastRow.id },
          data: { payload: toInputJson(latestPayload) },
        });
      } else {
        const lastRow = rows[rows.length - 1];
        await tx.runEvent.create({
          data: {
            runId,
            eventIndex: lastRow ? lastRow.eventIndex + 1 : 0,
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
