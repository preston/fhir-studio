-- CreateEnum
CREATE TYPE "AppointmentEntityType" AS ENUM ('User', 'Group');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sso_issuer" TEXT NOT NULL,
    "sso_subject" TEXT NOT NULL,
    "email" TEXT,
    "display_name" TEXT,
    "is_suspended" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "idle_expires_at" TIMESTAMP(3) NOT NULL,
    "encrypted_token_bundle" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "sso_roles" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sso_role_mapping" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "default" BOOLEAN NOT NULL DEFAULT false,
    "sso_role_mapping" TEXT,
    "permission_sandboxes_create" BOOLEAN NOT NULL DEFAULT true,
    "permission_sandboxes_shared" BOOLEAN NOT NULL DEFAULT false,
    "permission_ehr_simulator" BOOLEAN NOT NULL DEFAULT true,
    "permission_data_manager" BOOLEAN NOT NULL DEFAULT true,
    "permission_apps_register" BOOLEAN NOT NULL DEFAULT true,
    "permission_package_import" BOOLEAN NOT NULL DEFAULT true,
    "permission_global_manage" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" "AppointmentEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandboxes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sandbox_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fhir_version" TEXT NOT NULL DEFAULT 'R4',
    "partition_id" INTEGER NOT NULL,
    "allow_open_access" BOOLEAN NOT NULL DEFAULT false,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_collaborators" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sandbox_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'READ_WRITE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandbox_collaborators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sandbox_id" UUID,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "client_name" TEXT NOT NULL,
    "client_uri" TEXT,
    "logo_uri" TEXT,
    "launch_uri" TEXT NOT NULL,
    "redirect_uris" JSONB NOT NULL DEFAULT '[]',
    "scope" TEXT NOT NULL DEFAULT 'openid profile email patient/*.rs user/*.cruds launch launch/patient',
    "is_custom" BOOLEAN NOT NULL DEFAULT true,
    "is_sample" BOOLEAN NOT NULL DEFAULT false,
    "brief_description" TEXT,
    "author" TEXT,
    "sample_patients" TEXT,
    "manifest_url" TEXT,
    "token_endpoint_auth_method" TEXT NOT NULL DEFAULT 'client_secret_basic',
    "jwks_uri" TEXT,
    "jwks" JSONB,
    "pkce_required" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launch_scenarios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sandbox_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "app_id" UUID,
    "user_persona_id" UUID,
    "patient_fhir_id" TEXT,
    "patient_name" TEXT,
    "encounter_fhir_id" TEXT,
    "location_fhir_id" TEXT,
    "intent" TEXT,
    "smart_style_url" TEXT,
    "need_patient_banner" BOOLEAN NOT NULL DEFAULT true,
    "fhir_context" JSONB NOT NULL DEFAULT '[]',
    "context_params" JSONB NOT NULL DEFAULT '{}',
    "last_launch_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "launch_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_personas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sandbox_id" UUID NOT NULL,
    "persona_user_id" TEXT NOT NULL,
    "persona_name" TEXT NOT NULL,
    "fhir_resource_type" TEXT NOT NULL DEFAULT 'Practitioner',
    "fhir_resource_id" TEXT NOT NULL,
    "fhir_resource_name" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_personas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cds_service_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sandbox_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "services_json" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cds_service_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_auth_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sandbox_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "code" TEXT,
    "code_challenge" TEXT,
    "code_challenge_method" TEXT,
    "redirect_uri" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "launch_id" TEXT,
    "patient_fhir_id" TEXT,
    "encounter_fhir_id" TEXT,
    "user_persona_id" TEXT,
    "fhir_version" TEXT NOT NULL DEFAULT 'R4',
    "fhir_user" TEXT,
    "fhir_context" JSONB,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "token_type" TEXT NOT NULL DEFAULT 'Bearer',
    "token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "code_expires_at" TIMESTAMP(3),
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_export_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sandbox_id" UUID NOT NULL,
    "export_type" TEXT NOT NULL DEFAULT 'system',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "request_url" TEXT NOT NULL,
    "output_files" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "transaction_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "sandbox_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_is_suspended_idx" ON "users"("is_suspended");

