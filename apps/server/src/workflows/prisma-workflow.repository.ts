import { Injectable } from '@nestjs/common';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import type { Workflow as PrismaWorkflow } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { toInputJson } from '../prisma/prisma-json.js';
import {
  type WorkflowListFilter,
  type WorkflowRecord,
  type WorkflowRepository,
} from './workflows.repository.js';

function toWorkflowRecord(row: PrismaWorkflow): WorkflowRecord {
  return {
    id: row.id,
    definition: row.definition as unknown as WorkflowDefinition,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy ?? undefined,
  };
}

@Injectable()
export class PrismaWorkflowRepository implements WorkflowRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(record: WorkflowRecord): Promise<void> {
    await this.prisma.workflow.create({
      data: {
        id: record.id,
        name: record.definition.name,
        definition: toInputJson(record.definition),
        createdBy: record.createdBy ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
  }

  async findById(id: string): Promise<WorkflowRecord | undefined> {
    const row = await this.prisma.workflow.findUnique({ where: { id } });
    return row ? toWorkflowRecord(row) : undefined;
  }

  async findByName(name: string): Promise<WorkflowRecord | undefined> {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return undefined;

    const row = await this.prisma.workflow.findFirst({
      where: {
        name: { equals: name.trim(), mode: 'insensitive' },
      },
    });
    return row ? toWorkflowRecord(row) : undefined;
  }

  async list(filter: WorkflowListFilter) {
    const where = filter.search?.trim()
      ? {
          OR: [
            { id: { contains: filter.search.trim(), mode: 'insensitive' as const } },
            { name: { contains: filter.search.trim(), mode: 'insensitive' as const } },
          ],
        }
      : undefined;

    const [total, rows] = await Promise.all([
      this.prisma.workflow.count({ where }),
      this.prisma.workflow.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
    ]);

    return {
      items: rows.map(toWorkflowRecord),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }

  async update(id: string, definition: WorkflowDefinition): Promise<WorkflowRecord | undefined> {
    try {
      const updated = await this.prisma.workflow.update({
        where: { id },
        data: {
          name: definition.name,
          definition: toInputJson(definition),
        },
      });
      return toWorkflowRecord(updated);
    } catch {
      return undefined;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.workflow.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
