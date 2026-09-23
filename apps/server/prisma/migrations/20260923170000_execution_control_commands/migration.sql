CREATE TABLE "execution_control_commands" (
  "command_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "claimed_by" TEXT,
  "claimed_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "error" TEXT,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "execution_control_commands_pkey" PRIMARY KEY ("command_id")
);

CREATE INDEX "execution_control_commands_status_requested_at_idx"
  ON "execution_control_commands"("status", "requested_at");
CREATE INDEX "execution_control_commands_run_id_requested_at_idx"
  ON "execution_control_commands"("run_id", "requested_at");

ALTER TABLE "execution_control_commands"
  ADD CONSTRAINT "execution_control_commands_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("run_id") ON DELETE CASCADE ON UPDATE CASCADE;
