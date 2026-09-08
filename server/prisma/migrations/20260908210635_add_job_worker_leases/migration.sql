-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "lease_expires_at" TIMESTAMP(3),
ADD COLUMN     "locked_by" TEXT;

-- CreateIndex
CREATE INDEX "jobs_status_lease_expires_at_idx" ON "jobs"("status", "lease_expires_at");
