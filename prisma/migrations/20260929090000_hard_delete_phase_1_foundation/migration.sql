CREATE TYPE "HardDeleteTargetType" AS ENUM (
  'USER',
  'PRODUCT',
  'FACTORY',
  'CATEGORY',
  'MATERIAL',
  'ASSIGNMENT',
  'QUOTE',
  'PRODUCT_MAIN_IMAGE',
  'FACTORY_PRIVATE_IMAGE',
  'IMPORT_JOB'
);

CREATE TYPE "HardDeleteOperationStatus" AS ENUM (
  'PREVIEWED',
  'CONFIRMED',
  'EXECUTING',
  'FILES_PENDING',
  'COMPLETED',
  'FAILED'
);

CREATE TYPE "HardDeleteFileTaskStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'RETRYABLE',
  'DELETED',
  'FAILED'
);

ALTER TABLE "ImportRow" ADD COLUMN "resolvedProductId" UUID;

ALTER TABLE "PriceHistory" ALTER COLUMN "changedByUserId" DROP NOT NULL;
ALTER TABLE "StoredObject" ALTER COLUMN "createdByUserId" DROP NOT NULL;
ALTER TABLE "ProductMainImage" ALTER COLUMN "createdByUserId" DROP NOT NULL;
ALTER TABLE "FactoryPrivateImage" ALTER COLUMN "uploadedByUserId" DROP NOT NULL;
ALTER TABLE "ImportJob" ALTER COLUMN "createdByUserId" DROP NOT NULL;

ALTER TABLE "PriceHistory" DROP CONSTRAINT "PriceHistory_changedByUserId_fkey";
ALTER TABLE "ActivityLog" DROP CONSTRAINT "ActivityLog_actorUserId_fkey";
ALTER TABLE "StoredObject" DROP CONSTRAINT "StoredObject_createdByUserId_fkey";
ALTER TABLE "ProductMainImage" DROP CONSTRAINT "ProductMainImage_createdByUserId_fkey";
ALTER TABLE "FactoryPrivateImage" DROP CONSTRAINT "FactoryPrivateImage_uploadedByUserId_fkey";
ALTER TABLE "ImportJob" DROP CONSTRAINT "ImportJob_createdByUserId_fkey";

ALTER TABLE "PriceHistory"
  ADD CONSTRAINT "PriceHistory_changedByUserId_fkey"
  FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityLog"
  ADD CONSTRAINT "ActivityLog_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StoredObject"
  ADD CONSTRAINT "StoredObject_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductMainImage"
  ADD CONSTRAINT "ProductMainImage_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FactoryPrivateImage"
  ADD CONSTRAINT "FactoryPrivateImage_uploadedByUserId_fkey"
  FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportJob"
  ADD CONSTRAINT "ImportJob_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ActivityLog" DROP CONSTRAINT "ActivityLog_actor_check";
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actor_check" CHECK (
  ("actorSource" = 'USER' AND "actorRole" IN ('ADMIN', 'FACTORY'))
  OR
  ("actorSource" = 'SYSTEM' AND "actorUserId" IS NULL AND "actorRole" = 'SYSTEM')
);

