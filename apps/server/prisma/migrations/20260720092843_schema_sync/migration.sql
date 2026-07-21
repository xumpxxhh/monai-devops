-- DropIndex
DROP INDEX "run_events_payload_gin";

-- DropIndex
DROP INDEX "runs_metadata_gin";

-- AlterTable
ALTER TABLE "run_events" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "runs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "finished_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "workflows" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);
