import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createResourceManager } from "../resource/index.js";

describe("resource manager", () => {
  it("allocates and releases resources", () => {
    const rm = createResourceManager({ autoCleanup: false });
    rm.registerResource({
      id: "r1",
      type: "runner",
      name: "runner-1",
      status: "available",
    });

    const allocated = rm.allocateResource("runner");
    assert.ok(allocated);
    assert.equal(allocated?.status, "allocated");

    assert.equal(rm.releaseResource("r1"), true);
    assert.equal(rm.getResource("r1")?.status, "released");
    rm.destroy();
  });

  it("starts auto cleanup when autoCleanup is true", () => {
    const rm = createResourceManager({
      autoCleanup: true,
      cleanupInterval: 20,
    });
    rm.registerResource({
      id: "r2",
      type: "gpu",
      name: "gpu-1",
      status: "available",
    });
    const allocated = rm.allocateResource("gpu");
    assert.ok(allocated);
    rm.releaseResource("r2");
    rm.destroy();
  });

  it("returns null when pool is exhausted", () => {
    const rm = createResourceManager({ maxResources: 1, autoCleanup: false });
    rm.registerResource({
      id: "only",
      type: "slot",
      name: "s1",
      status: "available",
    });
    rm.allocateResource("slot");
    assert.equal(rm.allocateResource("slot"), null);
    rm.destroy();
  });
});
