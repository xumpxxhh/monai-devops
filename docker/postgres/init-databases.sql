-- 团队公共 PostgreSQL 上为本项目建库（库名固定；幂等）。
-- 示例：psql "postgresql://USER:PASSWORD@HOST:5432/postgres" -f docker/postgres/init-databases.sql

SELECT 'CREATE DATABASE monai_devops'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'monai_devops')\gexec

SELECT 'CREATE DATABASE monai_devops_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'monai_devops_test')\gexec
