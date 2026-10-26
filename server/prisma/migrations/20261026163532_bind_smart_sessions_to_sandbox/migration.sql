-- AlterTable
ALTER TABLE "smart_auth_sessions" ADD COLUMN     "sandbox_row_id" UUID;

-- CreateIndex
CREATE INDEX "smart_auth_sessions_sandbox_row_id_idx" ON "smart_auth_sessions"("sandbox_row_id");

-- AddForeignKey
ALTER TABLE "smart_auth_sessions" ADD CONSTRAINT "smart_auth_sessions_sandbox_row_id_fkey" FOREIGN KEY ("sandbox_row_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
