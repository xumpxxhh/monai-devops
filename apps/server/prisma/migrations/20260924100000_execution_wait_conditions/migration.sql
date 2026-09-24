ALTER TABLE "execution_attempts"
  ADD COLUMN "wait_kind" TEXT,
  ADD COLUMN "wake_key" TEXT,
  ADD COLUMN "wake_at" TIMESTAMP(3),
  ADD COLUMN "wait_timeout_at" TIMESTAMP(3),
  ADD COLUMN "wake_ready_at" TIMESTAMP(3),
  ADD COLUMN "wake_payload" JSONB;

CREATE INDEX "execution_attempts_status_wake_at_idx"
  ON "execution_attempts"("status", "wake_at");
CREATE INDEX "execution_attempts_status_wait_timeout_at_idx"
  ON "execution_attempts"("status", "wait_timeout_at");
CREATE INDEX "execution_attempts_wake_key_status_idx"
  ON "execution_attempts"("wake_key", "status");