CREATE INDEX "ImportRow_resolvedProductId_idx" ON "ImportRow"("resolvedProductId");
ALTER TABLE "ImportRow"
  ADD CONSTRAINT "ImportRow_resolvedProductId_fkey"
  FOREIGN KEY ("resolvedProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "HardDeleteOperation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "targetType" "HardDeleteTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetLabelSnapshot" TEXT NOT NULL,
  "status" "HardDeleteOperationStatus" NOT NULL DEFAULT 'PREVIEWED',
  "preview" JSONB NOT NULL,
  "previewSha256" TEXT NOT NULL,
  "requestedByUserId" TEXT,
  "requestedByUsernameSnapshot" TEXT NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedByUserId" TEXT,
  "confirmedByUsernameSnapshot" TEXT,
  "confirmedAt" TIMESTAMPTZ(3),
  "startedAt" TIMESTAMPTZ(3),
  "databaseCommittedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "failedAt" TIMESTAMPTZ(3),
  "failureCode" TEXT,
  "lastError" TEXT,

  CONSTRAINT "HardDeleteOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HardDeleteOperation_targetId_check" CHECK (
    char_length("targetId") BETWEEN 1 AND 255
    AND (
      "targetType" = 'USER'
      OR "targetId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  ),
  CONSTRAINT "HardDeleteOperation_targetLabel_check" CHECK (char_length("targetLabelSnapshot") BETWEEN 1 AND 500),
  CONSTRAINT "HardDeleteOperation_preview_check" CHECK (jsonb_typeof("preview") = 'object'),
  CONSTRAINT "HardDeleteOperation_previewSha256_check" CHECK ("previewSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "HardDeleteOperation_requesterSnapshot_check" CHECK (char_length("requestedByUsernameSnapshot") BETWEEN 1 AND 100),
  CONSTRAINT "HardDeleteOperation_confirmerSnapshot_check" CHECK (
    "confirmedByUsernameSnapshot" IS NULL
    OR char_length("confirmedByUsernameSnapshot") BETWEEN 1 AND 100
  ),
  CONSTRAINT "HardDeleteOperation_failure_check" CHECK (
    ("status" = 'FAILED' AND "failedAt" IS NOT NULL AND char_length("failureCode") BETWEEN 1 AND 100 AND char_length("lastError") BETWEEN 1 AND 2000)
    OR
    ("status" <> 'FAILED' AND "failedAt" IS NULL AND "failureCode" IS NULL AND "lastError" IS NULL)
  ),
  CONSTRAINT "HardDeleteOperation_status_time_check" CHECK (
    ("status" = 'PREVIEWED' AND "confirmedAt" IS NULL AND "startedAt" IS NULL AND "databaseCommittedAt" IS NULL AND "completedAt" IS NULL)
    OR
    ("status" = 'CONFIRMED' AND "confirmedAt" IS NOT NULL AND "confirmedByUserId" IS NOT NULL AND "confirmedByUsernameSnapshot" IS NOT NULL AND "startedAt" IS NULL AND "databaseCommittedAt" IS NULL AND "completedAt" IS NULL)
    OR
    ("status" = 'EXECUTING' AND "confirmedAt" IS NOT NULL AND "confirmedByUsernameSnapshot" IS NOT NULL AND "startedAt" IS NOT NULL AND "databaseCommittedAt" IS NULL AND "completedAt" IS NULL)
    OR
    ("status" = 'FILES_PENDING' AND "confirmedAt" IS NOT NULL AND "confirmedByUsernameSnapshot" IS NOT NULL AND "startedAt" IS NOT NULL AND "databaseCommittedAt" IS NOT NULL AND "completedAt" IS NULL)
    OR
    ("status" = 'COMPLETED' AND "confirmedAt" IS NOT NULL AND "confirmedByUsernameSnapshot" IS NOT NULL AND "startedAt" IS NOT NULL AND "databaseCommittedAt" IS NOT NULL AND "completedAt" IS NOT NULL)
    OR
    ("status" = 'FAILED' AND "confirmedAt" IS NOT NULL AND "confirmedByUsernameSnapshot" IS NOT NULL AND "startedAt" IS NOT NULL AND "completedAt" IS NULL)
  )
);

CREATE TABLE "HardDeleteFileTask" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operationId" UUID NOT NULL,
  "storedObjectId" UUID,
  "storageProvider" "StorageProvider" NOT NULL,
  "storageKey" TEXT NOT NULL,
  "checksumSha256" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "status" "HardDeleteFileTaskStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAt" TIMESTAMPTZ(3),

  CONSTRAINT "HardDeleteFileTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HardDeleteFileTask_storageKey_check" CHECK ("storageKey" ~ '^objects/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'),
  CONSTRAINT "HardDeleteFileTask_checksum_check" CHECK ("checksumSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "HardDeleteFileTask_size_check" CHECK ("sizeBytes" > 0),
  CONSTRAINT "HardDeleteFileTask_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "HardDeleteFileTask_lastError_check" CHECK ("lastError" IS NULL OR char_length("lastError") BETWEEN 1 AND 2000),
  CONSTRAINT "HardDeleteFileTask_status_check" CHECK (
    ("status" IN ('PENDING', 'PROCESSING') AND "deletedAt" IS NULL AND "nextAttemptAt" IS NULL)
    OR ("status" = 'RETRYABLE' AND "deletedAt" IS NULL AND "nextAttemptAt" IS NOT NULL AND "lastError" IS NOT NULL)
    OR ("status" = 'DELETED' AND "deletedAt" IS NOT NULL AND "nextAttemptAt" IS NULL AND "lastError" IS NULL)
    OR ("status" = 'FAILED' AND "deletedAt" IS NULL AND "nextAttemptAt" IS NULL AND "lastError" IS NOT NULL)
  )
);

CREATE INDEX "HardDeleteOperation_targetType_targetId_requestedAt_idx"
  ON "HardDeleteOperation"("targetType", "targetId", "requestedAt" DESC);
CREATE INDEX "HardDeleteOperation_status_requestedAt_idx"
  ON "HardDeleteOperation"("status", "requestedAt");
CREATE INDEX "HardDeleteOperation_requestedByUserId_requestedAt_idx"
  ON "HardDeleteOperation"("requestedByUserId", "requestedAt" DESC);
CREATE INDEX "HardDeleteOperation_confirmedByUserId_confirmedAt_idx"
  ON "HardDeleteOperation"("confirmedByUserId", "confirmedAt" DESC);
CREATE UNIQUE INDEX "HardDeleteOperation_active_target_key"
  ON "HardDeleteOperation"("targetType", "targetId")
  WHERE "status" IN ('PREVIEWED', 'CONFIRMED', 'EXECUTING', 'FILES_PENDING');

CREATE UNIQUE INDEX "HardDeleteFileTask_operationId_storageKey_key"
  ON "HardDeleteFileTask"("operationId", "storageKey");
CREATE INDEX "HardDeleteFileTask_status_nextAttemptAt_createdAt_idx"
  ON "HardDeleteFileTask"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "HardDeleteFileTask_storedObjectId_idx"
  ON "HardDeleteFileTask"("storedObjectId");

ALTER TABLE "HardDeleteOperation"
  ADD CONSTRAINT "HardDeleteOperation_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HardDeleteOperation"
  ADD CONSTRAINT "HardDeleteOperation_confirmedByUserId_fkey"
  FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HardDeleteFileTask"
  ADD CONSTRAINT "HardDeleteFileTask_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "HardDeleteOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HardDeleteFileTask"
  ADD CONSTRAINT "HardDeleteFileTask_storedObjectId_fkey"
  FOREIGN KEY ("storedObjectId") REFERENCES "StoredObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION public.execute_confirmed_user_hard_delete(p_operation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  operation_row public."HardDeleteOperation"%ROWTYPE;
  target_user public."User"%ROWTYPE;
  requester public."User"%ROWTYPE;
  confirmer public."User"%ROWTYPE;
  completed_at TIMESTAMPTZ(3) := pg_catalog.clock_timestamp();
BEGIN
  SELECT * INTO operation_row
  FROM public."HardDeleteOperation"
  WHERE "id" = p_operation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'hard delete operation not found' USING ERRCODE = 'P0002';
  END IF;
  IF operation_row."status" <> 'CONFIRMED' OR operation_row."targetType" <> 'USER' THEN
    RAISE EXCEPTION 'operation is not a confirmed user hard delete' USING ERRCODE = '22023';
  END IF;
  IF operation_row."requestedByUserId" IS NULL OR operation_row."confirmedByUserId" IS NULL THEN
    RAISE EXCEPTION 'operation admin provenance is unavailable' USING ERRCODE = '22023';
  END IF;
  IF operation_row."targetId" = operation_row."requestedByUserId"
     OR operation_row."targetId" = operation_row."confirmedByUserId" THEN
    RAISE EXCEPTION 'current admin cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."HardDeleteFileTask"
    WHERE "operationId" = p_operation_id
  ) THEN
    RAISE EXCEPTION 'user hard delete cannot contain file tasks' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO requester
  FROM public."User"
  WHERE "id" = operation_row."requestedByUserId"
  FOR KEY SHARE;
  SELECT * INTO confirmer
  FROM public."User"
  WHERE "id" = operation_row."confirmedByUserId"
  FOR KEY SHARE;
  IF requester."id" IS NULL OR requester."role" <> 'ADMIN' OR requester."banned" IS TRUE
     OR confirmer."id" IS NULL OR confirmer."role" <> 'ADMIN' OR confirmer."banned" IS TRUE THEN
    RAISE EXCEPTION 'operation must be requested and confirmed by enabled admins' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO target_user
  FROM public."User"
  WHERE "id" = operation_row."targetId"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target user not found' USING ERRCODE = 'P0002';
  END IF;
  IF target_user."role" <> 'FACTORY' OR target_user."banned" IS NOT TRUE THEN
    RAISE EXCEPTION 'v1 only deletes disabled factory users' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public."ActivityLog"
  WHERE "entityType" = 'USER'
    AND "entityId" = target_user."id"
    AND "eventType" IN ('USER_CREATED', 'USER_ENABLED', 'USER_DISABLED');

  UPDATE public."ActivityLog"
  SET "actorUserId" = NULL,
      "actorUsernameSnapshot" = '已永久删除用户'
  WHERE "actorUserId" = target_user."id";

  DELETE FROM public."User" WHERE "id" = target_user."id";

  UPDATE public."HardDeleteOperation"
  SET "status" = 'COMPLETED',
      "targetLabelSnapshot" = '已永久删除用户',
      "startedAt" = completed_at,
      "databaseCommittedAt" = completed_at,
      "completedAt" = completed_at
  WHERE "id" = p_operation_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.execute_confirmed_user_hard_delete(UUID) FROM PUBLIC;
