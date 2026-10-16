-- CreateTable
CREATE TABLE "hosted_usage_policy" (
    "id" TEXT NOT NULL,
    "purged_before" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "hosted_usage_policy_pkey" PRIMARY KEY ("id")
);
