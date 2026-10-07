-- AlterTable
ALTER TABLE "api_tokens" ADD COLUMN "name" TEXT;
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" TIMESTAMP(3);

-- Backfill required name for any existing rows
UPDATE "api_tokens" SET "name" = 'Token ' || "prefix" WHERE "name" IS NULL;

ALTER TABLE "api_tokens" ALTER COLUMN "name" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_user_id_name_key" ON "api_tokens"("user_id", "name");
