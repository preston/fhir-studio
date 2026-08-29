-- CreateTable
CREATE TABLE "implementation_guides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "package_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fhir_version" TEXT NOT NULL DEFAULT '4.0.1',
    "category" TEXT NOT NULL DEFAULT 'US_CORE',
    "canonical_url" TEXT,
    "url" TEXT,
    "recommended_for_creation" BOOLEAN NOT NULL DEFAULT false,
    "is_suggested" BOOLEAN NOT NULL DEFAULT true,
    "author" TEXT,
    "dependencies" JSONB NOT NULL DEFAULT '{}',
    "tarball_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "implementation_guides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "implementation_guides_package_id_idx" ON "implementation_guides"("package_id");

-- CreateIndex
CREATE INDEX "implementation_guides_category_idx" ON "implementation_guides"("category");

-- CreateIndex
CREATE INDEX "implementation_guides_fhir_version_idx" ON "implementation_guides"("fhir_version");

-- CreateIndex
CREATE INDEX "implementation_guides_recommended_for_creation_idx" ON "implementation_guides"("recommended_for_creation");

-- CreateIndex
CREATE INDEX "implementation_guides_is_suggested_idx" ON "implementation_guides"("is_suggested");

-- CreateIndex
CREATE UNIQUE INDEX "implementation_guides_package_id_version_key" ON "implementation_guides"("package_id", "version");
