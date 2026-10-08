CREATE TABLE "executor_objects" (
  "object_id" TEXT NOT NULL,
  "attempt_id" TEXT NOT NULL,
  "worker_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "content" BYTEA NOT NULL,
  "content_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "executor_objects_pkey" PRIMARY KEY ("object_id")
);

CREATE INDEX "executor_objects_expires_at_idx" ON "executor_objects"("expires_at");
CREATE INDEX "executor_objects_attempt_id_worker_id_idx" ON "executor_objects"("attempt_id", "worker_id");
ALTER TABLE "executor_objects" ADD CONSTRAINT "executor_objects_attempt_id_fkey"
  FOREIGN KEY ("attempt_id") REFERENCES "execution_attempts"("attempt_id") ON DELETE CASCADE ON UPDATE CASCADE;
