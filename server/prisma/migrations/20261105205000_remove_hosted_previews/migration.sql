-- AlterTable
ALTER TABLE "hosted_applications" DROP COLUMN "auto_publish",
DROP COLUMN "preview_build_id",
DROP COLUMN "publishing_paused";

-- DropTable
DROP TABLE "integration_reviews";
