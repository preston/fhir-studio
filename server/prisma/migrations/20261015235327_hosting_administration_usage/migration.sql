/*
  Warnings:

  - A unique constraint covering the columns `[scheduled_occurrence]` on the table `jobs` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "JobScheduleFrequency" AS ENUM ('EVERY_MINUTE', 'HOURLY', 'DAILY');

-- AlterTable
ALTER TABLE "hosted_applications" ADD COLUMN     "cleanup_protected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "delete_after" TIMESTAMP(3),
ADD COLUMN     "last_developer_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "last_launch_at" TIMESTAMP(3),
ADD COLUMN     "last_reconciled_at" TIMESTAMP(3),
ADD COLUMN     "last_served_at" TIMESTAMP(3),
ADD COLUMN     "reconciliation_error" TEXT,
ADD COLUMN     "suspended_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "schedule_id" UUID,
ADD COLUMN     "scheduled_occurrence" TEXT;

-- CreateTable
CREATE TABLE "hosted_usage_hours" (
    "application_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "hour" TIMESTAMPTZ(3) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "documents" INTEGER NOT NULL DEFAULT 0,
    "bots" INTEGER NOT NULL DEFAULT 0,
    "status_2xx" INTEGER NOT NULL DEFAULT 0,
    "status_3xx" INTEGER NOT NULL DEFAULT 0,
    "status_4xx" INTEGER NOT NULL DEFAULT 0,
    "status_5xx" INTEGER NOT NULL DEFAULT 0,
    "rate_limited" INTEGER NOT NULL DEFAULT 0,
    "aborted" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "duration_ms" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "histogram" JSONB NOT NULL DEFAULT '[]',
    "visitors" BYTEA NOT NULL,
    "launches" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "hosted_usage_hours_pkey" PRIMARY KEY ("application_id","channel","hour")
);

-- CreateTable
CREATE TABLE "hosted_usage_collectors" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "dropped" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_flushed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_usage_collectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_owner_quotas" (
    "user_id" UUID NOT NULL,
    "application_limit" INTEGER,
    "storage_bytes_limit" BIGINT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_owner_quotas_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "job_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_key" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "job_type" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "frequency" "JobScheduleFrequency" NOT NULL,
    "minute_of_hour" INTEGER NOT NULL DEFAULT 0,
    "hour_of_day" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMPTZ(3) NOT NULL,
    "last_run_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hosted_usage_hours_hour_idx" ON "hosted_usage_hours"("hour");

-- CreateIndex
CREATE INDEX "hosted_usage_collectors_kind_last_flushed_at_idx" ON "hosted_usage_collectors"("kind", "last_flushed_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_schedules_system_key_key" ON "job_schedules"("system_key");

-- CreateIndex
CREATE INDEX "job_schedules_enabled_next_run_at_idx" ON "job_schedules"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "hosted_applications_deleted_at_delete_after_idx" ON "hosted_applications"("deleted_at", "delete_after");

-- CreateIndex
CREATE INDEX "hosted_applications_last_reconciled_at_idx" ON "hosted_applications"("last_reconciled_at");

-- CreateIndex
CREATE INDEX "hosted_audit_created_at_idx" ON "hosted_audit"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_scheduled_occurrence_key" ON "jobs"("scheduled_occurrence");

-- CreateIndex
CREATE INDEX "jobs_schedule_id_status_idx" ON "jobs"("schedule_id", "status");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "job_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_owner_quotas" ADD CONSTRAINT "hosted_owner_quotas_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_schedules" ADD CONSTRAINT "job_schedules_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
