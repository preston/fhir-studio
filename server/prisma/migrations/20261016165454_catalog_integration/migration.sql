-- AlterTable
ALTER TABLE "hosted_applications" ADD COLUMN     "integration_client_id" UUID,
ADD COLUMN     "integration_origin" JSONB,
ADD COLUMN     "source_kind" TEXT NOT NULL DEFAULT 'repository',
ALTER COLUMN "repository_id" SET DEFAULT '',
ALTER COLUMN "repository" SET DEFAULT '',
ALTER COLUMN "installation_id" SET DEFAULT '';

-- AlterTable
ALTER TABLE "hosted_builds" ADD COLUMN     "artifact_source" JSONB,
ADD COLUMN     "content_build_id" UUID,
ADD COLUMN     "integration_grant_id" UUID,
ADD COLUMN     "public_configuration" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "revision_digest" TEXT,
ADD COLUMN     "runtime_contract" JSONB;

-- CreateTable
CREATE TABLE "integration_clients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "redirect_uris" JSONB NOT NULL,
    "scopes" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_authorizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "code_hash" TEXT,
    "approved_at" TIMESTAMP(3),
    "used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "access_token_hash" TEXT NOT NULL,
    "access_expires_at" TIMESTAMP(3) NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "previous_refresh_token_hash" TEXT,
    "refresh_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "integration_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "application_id" UUID,
    "job_id" UUID,
    "request" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_reviews" (
    "application_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "build_id" UUID NOT NULL,
    "revision_digest" TEXT,
    "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_reviews_pkey" PRIMARY KEY ("application_id","user_id")
);

-- CreateTable
CREATE TABLE "integration_retired_tokens" (
    "hash" TEXT NOT NULL,
    "grant_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_retired_tokens_pkey" PRIMARY KEY ("hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_authorizations_code_hash_key" ON "integration_authorizations"("code_hash");

-- CreateIndex
CREATE INDEX "integration_authorizations_expires_at_idx" ON "integration_authorizations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_grants_access_token_hash_key" ON "integration_grants"("access_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "integration_grants_refresh_token_hash_key" ON "integration_grants"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "integration_grants_user_id_client_id_idx" ON "integration_grants"("user_id", "client_id");

-- CreateIndex
CREATE INDEX "integration_operations_application_id_idx" ON "integration_operations"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_operations_client_id_user_id_request_id_key" ON "integration_operations"("client_id", "user_id", "request_id");

-- CreateIndex
CREATE INDEX "integration_retired_tokens_expires_at_idx" ON "integration_retired_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "integration_authorizations" ADD CONSTRAINT "integration_authorizations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "integration_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_authorizations" ADD CONSTRAINT "integration_authorizations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_grants" ADD CONSTRAINT "integration_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "integration_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_grants" ADD CONSTRAINT "integration_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
