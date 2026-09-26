ALTER TABLE "execution_attempts"
  ADD COLUMN "message_sequence" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "execution_attempt_messages" (
  "attempt_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "event_type" TEXT,
  "payload_version" INTEGER,
  "payload" JSONB,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "execution_attempt_messages_pkey" PRIMARY KEY ("attempt_id", "sequence")
);

ALTER TABLE "execution_attempt_messages"
  ADD CONSTRAINT "execution_attempt_messages_attempt_id_fkey"
  FOREIGN KEY ("attempt_id") REFERENCES "execution_attempts"("attempt_id") ON DELETE CASCADE ON UPDATE CASCADE;
