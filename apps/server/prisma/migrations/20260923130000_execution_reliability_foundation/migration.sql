CREATE TABLE "execution_jobs" (
  "job_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "step_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "idempotency_key" TEXT,
  "retry_policy" JSONB,
  "checkpoint" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "execution_jobs_pkey" PRIMARY KEY ("job_id")
);

CREATE TABLE "execution_attempts" (
  "attempt_id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "lease_owner" TEXT,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "heartbeat_at" TIMESTAMP(3),
  "reason" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "execution_attempts_pkey" PRIMARY KEY ("attempt_id")
);

CREATE UNIQUE INDEX "execution_jobs_run_id_step_id_key" ON "execution_jobs"("run_id", "step_id");
CREATE UNIQUE INDEX "execution_jobs_run_id_idempotency_key_key" ON "execution_jobs"("run_id", "idempotency_key");
CREATE INDEX "execution_jobs_run_id_status_idx" ON "execution_jobs"("run_id", "status");
CREATE UNIQUE INDEX "execution_attempts_job_id_attempt_key" ON "execution_attempts"("job_id", "attempt");
CREATE INDEX "execution_attempts_status_lease_expires_at_idx" ON "execution_attempts"("status", "lease_expires_at");

ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("run_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "execution_jobs"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;
