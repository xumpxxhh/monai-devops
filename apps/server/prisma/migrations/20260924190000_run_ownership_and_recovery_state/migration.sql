ALTER TABLE "runs"
  ADD COLUMN "recovery_state" JSONB,
  ADD COLUMN "lease_owner" TEXT,
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "lease_heartbeat_at" TIMESTAMP(3);

CREATE INDEX "runs_is_active_lease_expires_at_idx" ON "runs"("is_active", "lease_expires_at");
