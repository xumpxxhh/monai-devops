import { Injectable } from '@nestjs/common';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import type {
  Workflow as PrismaWorkflow,
  WorkflowImport as PrismaWorkflowImport,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { toInputJson } from '../prisma/prisma-json.js';
import {
  type WorkflowImportMode,
  type WorkflowImportRecord,
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
    ownerWorkflowId: row.ownerWorkflowId ?? undefined,
  };
}

function extractChildStateSchema(definition: unknown): Record<string, unknown> | undefined {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return undefined;
  }
  const schema = (definition as { stateSchema?: unknown }).stateSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }
  return schema as Record<string, unknown>;
}

function toImportRecord(
  row: PrismaWorkflowImport & {
    childWorkflow?: Pick<PrismaWorkflow, 'name' | 'updatedAt' | 'definition'>;
  },
): WorkflowImportRecord {
  const childStateSchema = extractChildStateSchema(row.childWorkflow?.definition);
  return {
    id: row.id,
    parentWorkflowId: row.parentWorkflowId,
    childWorkflowId: row.childWorkflowId,
    stepId: row.stepId,
    mode: row.mode as WorkflowImportMode,
    createdAt: row.createdAt,
    childWorkflowName: row.childWorkflow?.name,
    childWorkflowUpdatedAt: row.childWorkflow?.updatedAt,
    ...(childStateSchema ? { childStateSchema } : {}),
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
        ownerWorkflowId: record.ownerWorkflowId ?? null,
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
    const publicOnly = filter.publicOnly !== false;
    const search = filter.search?.trim();
    const where = {
      ...(publicOnly ? { ownerWorkflowId: null } : {}),
      ...(search
        ? {
            OR: [
              { id: { contains: search, mode: 'insensitive' as const } },
              { name: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

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

  async listImports(parentWorkflowId: string): Promise<WorkflowImportRecord[]> {
    const rows = await this.prisma.workflowImport.findMany({
      where: { parentWorkflowId },
      include: { childWorkflow: { select: { name: true, updatedAt: true, definition: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toImportRecord);
  }

  async findImportById(importId: string): Promise<WorkflowImportRecord | undefined> {
    const row = await this.prisma.workflowImport.findUnique({
      where: { id: importId },
      include: { childWorkflow: { select: { name: true, updatedAt: true, definition: true } } },
    });
    return row ? toImportRecord(row) : undefined;
  }

  async createImport(record: WorkflowImportRecord): Promise<WorkflowImportRecord> {
    const row = await this.prisma.workflowImport.create({
      data: {
        id: record.id,
        parentWorkflowId: record.parentWorkflowId,
        childWorkflowId: record.childWorkflowId,
        stepId: record.stepId,
        mode: record.mode,
        createdAt: record.createdAt,
      },
      include: { childWorkflow: { select: { name: true, updatedAt: true, definition: true } } },
    });
    return toImportRecord(row);
  }

  async updateImportStepIds(
    parentWorkflowId: string,
    stepIdByImportId: Map<string, string>,
  ): Promise<void> {
    if (stepIdByImportId.size === 0) return;
    await this.prisma.$transaction(
      [...stepIdByImportId.entries()].map(([importId, stepId]) =>
        this.prisma.workflowImport.updateMany({
          where: { id: importId, parentWorkflowId },
          data: { stepId },
        }),
      ),
    );
  }

  async deleteUnusedImports(
    parentWorkflowId: string,
    keepImportIds: ReadonlySet<string>,
  ): Promise<void> {
    const existing = await this.prisma.workflowImport.findMany({
      where: { parentWorkflowId },
      select: { id: true },
    });
    const toDelete = existing.map((row) => row.id).filter((id) => !keepImportIds.has(id));
    if (toDelete.length === 0) return;
    await this.prisma.workflowImport.deleteMany({
      where: { id: { in: toDelete } },
    });
  }

  async listReferencingParents(
    childWorkflowId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.prisma.workflowImport.findMany({
      where: { childWorkflowId },
      include: { parentWorkflow: { select: { id: true, name: true } } },
    });
    const seen = new Map<string, string>();
    for (const row of rows) {
      seen.set(row.parentWorkflow.id, row.parentWorkflow.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }

  async resolveWorkflowByImportId(importId: string): Promise<WorkflowDefinition | undefined> {
    const row = await this.prisma.workflowImport.findUnique({
      where: { id: importId },
      include: { childWorkflow: true },
    });
    if (!row) return undefined;
    return row.childWorkflow.definition as unknown as WorkflowDefinition;
  }
}
