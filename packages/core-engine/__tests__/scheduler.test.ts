import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTaskScheduler } from "../scheduler";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scheduler", () => {
  it("scheduleTask returns result promise", async () => {
    const scheduler = createTaskScheduler({ maxConcurrency: 2 });
    const result = await scheduler.scheduleTask({
      id: "t1",
      name: "task1",
      priority: 1,
      createdAt: new Date(),
      execute: async () => "done",
    });
    assert.equal(result.success, true);
    assert.equal(result.result, "done");
  });

  it("retries on failure", async () => {
    let attempts = 0;
    const scheduler = createTaskScheduler({
      retryAttempts: 3,
      retryDelay: 10,
    });

    const result = await scheduler.scheduleTask({
      id: "t2",
      name: "retry",
      priority: 0,
      createdAt: new Date(),
      execute: async () => {
        attempts++;
        if (attempts < 2) throw new Error("fail");
        return "ok";
      },
    });

    assert.equal(result.success, true);
    assert.equal(attempts, 2);
  });

  it("respects maxConcurrency", async () => {
    const scheduler = createTaskScheduler({ maxConcurrency: 1 });
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () => ({
      id: `task-${Math.random()}`,
      name: "c",
      priority: 0,
      createdAt: new Date(),
      execute: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await delay(30);
        concurrent--;
        return true;
      },
    });

    await Promise.all([
      scheduler.scheduleTask(task()),
      scheduler.scheduleTask(task()),
    ]);

    assert.equal(maxConcurrent, 1);
  });

  it("executes lower priority number before higher number", async () => {
    const scheduler = createTaskScheduler({ maxConcurrency: 1 });
    const order: string[] = [];
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const runOrder = (id: string) => async () => {
      order.push(id);
      return id;
    };

    const holdTask = scheduler.scheduleTask({
      id: "hold",
      name: "hold",
      priority: 0,
      createdAt: new Date(),
      execute: async () => {
        await hold;
        return "hold";
      },
    });

    const queued = Promise.all([
      scheduler.scheduleTask({
        id: "low",
        name: "low",
        priority: 10,
        createdAt: new Date(),
        execute: runOrder("low"),
      }),
      scheduler.scheduleTask({
        id: "high",
        name: "high",
        priority: 1,
        createdAt: new Date(),
        execute: runOrder("high"),
      }),
      scheduler.scheduleTask({
        id: "mid",
        name: "mid",
        priority: 5,
        createdAt: new Date(),
        execute: runOrder("mid"),
      }),
    ]);

    await delay(5);
    releaseHold();
    await holdTask;
    await queued;

    assert.deepEqual(order, ["high", "mid", "low"]);
  });

  it("executes same priority tasks in FIFO by createdAt", async () => {
    const scheduler = createTaskScheduler({ maxConcurrency: 1 });
    const order: string[] = [];
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const base = new Date("2024-01-01T00:00:00.000Z");
    const runOrder = (id: string) => async () => {
      order.push(id);
      return id;
    };

    const holdTask = scheduler.scheduleTask({
      id: "hold",
      name: "hold",
      priority: 0,
      createdAt: new Date(base.getTime() - 1),
      execute: async () => {
        await hold;
      },
    });

    const queued = Promise.all([
      scheduler.scheduleTask({
        id: "first",
        name: "first",
        priority: 5,
        createdAt: new Date(base.getTime()),
        execute: runOrder("first"),
      }),
      scheduler.scheduleTask({
        id: "second",
        name: "second",
        priority: 5,
        createdAt: new Date(base.getTime() + 1),
        execute: runOrder("second"),
      }),
      scheduler.scheduleTask({
        id: "third",
        name: "third",
        priority: 5,
        createdAt: new Date(base.getTime() + 2),
        execute: runOrder("third"),
      }),
    ]);

    await delay(5);
    releaseHold();
    await holdTask;
    await queued;

    assert.deepEqual(order, ["first", "second", "third"]);
  });

  it("getQueueStatus reflects queue and running counts", async () => {
    const scheduler = createTaskScheduler({ maxConcurrency: 1 });
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const holdPromise = scheduler.scheduleTask({
      id: "hold",
      name: "hold",
      priority: 0,
      createdAt: new Date(),
      execute: async () => {
        await hold;
      },
    });

    await delay(5);
    const waiting = scheduler.scheduleTask({
      id: "wait",
      name: "wait",
      priority: 1,
      createdAt: new Date(),
      execute: async () => "ok",
    });

    await delay(5);
    const status = scheduler.getQueueStatus();
    assert.equal(status.runningTasks, 1);
    assert.equal(status.queueLength, 1);
    assert.equal(status.maxConcurrency, 1);

    releaseHold();
    await holdPromise;
    await waiting;
    // scheduleTask resolves before finally decrements runningTasks
    await delay(1);

    const idle = scheduler.getQueueStatus();
    assert.equal(idle.runningTasks, 0);
    assert.equal(idle.queueLength, 0);
  });
});
