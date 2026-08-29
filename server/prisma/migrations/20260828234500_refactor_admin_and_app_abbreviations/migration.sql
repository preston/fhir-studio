-- DropForeignKey
ALTER TABLE "launch_scenarios" DROP CONSTRAINT "launch_scenarios_app_id_fkey";

-- AlterTable
ALTER TABLE "launch_scenarios" DROP COLUMN "app_id",
ADD COLUMN     "application_id" UUID;

-- AlterTable
ALTER TABLE "roles" DROP COLUMN "permission_apps_register",
ADD COLUMN     "permission_applications_register" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "launch_scenarios" ADD CONSTRAINT "launch_scenarios_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
