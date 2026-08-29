-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "last_accessed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "sandboxes_last_accessed_at_idx" ON "sandboxes"("last_accessed_at");

-- CreateIndex
CREATE INDEX "sandboxes_created_at_idx" ON "sandboxes"("created_at");
