-- AlterTable
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "parent_run_id" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "runs_parent_run_id_idx" ON "runs"("parent_run_id");

-- AlterTable
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "owner_workflow_id" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workflows_owner_workflow_id_idx" ON "workflows"("owner_workflow_id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflows_owner_workflow_id_fkey'
  ) THEN
    ALTER TABLE "workflows"
      ADD CONSTRAINT "workflows_owner_workflow_id_fkey"
      FOREIGN KEY ("owner_workflow_id") REFERENCES "workflows"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "workflow_imports" (
    "id" TEXT NOT NULL,
    "parent_workflow_id" TEXT NOT NULL,
    "child_workflow_id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL DEFAULT '',
    "mode" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workflow_imports_parent_workflow_id_idx" ON "workflow_imports"("parent_workflow_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workflow_imports_child_workflow_id_idx" ON "workflow_imports"("child_workflow_id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflow_imports_parent_workflow_id_fkey'
  ) THEN
    ALTER TABLE "workflow_imports"
      ADD CONSTRAINT "workflow_imports_parent_workflow_id_fkey"
      FOREIGN KEY ("parent_workflow_id") REFERENCES "workflows"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflow_imports_child_workflow_id_fkey'
  ) THEN
    ALTER TABLE "workflow_imports"
      ADD CONSTRAINT "workflow_imports_child_workflow_id_fkey"
      FOREIGN KEY ("child_workflow_id") REFERENCES "workflows"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
