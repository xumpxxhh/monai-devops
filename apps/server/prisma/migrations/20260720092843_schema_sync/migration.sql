-- Historical sync against legacy DBs that already had tables + GIN indexes.
-- Shadow / fresh installs: tables do not exist yet (init runs later by timestamp) → no-op.
DO $$
BEGIN
  IF to_regclass('public.run_events') IS NULL OR to_regclass('public.runs') IS NULL OR to_regclass('public.workflows') IS NULL THEN
    RAISE NOTICE 'schema_sync: tables missing, skip (fresh/shadow apply order)';
    RETURN;
  END IF;

  DROP INDEX IF EXISTS "run_events_payload_gin";
  DROP INDEX IF EXISTS "runs_metadata_gin";

  ALTER TABLE "run_events" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

  ALTER TABLE "runs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
    ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
    ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMP(3),
    ALTER COLUMN "finished_at" SET DATA TYPE TIMESTAMP(3);

  ALTER TABLE "workflows" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
    ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);
END $$;
