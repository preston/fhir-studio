/*
  Warnings:

  - You are about to drop the column `recommended_for_creation` on the `implementation_guides` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "implementation_guides_recommended_for_creation_idx";

-- AlterTable
ALTER TABLE "implementation_guides" DROP COLUMN "recommended_for_creation";
