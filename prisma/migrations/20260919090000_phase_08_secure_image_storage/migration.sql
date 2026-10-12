ALTER TYPE "ActivityEventType" ADD VALUE 'PRODUCT_MAIN_IMAGE_SET';
ALTER TYPE "ActivityEventType" ADD VALUE 'PRODUCT_MAIN_IMAGE_REPLACED';
ALTER TYPE "ActivityEventType" ADD VALUE 'PRODUCT_MAIN_IMAGE_REMOVED';
ALTER TYPE "ActivityEventType" ADD VALUE 'FACTORY_PRIVATE_IMAGE_SET';
ALTER TYPE "ActivityEventType" ADD VALUE 'FACTORY_PRIVATE_IMAGE_REPLACED';
ALTER TYPE "ActivityEventType" ADD VALUE 'FACTORY_PRIVATE_IMAGE_REMOVED';
ALTER TYPE "ActivityEventType" ADD VALUE 'PRODUCT_MAIN_IMAGE_PROMOTED';

CREATE TYPE "StorageProvider" AS ENUM ('LOCAL');

CREATE TABLE "StoredObject" (
    "id" UUID NOT NULL,
    "storageProvider" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "originalFilename" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredObject_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoredObject_storageKey_check" CHECK ("storageKey" ~ '^objects/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'),
    CONSTRAINT "StoredObject_mimeType_check" CHECK ("mimeType" = 'image/webp'),
    CONSTRAINT "StoredObject_sizeBytes_check" CHECK ("sizeBytes" > 0),
    CONSTRAINT "StoredObject_dimensions_check" CHECK ("width" > 0 AND "height" > 0 AND "width" <= 8000 AND "height" <= 8000 AND ("width"::BIGINT * "height"::BIGINT) <= 25000000),
    CONSTRAINT "StoredObject_checksum_check" CHECK ("checksumSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "StoredObject_originalFilename_check" CHECK ("originalFilename" IS NULL OR (char_length("originalFilename") BETWEEN 1 AND 200))
);

CREATE TABLE "ProductMainImage" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "storedObjectId" UUID NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductMainImage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FactoryPrivateImage" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "storedObjectId" UUID NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FactoryPrivateImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoredObject_storageKey_key" ON "StoredObject"("storageKey");
CREATE INDEX "StoredObject_createdByUserId_createdAt_idx" ON "StoredObject"("createdByUserId", "createdAt" DESC);
CREATE INDEX "StoredObject_checksumSha256_idx" ON "StoredObject"("checksumSha256");
CREATE UNIQUE INDEX "ProductMainImage_productId_key" ON "ProductMainImage"("productId");
CREATE UNIQUE INDEX "ProductMainImage_storedObjectId_key" ON "ProductMainImage"("storedObjectId");
CREATE INDEX "ProductMainImage_createdByUserId_idx" ON "ProductMainImage"("createdByUserId");
CREATE UNIQUE INDEX "FactoryPrivateImage_assignmentId_key" ON "FactoryPrivateImage"("assignmentId");
CREATE UNIQUE INDEX "FactoryPrivateImage_storedObjectId_key" ON "FactoryPrivateImage"("storedObjectId");
CREATE INDEX "FactoryPrivateImage_uploadedByUserId_idx" ON "FactoryPrivateImage"("uploadedByUserId");

ALTER TABLE "StoredObject" ADD CONSTRAINT "StoredObject_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductMainImage" ADD CONSTRAINT "ProductMainImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductMainImage" ADD CONSTRAINT "ProductMainImage_storedObjectId_fkey" FOREIGN KEY ("storedObjectId") REFERENCES "StoredObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductMainImage" ADD CONSTRAINT "ProductMainImage_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FactoryPrivateImage" ADD CONSTRAINT "FactoryPrivateImage_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ProductFactoryAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FactoryPrivateImage" ADD CONSTRAINT "FactoryPrivateImage_storedObjectId_fkey" FOREIGN KEY ("storedObjectId") REFERENCES "StoredObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FactoryPrivateImage" ADD CONSTRAINT "FactoryPrivateImage_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ActivityLog" DROP CONSTRAINT "ActivityLog_event_entity_check";
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_event_entity_check" CHECK (
  ("eventType"::text LIKE 'PRODUCT_%' AND "entityType" = 'PRODUCT') OR
  ("eventType"::text LIKE 'CATEGORY_%' AND "entityType" = 'CATEGORY') OR
  ("eventType"::text LIKE 'MATERIAL_%' AND "entityType" = 'MATERIAL') OR
  ("eventType"::text LIKE 'FACTORY_PRIVATE_IMAGE_%' AND "entityType" = 'ASSIGNMENT') OR
  ("eventType"::text LIKE 'FACTORY_%' AND "entityType" = 'FACTORY') OR
  ("eventType"::text LIKE 'ASSIGNMENT_%' AND "entityType" = 'ASSIGNMENT') OR
  ("eventType"::text LIKE 'QUOTE_%' AND "entityType" = 'QUOTE')
);
