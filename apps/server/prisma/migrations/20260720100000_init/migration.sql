-- CreateTable
CREATE TABLE "runs" (
    "run_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "workflow_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "trace_id" TEXT,
    "workflow_snapshot" JSONB NOT NULL,
    "counts_total" INTEGER NOT NULL DEFAULT 0,
    "counts_completed" INTEGER NOT NULL DEFAULT 0,
    "counts_failed" INTEGER NOT NULL DEFAULT 0,
    "counts_skipped" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "cancelled" TEXT,
    "created_by" BIGINT,
    "source" TEXT DEFAULT 'api',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "run_events" (
    "id" BIGSERIAL NOT NULL,
    "run_id" TEXT NOT NULL,
    "event_index" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "runs_is_active_created_at_idx" ON "runs"("is_active", "created_at");

-- CreateIndex
CREATE INDEX "runs_workflow_id_idx" ON "runs"("workflow_id");

-- CreateIndex
CREATE INDEX "runs_workflow_name_idx" ON "runs"("workflow_name");

-- CreateIndex
CREATE UNIQUE INDEX "run_events_run_id_event_index_key" ON "run_events"("run_id", "event_index");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_name_key" ON "workflows"("name");

-- CreateIndex
CREATE INDEX "runs_metadata_gin" ON "runs" USING GIN ("metadata");

-- CreateIndex
CREATE INDEX "run_events_payload_gin" ON "run_events" USING GIN ("payload");

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("run_id") ON DELETE CASCADE ON UPDATE CASCADE;
