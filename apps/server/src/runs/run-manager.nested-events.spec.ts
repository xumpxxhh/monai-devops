import { jest } from '@jest/globals';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  StepKinds,
  StepStatuses,
  type EmbeddedRunHooks,
  type WorkflowDefinition,
  type WorkflowLifecycleEvent,
  type WorkflowRunResult,
} from '@monai-devops/core-engine';
import type { EngineService } from '../engine/engine.service.js';
import { RunManagerService } from './run-manager.service.js';
import type { RunStreamService } from './run-stream.service.js';
import type { RunRecord, RunRepository } from './runs.repository.js';

describe('RunManagerService nested event routing', () => {
  const rootRunId = 'root-run-1';
  const childRunId = 'child-run-1';
  const grandchildRunId = 'grandchild-run-1';

  let service: RunManagerService;
  let hooks: EmbeddedRunHooks;
  let onEvent: (event: WorkflowLifecycleEvent) => void;
  let parentRecord: RunRecord;
  const appended: Array<{ runId: string; event: { type: string; workflowRunId?: string } }> = [];
  const updates: Array<{ runId: string; patch: Record<string, unknown> }> = [];
  const fanOuts: Array<{ runId: string; payload: { type: string } }> = [];
  let savedRecords: RunRecord[] = [];

  const childDefinition: WorkflowDefinition = {
    id: 'child-wf',
    name: 'Child',
    steps: [{ id: 'c1', name: 'C1', kind: StepKinds.PLUGIN, plugin: 'print', config: {} }],
  };

  beforeEach(() => {
    appended.length = 0;
    updates.length = 0;
    fanOuts.length = 0;
    savedRecords = [];

    parentRecord = {
      runId: rootRunId,
      workflowId: 'parent-wf',
      workflowSnapshot: {
        id: 'parent-wf',
        name: 'Parent',
        steps: [
          {
            id: 'call-child',
            name: 'Call',
            kind: StepKinds.WORKFLOW,
            workflowRef: { importId: 'imp-1' },
          },
        ],
      },
      status: 'running',
      counts: { total: 1, completed: 0, failed: 0, skipped: 0 },
      createdAt: new Date(),
      events: [],
      source: 'api',
      metadata: {},
    };

    const runRepository: Pick<
      RunRepository,
      'findById' | 'save' | 'update' | 'appendEvent' | 'listByParentRunId'
    > = {
      findById: jest.fn(async (id: string) => {
        if (id === rootRunId) return parentRecord;
        return savedRecords.find((r) => r.runId === id);
      }) as RunRepository['findById'],
      save: jest.fn(async (record: RunRecord) => {
        savedRecords.push(record);
      }) as RunRepository['save'],
      update: jest.fn(async (id: string, patch: Partial<RunRecord>) => {
        updates.push({ runId: id, patch: patch as Record<string, unknown> });
        if (id === rootRunId) {
          parentRecord = { ...parentRecord, ...patch };
          return parentRecord;
        }
        return undefined;
      }) as unknown as RunRepository['update'],
      appendEvent: jest.fn(async (runId: string, event: RunRecord['events'][number]) => {
        appended.push({ runId, event: event as { type: string; workflowRunId?: string } });
      }) as RunRepository['appendEvent'],
      listByParentRunId: jest.fn(async () => []) as RunRepository['listByParentRunId'],
    };

    const runStream = {
      fanOut: jest.fn((runId: string, payload: { type: string }) => {
        fanOuts.push({ runId, payload });
      }),
    };

    const engineService = {
      onEvent: jest.fn((cb: (event: WorkflowLifecycleEvent) => void) => {
        onEvent = cb;
        return () => undefined;
      }),
      setEmbeddedRunHooks: jest.fn((h: EmbeddedRunHooks) => {
        hooks = h;
      }),
      getRunStatus: jest.fn(),
      validateWorkflow: jest.fn(),
      runWorkflow: jest.fn(),
      cancelRun: jest.fn(),
      pauseRun: jest.fn(),
      resumeRun: jest.fn(),
    };

    const config = {
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };

    service = new RunManagerService(
      engineService as unknown as EngineService,
      runRepository as unknown as RunRepository,
      runStream as unknown as RunStreamService,
      config as unknown as ConfigService,
      {
        createWorkspace: jest.fn(async () => '/tmp/monai-ci-runs/test'),
        cleanupWorkspace: jest.fn(async () => undefined),
      } as unknown as import('../workspace/workspace.service.js').WorkspaceService,
    );
    service.onModuleInit();

    // 模拟顶层 submit 已登记
    (service as unknown as { managedRunIds: Set<string> }).managedRunIds.add(rootRunId);
  });

  async function flushEvents(): Promise<void> {
    const chains = (service as unknown as { eventChains: Map<string, Promise<void>> }).eventChains;
    await Promise.all([...chains.values()]);
  }

  it('onChildRunStart does not insert a Run row', async () => {
    await hooks.onChildRunStart(childRunId, childDefinition, {
      parentRunId: rootRunId,
      stepId: 'call-child',
      iteration: 0,
    });

    expect(savedRecords).toHaveLength(0);
    const children = await service.listChildren(rootRunId);
    expect(children).toEqual([]);
  });

  it('routes child plugin:log / step events onto the parent run', async () => {
    await hooks.onChildRunStart(childRunId, childDefinition, {
      parentRunId: rootRunId,
      stepId: 'call-child',
      iteration: 0,
    });

    onEvent({
      type: 'plugin:log',
      workflowRunId: childRunId,
      meta: { workflowId: 'child-wf' },
      step: { id: 'c1', name: 'C1', kind: StepKinds.PLUGIN, plugin: 'print', config: {} },
      log: { level: 'info', message: 'hello from child', timestamp: Date.now() },
      parent: { runId: rootRunId, stepId: 'call-child', iteration: 0 },
    } as WorkflowLifecycleEvent);

    onEvent({
      type: 'step:finished',
      workflowRunId: childRunId,
      meta: { workflowId: 'child-wf' },
      step: { id: 'c1', name: 'C1', kind: StepKinds.PLUGIN, plugin: 'print', config: {} },
      result: {
        stepId: 'c1',
        status: StepStatuses.COMPLETED,
        success: true,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      },
      parent: { runId: rootRunId, stepId: 'call-child', iteration: 0 },
    } as WorkflowLifecycleEvent);

    await flushEvents();

    expect(appended.map((a) => a.runId)).toEqual([rootRunId, rootRunId]);
    expect(appended.map((a) => a.event.type)).toEqual(['plugin:log', 'step:finished']);
    expect(fanOuts.every((f) => f.runId === rootRunId)).toBe(true);
    // 嵌套 step:finished 不得改父 counts
    expect(updates.filter((u) => u.patch.counts !== undefined)).toHaveLength(0);
  });

  it('does not let nested workflow:finished mutate parent status/result', async () => {
    await hooks.onChildRunStart(childRunId, childDefinition, {
      parentRunId: rootRunId,
      stepId: 'call-child',
      iteration: 0,
    });

    const childResult: WorkflowRunResult = {
      success: true,
      status: 'success',
      workflowId: 'child-wf',
      results: [],
    };

    onEvent({
      type: 'workflow:finished',
      workflowRunId: childRunId,
      result: childResult,
      parent: { runId: rootRunId, stepId: 'call-child', iteration: 0 },
    } as WorkflowLifecycleEvent);

    await flushEvents();

    expect(appended).toHaveLength(1);
    expect(appended[0]?.runId).toBe(rootRunId);
    expect(updates).toHaveLength(0);
    expect(fanOuts).toEqual([
      expect.objectContaining({
        runId: rootRunId,
        payload: { type: 'event', event: expect.any(Object) },
      }),
    ]);
    expect(parentRecord.status).toBe('running');
  });

  it('routes two-level nested events to the outermost root runId', async () => {
    await hooks.onChildRunStart(childRunId, childDefinition, {
      parentRunId: rootRunId,
      stepId: 'call-child',
      iteration: 0,
    });
    await hooks.onChildRunStart(grandchildRunId, childDefinition, {
      parentRunId: childRunId,
      stepId: 'nested',
      iteration: 0,
    });

    onEvent({
      type: 'plugin:log',
      workflowRunId: grandchildRunId,
      meta: { workflowId: 'child-wf' },
      step: { id: 'c1', name: 'C1', kind: StepKinds.PLUGIN, plugin: 'print', config: {} },
      log: { level: 'info', message: 'from grandchild', timestamp: Date.now() },
      parent: { runId: childRunId, stepId: 'nested', iteration: 0 },
    } as WorkflowLifecycleEvent);

    await flushEvents();

    expect(appended).toEqual([
      expect.objectContaining({
        runId: rootRunId,
        event: expect.objectContaining({ type: 'plugin:log' }),
      }),
    ]);
  });

  it('listChildren returns empty and 404 when parent missing', async () => {
    await expect(service.listChildren('missing')).rejects.toBeInstanceOf(HttpException);
    await expect(service.listChildren(rootRunId)).resolves.toEqual([]);
  });
});
