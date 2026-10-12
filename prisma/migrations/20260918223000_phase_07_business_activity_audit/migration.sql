-- CreateEnum
CREATE TYPE "AuditActorSource" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM ('PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ENABLED', 'PRODUCT_DISABLED', 'CATEGORY_CREATED', 'CATEGORY_UPDATED', 'CATEGORY_ENABLED', 'CATEGORY_DISABLED', 'MATERIAL_CREATED', 'MATERIAL_UPDATED', 'MATERIAL_ENABLED', 'MATERIAL_DISABLED', 'FACTORY_CREATED', 'FACTORY_UPDATED', 'FACTORY_ENABLED', 'FACTORY_DISABLED', 'ASSIGNMENT_ASSIGNED', 'ASSIGNMENT_REVOKED', 'ASSIGNMENT_REACTIVATED', 'QUOTE_SUBMITTED', 'QUOTE_UPDATED');

-- CreateEnum
CREATE TYPE "ActivityEntityType" AS ENUM ('PRODUCT', 'CATEGORY', 'MATERIAL', 'FACTORY', 'ASSIGNMENT', 'QUOTE', 'USER');

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" UUID NOT NULL,
    "eventType" "ActivityEventType" NOT NULL,
    "entityType" "ActivityEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityLabelSnapshot" TEXT NOT NULL,
    "actorSource" "AuditActorSource" NOT NULL DEFAULT 'USER',
    "actorUserId" TEXT,
    "actorRole" TEXT NOT NULL,
    "actorUsernameSnapshot" TEXT NOT NULL,
    "factoryId" UUID,
    "changes" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ActivityLog_entityId_check" CHECK (length("entityId") > 0),
    CONSTRAINT "ActivityLog_entityLabelSnapshot_check" CHECK (length("entityLabelSnapshot") BETWEEN 1 AND 500),
    CONSTRAINT "ActivityLog_actorUsernameSnapshot_check" CHECK (length("actorUsernameSnapshot") BETWEEN 1 AND 100),
    CONSTRAINT "ActivityLog_actor_check" CHECK (
      ("actorSource" = 'USER' AND "actorUserId" IS NOT NULL AND "actorRole" IN ('ADMIN', 'FACTORY'))
      OR
      ("actorSource" = 'SYSTEM' AND "actorUserId" IS NULL AND "actorRole" = 'SYSTEM')
    ),
    CONSTRAINT "ActivityLog_changes_object_check" CHECK (jsonb_typeof("changes") = 'object' AND "changes" <> '{}'::jsonb),
    CONSTRAINT "ActivityLog_metadata_object_check" CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object'),
    CONSTRAINT "ActivityLog_event_entity_check" CHECK (
      ("eventType"::text LIKE 'PRODUCT_%' AND "entityType" = 'PRODUCT')
      OR ("eventType"::text LIKE 'CATEGORY_%' AND "entityType" = 'CATEGORY')
      OR ("eventType"::text LIKE 'MATERIAL_%' AND "entityType" = 'MATERIAL')
      OR ("eventType"::text LIKE 'FACTORY_%' AND "entityType" = 'FACTORY')
      OR ("eventType"::text LIKE 'ASSIGNMENT_%' AND "entityType" = 'ASSIGNMENT')
      OR ("eventType"::text LIKE 'QUOTE_%' AND "entityType" = 'QUOTE')
    )
);

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "ActivityLog_eventType_createdAt_idx" ON "ActivityLog"("eventType", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ActivityLog_entityType_entityId_createdAt_idx" ON "ActivityLog"("entityType", "entityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ActivityLog_actorUserId_createdAt_idx" ON "ActivityLog"("actorUserId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ActivityLog_factoryId_createdAt_idx" ON "ActivityLog"("factoryId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