-- CreateIndex
CREATE UNIQUE INDEX "users_sso_issuer_sso_subject_key" ON "users"("sso_issuer", "sso_subject");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "sessions_idle_expires_at_idx" ON "sessions"("idle_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "groups_name_key" ON "groups"("name");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "roles_default_idx" ON "roles"("default");

-- CreateIndex
CREATE INDEX "members_group_id_idx" ON "members"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "members_user_id_group_id_key" ON "members"("user_id", "group_id");

-- CreateIndex
CREATE INDEX "appointments_entity_id_idx" ON "appointments"("entity_id");

-- CreateIndex
CREATE INDEX "appointments_role_id_idx" ON "appointments"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_entity_type_entity_id_role_id_key" ON "appointments"("entity_type", "entity_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "sandboxes_sandbox_id_key" ON "sandboxes"("sandbox_id");

-- CreateIndex
CREATE INDEX "sandboxes_created_by_user_id_idx" ON "sandboxes"("created_by_user_id");

-- CreateIndex
CREATE INDEX "sandboxes_fhir_version_idx" ON "sandboxes"("fhir_version");

-- CreateIndex
CREATE INDEX "sandboxes_partition_id_idx" ON "sandboxes"("partition_id");

-- CreateIndex
CREATE INDEX "sandbox_collaborators_user_id_idx" ON "sandbox_collaborators"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_collaborators_sandbox_id_user_id_key" ON "sandbox_collaborators"("sandbox_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "applications_client_id_key" ON "applications"("client_id");

-- CreateIndex
CREATE INDEX "applications_sandbox_id_idx" ON "applications"("sandbox_id");

-- CreateIndex
CREATE INDEX "launch_scenarios_sandbox_id_idx" ON "launch_scenarios"("sandbox_id");

-- CreateIndex
CREATE INDEX "user_personas_sandbox_id_idx" ON "user_personas"("sandbox_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_personas_sandbox_id_persona_user_id_key" ON "user_personas"("sandbox_id", "persona_user_id");

-- CreateIndex
CREATE INDEX "cds_service_endpoints_sandbox_id_idx" ON "cds_service_endpoints"("sandbox_id");

-- CreateIndex
CREATE UNIQUE INDEX "smart_auth_sessions_code_key" ON "smart_auth_sessions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "smart_auth_sessions_access_token_key" ON "smart_auth_sessions"("access_token");

-- CreateIndex
CREATE UNIQUE INDEX "smart_auth_sessions_refresh_token_key" ON "smart_auth_sessions"("refresh_token");

-- CreateIndex
CREATE INDEX "smart_auth_sessions_launch_id_idx" ON "smart_auth_sessions"("launch_id");

-- CreateIndex
CREATE INDEX "smart_auth_sessions_access_token_idx" ON "smart_auth_sessions"("access_token");

-- CreateIndex
CREATE INDEX "smart_auth_sessions_refresh_token_idx" ON "smart_auth_sessions"("refresh_token");

-- CreateIndex
CREATE INDEX "bulk_export_jobs_sandbox_id_idx" ON "bulk_export_jobs"("sandbox_id");

-- CreateIndex
CREATE INDEX "bulk_export_jobs_status_idx" ON "bulk_export_jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_job_type_idx" ON "jobs"("job_type");

-- CreateIndex
CREATE INDEX "jobs_sandbox_id_idx" ON "jobs"("sandbox_id");

-- CreateIndex
CREATE INDEX "jobs_created_by_user_id_idx" ON "jobs"("created_by_user_id");

-- CreateIndex
CREATE INDEX "jobs_created_at_idx" ON "jobs"("created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_collaborators" ADD CONSTRAINT "sandbox_collaborators_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_collaborators" ADD CONSTRAINT "sandbox_collaborators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_scenarios" ADD CONSTRAINT "launch_scenarios_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_scenarios" ADD CONSTRAINT "launch_scenarios_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_scenarios" ADD CONSTRAINT "launch_scenarios_user_persona_id_fkey" FOREIGN KEY ("user_persona_id") REFERENCES "user_personas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_scenarios" ADD CONSTRAINT "launch_scenarios_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_personas" ADD CONSTRAINT "user_personas_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_personas" ADD CONSTRAINT "user_personas_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cds_service_endpoints" ADD CONSTRAINT "cds_service_endpoints_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_export_jobs" ADD CONSTRAINT "bulk_export_jobs_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
