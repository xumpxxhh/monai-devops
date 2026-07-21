-- Restore GIN indexes dropped by schema_sync (Prisma cannot express GIN in schema.prisma)
CREATE INDEX IF NOT EXISTS runs_metadata_gin ON runs USING GIN (metadata);
CREATE INDEX IF NOT EXISTS run_events_payload_gin ON run_events USING GIN (payload);
