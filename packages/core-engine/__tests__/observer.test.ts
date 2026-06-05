import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../engine/index.js";
import {
  createWorkflowExecutor,
  WorkflowValidationError,
  type WorkflowDefinition,
  type PluginExecutor,
} from "../executor/index.js";
import { createPlugin, getContext } from "@monai-devops/plugin-sdk";
import { WorkflowContextKeys } from "../context-keys.js";
import {
  SkipReasons,
  StepFailureKinds,
  StepStatuses,
} from "../errors.js";
import type { WorkflowLifecycleEvent } from "../observer/index.js";

const testPlugin = createPlugin({
  name: "test-plugin",
  version: "1.0.0",
  execute: async (config) => {
    const type = config.type as string;
    if (type === "unit") {
      return { success: true, message: "ok", data: { type } };
    }
    if (type === "fail") {
      return { success: false, message: "plugin failed" };
    }
    return { success: false, message: `unknown: ${type}` };
  },
});

function mockExecutor(
  impl?: (stepId: string) => Promise<{ success: boolean; data?: unknown; message?: string }>,
): PluginExecutor {
  return async (_pluginName, _config, ctx) => {
    const stepId = getContext<string>(ctx, WorkflowContextKeys.stepId)!;
    if (impl) return impl(stepId);
    return { success: true, data: { stepId } };
  };
}

function collectEvents() {
  const events: WorkflowLifecycleEvent[] = [];
  const observer = {
    onEvent: async (event: WorkflowLifecycleEvent) => {
      events.push(event);
    },
  };
  return { events, observer };
}

