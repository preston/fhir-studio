-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "hosted_application_id" UUID,
ADD COLUMN     "hosted_channel" TEXT;

-- CreateTable
CREATE TABLE "github_connections" (
    "user_id" UUID NOT NULL,
    "github_user_id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "encrypted_tokens" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "refresh_expires_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_connections_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "hosted_applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "owner_user_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "repository_id" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "project_directory" TEXT NOT NULL DEFAULT '',
    "build_command" TEXT NOT NULL DEFAULT 'npm ci && npm run build',
    "output_directory" TEXT NOT NULL DEFAULT 'dist',
    "node_version" TEXT NOT NULL DEFAULT '26',
    "launch_path" TEXT NOT NULL DEFAULT 'index.html',
    "callback_path" TEXT NOT NULL DEFAULT 'index.html',
    "scope" TEXT NOT NULL DEFAULT 'launch launch/patient openid fhirUser patient/*.rs',
    "auto_publish" BOOLEAN NOT NULL DEFAULT false,
    "publishing_paused" BOOLEAN NOT NULL DEFAULT false,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "generation" INTEGER NOT NULL DEFAULT 0,
    "policy_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preview_build_id" UUID,
    "published_build_id" UUID,
    "desired_build_id" UUID,
    "is_template" BOOLEAN NOT NULL DEFAULT false,
    "template_visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "template_commit" TEXT,
    "originating_commit" TEXT,
    "transfer_to_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_collaborators" (
    "application_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "hosted_collaborators_pkey" PRIMARY KEY ("application_id","user_id")
);

-- CreateTable
CREATE TABLE "hosted_builds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "requested_by_user_id" UUID,
    "github_actor" TEXT,
    "branch" TEXT NOT NULL,
    "commit" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "run_id" TEXT,
    "request_event" TEXT,
    "run_attempt" INTEGER NOT NULL DEFAULT 1,
    "artifact_id" TEXT,
    "launch_path" TEXT NOT NULL DEFAULT 'index.html',
    "callback_path" TEXT NOT NULL DEFAULT 'index.html',
    "scope" TEXT NOT NULL DEFAULT 'launch launch/patient openid fhirUser patient/*.rs',
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "error" TEXT,
    "github_url" TEXT,
    "directory" TEXT,
    "byte_size" BIGINT NOT NULL DEFAULT 0,
    "job_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_builds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_sandboxes" (
    "application_id" UUID NOT NULL,
    "sandbox_id" UUID NOT NULL,

    CONSTRAINT "hosted_sandboxes_pkey" PRIMARY KEY ("application_id","sandbox_id")
);

-- CreateTable
CREATE TABLE "hosted_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_client_assertions" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_client_assertions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_connections_github_user_id_key" ON "github_connections"("github_user_id");

-- CreateIndex
CREATE INDEX "hosted_applications_owner_user_id_idx" ON "hosted_applications"("owner_user_id");

-- CreateIndex
CREATE INDEX "hosted_applications_repository_id_idx" ON "hosted_applications"("repository_id");

-- CreateIndex
CREATE INDEX "hosted_builds_application_id_created_at_idx" ON "hosted_builds"("application_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_builds_application_id_run_id_run_attempt_key" ON "hosted_builds"("application_id", "run_id", "run_attempt");

-- CreateIndex
CREATE INDEX "hosted_audit_application_id_created_at_idx" ON "hosted_audit"("application_id", "created_at");

-- CreateIndex
CREATE INDEX "smart_client_assertions_expires_at_idx" ON "smart_client_assertions"("expires_at");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_hosted_application_id_fkey" FOREIGN KEY ("hosted_application_id") REFERENCES "hosted_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_applications" ADD CONSTRAINT "hosted_applications_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_collaborators" ADD CONSTRAINT "hosted_collaborators_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "hosted_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_collaborators" ADD CONSTRAINT "hosted_collaborators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_builds" ADD CONSTRAINT "hosted_builds_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "hosted_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_sandboxes" ADD CONSTRAINT "hosted_sandboxes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "hosted_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_sandboxes" ADD CONSTRAINT "hosted_sandboxes_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
