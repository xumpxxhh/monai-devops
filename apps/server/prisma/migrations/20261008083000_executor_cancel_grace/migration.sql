ALTER TABLE "execution_attempts" ADD COLUMN "cancel_grace_until" TIMESTAMP(3);
CREATE INDEX "execution_attempts_cancel_grace_until_idx" ON "execution_attempts"("cancel_grace_until");