describe("WorkflowObserver", () => {
  it("emits workflow and step events on single step success", async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({
      observer,
      pluginExecutor: mockExecutor(),
    });

    await executor.executeWorkflow({
      id: "wf-1",
      name: "single",
      steps: [{ id: "s1", name: "S1", plugin: "p", config: {} }],
    });

    assert.deepEqual(
      events.map((e) => e.type),
      ["workflow:start", "step:start", "step:finished", "workflow:finished"],
    );
    assert.equal(events[0]?.type === "workflow:start" && events[0].meta.runId.length > 0, true);
    const finished = events.find((e) => e.type === "step:finished");
    assert.equal(
      finished?.type === "step:finished" && finished.result.status,
      StepStatuses.COMPLETED,
    );
  });

  it("uses custom runId and traceId from context", async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({
      observer,
      pluginExecutor: mockExecutor(),
    });

    await executor.executeWorkflow(
      {
        id: "wf-meta",
        name: "meta",
        steps: [{ id: "s1", name: "S1", plugin: "p", config: {} }],
      },
      { runId: "custom-run-id", traceId: "custom-trace-id" },
    );

    for (const event of events) {
      assert.equal(event.meta.runId, "custom-run-id");
      assert.equal(event.meta.traceId, "custom-trace-id");
    }
  });

  it("skips step:start for condition skip but emits step:finished", async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({
      observer,
      pluginExecutor: mockExecutor(),
    });

    await executor.executeWorkflow({
      id: "wf-cond",
      name: "cond",
      steps: [
        { id: "a", name: "A", plugin: "p", config: {} },
        {
          id: "b",
          name: "B",
          plugin: "p",
          config: {},
          dependsOn: ["a"],
          condition: { when: "a", equals: { missing: true } },
        },
      ],
    });

    const stepStarts = events.filter((e) => e.type === "step:start");
    assert.equal(stepStarts.length, 1);
    assert.equal(stepStarts[0]?.type === "step:start" && stepStarts[0].step.id, "a");

    const bFinished = events.find(
      (e) => e.type === "step:finished" && e.step.id === "b",
    );
    assert.equal(
      bFinished?.type === "step:finished" && bFinished.result.skipReason,
      SkipReasons.CONDITION_NOT_MET,
    );
  });

  it("emits step:finished failed on plugin failure", async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({
      observer,
      pluginExecutor: mockExecutor(async () => ({
        success: false,
        message: "fail",
      })),
    });

    const run = await executor.executeWorkflow({
      id: "wf-fail",
      name: "fail",
      steps: [{ id: "s1", name: "S1", plugin: "p", config: {} }],
    });

    assert.equal(run.success, false);
    const stepFinished = events.find((e) => e.type === "step:finished");
    assert.equal(
      stepFinished?.type === "step:finished" && stepFinished.result.status,
      StepStatuses.FAILED,
    );
    assert.equal(events.at(-1)?.type, "workflow:finished");
  });

  it("failFast emits workflow_aborted for unscheduled steps", async () => {
    const { events, observer } = collectEvents();
    const executed: string[] = [];
    const executor = createWorkflowExecutor({
      observer,
      failFast: true,
      maxParallelSteps: 1,
      pluginExecutor: mockExecutor(async (stepId) => {
        executed.push(stepId);
        if (stepId === "a") return { success: false, message: "fail a" };
        return { success: true, data: {} };
      }),
    });

    await executor.executeWorkflow({
      id: "wf-abort",
      name: "abort",
      steps: [
        { id: "a", name: "A", plugin: "p", config: {} },
        { id: "b", name: "B", plugin: "p", config: {} },
        { id: "c", name: "C", plugin: "p", config: {}, dependsOn: ["a"] },
      ],
    });

    assert.ok(executed.includes("a"));
    assert.ok(!executed.includes("b"));

    const bFinished = events.find(
      (e) => e.type === "step:finished" && e.step.id === "b",
    );
    assert.equal(
      bFinished?.type === "step:finished" && bFinished.result.skipReason,
      SkipReasons.WORKFLOW_ABORTED,
    );

    const cFinished = events.find(
      (e) => e.type === "step:finished" && e.step.id === "c",
    );
    assert.equal(
      cFinished?.type === "step:finished" && cFinished.result.skipReason,
      SkipReasons.DEPENDENCY_FAILED,
    );
  });

  it("parallel steps emit two step:finished events", async () => {
    const { events, observer } = collectEvents();
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const executor = createWorkflowExecutor({
      observer,
      maxParallelSteps: 2,
      pluginExecutor: async (_name, _config, ctx) => {
        const stepId = getContext<string>(ctx, WorkflowContextKeys.stepId)!;
        await delay(30);
        return { success: true, data: { stepId } };
      },
    });

    await executor.executeWorkflow({
      id: "wf-par",
      name: "parallel",
      steps: [
        { id: "a", name: "A", plugin: "p", config: {} },
        { id: "b", name: "B", plugin: "p", config: {} },
      ],
    });

    const finished = events.filter((e) => e.type === "step:finished");
    assert.equal(finished.length, 2);
    const ids = finished.map((e) => (e.type === "step:finished" ? e.step.id : ""));
    assert.ok(ids.includes("a"));
    assert.ok(ids.includes("b"));
  });

  it("does not emit workflow:start on invalid DAG", async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({ observer, pluginExecutor: mockExecutor() });

    await assert.rejects(
      () =>
        executor.executeWorkflow({
          id: "cycle",
          name: "cycle",
          steps: [
            { id: "a", name: "A", plugin: "p", config: {}, dependsOn: ["b"] },
            { id: "b", name: "B", plugin: "p", config: {}, dependsOn: ["a"] },
          ],
        }),
      WorkflowValidationError,
    );

    assert.equal(events.length, 0);
  });

  it("createEngine observer receives events on resource allocation failure", async () => {
    const { events, observer } = collectEvents();
    const engine = createEngine({ plugins: [testPlugin], observer });

    const run = await engine.runWorkflow({
      id: "wf-res",
      name: "resource fail",
      steps: [
        {
          id: "s1",
          name: "needs runner",
          plugin: "test-plugin",
          config: { type: "unit", resourceType: "runner" },
        },
      ],
    });

    assert.equal(run.success, false);
    assert.ok(events.some((e) => e.type === "workflow:start"));
    assert.ok(
      events.some(
        (e) =>
          e.type === "step:finished" &&
          e.result.status === StepStatuses.FAILED &&
          e.result.failureKind === StepFailureKinds.RESOURCE,
      ),
    );
    assert.equal(events.at(-1)?.type, "workflow:finished");
    engine.destroy();
  });

  it("injects runId into step execution context", async () => {
    let capturedRunId: string | undefined;
    const executor = createWorkflowExecutor({
      pluginExecutor: async (_name, _config, ctx) => {
        capturedRunId = getContext<string>(ctx, WorkflowContextKeys.runId);
        return { success: true, data: {} };
      },
    });

    await executor.executeWorkflow(
      {
        id: "wf-ctx",
        name: "ctx",
        steps: [{ id: "s1", name: "S1", plugin: "p", config: {} }],
      },
      { runId: "injected-run-id" },
    );

    assert.equal(capturedRunId, "injected-run-id");
  });

  it("executeStep alone does not emit workflow events", async () => {
    const { events, observer } = collectEvents();
    const executor = createWorkflowExecutor({ observer, pluginExecutor: mockExecutor() });

    await executor.executeStep(
      { id: "solo", name: "Solo", plugin: "p", config: {} },
      { workflowId: "wf-solo", stepId: "solo" },
    );

    assert.equal(events.length, 0);
  });
});
