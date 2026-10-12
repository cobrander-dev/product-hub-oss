CREATE TYPE "ImportType" AS ENUM ('PRODUCT');
CREATE TYPE "ImportJobStatus" AS ENUM ('PREVIEW_READY', 'CONFIRMED');
CREATE TYPE "ImportRowAction" AS ENUM ('CREATE', 'UPDATE', 'NO_CHANGE', 'ERROR');

CREATE TABLE "ImportJob" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "type" "ImportType" NOT NULL DEFAULT 'PRODUCT',
  "status" "ImportJobStatus" NOT NULL DEFAULT 'PREVIEW_READY',
  "originalFilename" TEXT NOT NULL,
  "checksumSha256" TEXT NOT NULL,
  "totalRows" INTEGER NOT NULL,
  "createRows" INTEGER NOT NULL,
  "updateRows" INTEGER NOT NULL,
  "noChangeRows" INTEGER NOT NULL,
  "errorRows" INTEGER NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMPTZ(3),

  CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportJob_originalFilename_check" CHECK (char_length("originalFilename") BETWEEN 1 AND 255),
  CONSTRAINT "ImportJob_checksumSha256_check" CHECK ("checksumSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ImportJob_counts_check" CHECK (
    "totalRows" BETWEEN 1 AND 5000
    AND "createRows" >= 0
    AND "updateRows" >= 0
    AND "noChangeRows" >= 0
    AND "errorRows" >= 0
    AND "totalRows" = "createRows" + "updateRows" + "noChangeRows" + "errorRows"
  ),
  CONSTRAINT "ImportJob_status_time_check" CHECK (
    ("status" = 'PREVIEW_READY' AND "confirmedAt" IS NULL)
    OR ("status" = 'CONFIRMED' AND "confirmedAt" IS NOT NULL AND "errorRows" = 0)
  )
);

CREATE TABLE "ImportRow" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "jobId" UUID NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "action" "ImportRowAction" NOT NULL,
  "targetProductId" UUID,
  "normalizedData" JSONB,
  "changes" JSONB,
  "errors" JSONB NOT NULL,
  "targetUpdatedAtSnapshot" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportRow_rowNumber_check" CHECK ("rowNumber" >= 2),
  CONSTRAINT "ImportRow_errors_check" CHECK (jsonb_typeof("errors") = 'array'),
  CONSTRAINT "ImportRow_normalizedData_check" CHECK ("normalizedData" IS NULL OR jsonb_typeof("normalizedData") = 'object'),
  CONSTRAINT "ImportRow_changes_check" CHECK ("changes" IS NULL OR jsonb_typeof("changes") = 'object'),
  CONSTRAINT "ImportRow_action_shape_check" CHECK (
    ("action" = 'CREATE' AND "targetProductId" IS NULL AND "targetUpdatedAtSnapshot" IS NULL AND "normalizedData" IS NOT NULL AND jsonb_array_length("errors") = 0)
    OR ("action" IN ('UPDATE', 'NO_CHANGE') AND "targetProductId" IS NOT NULL AND "targetUpdatedAtSnapshot" IS NOT NULL AND "normalizedData" IS NOT NULL AND jsonb_array_length("errors") = 0)
    OR ("action" = 'ERROR' AND jsonb_array_length("errors") > 0)
  )
);

CREATE UNIQUE INDEX "ImportRow_jobId_rowNumber_key" ON "ImportRow"("jobId", "rowNumber");
CREATE INDEX "ImportJob_createdByUserId_createdAt_idx" ON "ImportJob"("createdByUserId", "createdAt" DESC);
CREATE INDEX "ImportJob_status_createdAt_idx" ON "ImportJob"("status", "createdAt" DESC);
CREATE INDEX "ImportRow_jobId_action_rowNumber_idx" ON "ImportRow"("jobId", "action", "rowNumber");
CREATE INDEX "ImportRow_targetProductId_idx" ON "ImportRow"("targetProductId");

ALTER TABLE "ImportJob"
  ADD CONSTRAINT "ImportJob_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ImportRow"
  ADD CONSTRAINT "ImportRow_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "ImportJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ImportRow"
  ADD CONSTRAINT "ImportRow_targetProductId_fkey"
  FOREIGN KEY ("targetProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
