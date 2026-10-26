-- AlterTable
ALTER TABLE "hosted_applications" ADD COLUMN     "integration_grant_id" UUID,
ADD COLUMN     "public_configuration" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "runtime_contract" JSONB;
