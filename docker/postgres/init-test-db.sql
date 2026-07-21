-- Creates the dedicated test database on first volume init.
-- Existing volumes: run manually:
--   docker compose exec postgres psql -U monai -c "CREATE DATABASE monai_devops_test;"
SELECT 'CREATE DATABASE monai_devops_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'monai_devops_test')\gexec
