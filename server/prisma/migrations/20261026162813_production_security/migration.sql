-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "manual_grant" BOOLEAN,
ADD COLUMN     "sso_grant" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "members" ADD COLUMN     "manual_grant" BOOLEAN,
ADD COLUMN     "sso_grant" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "hapi_partition_allocations" (
    "id" TEXT NOT NULL,
    "last_allocated_id" INTEGER NOT NULL,

    CONSTRAINT "hapi_partition_allocations_pkey" PRIMARY KEY ("id")
);
