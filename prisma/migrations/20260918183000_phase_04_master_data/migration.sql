-- CreateEnum
CREATE TYPE "DictionaryStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ENABLED', 'DISABLED');

-- Extend the existing Factory safely. Existing Phase 02 rows are normalized
-- before the new application-level canonical key becomes required.
ALTER TABLE "Factory"
    ADD COLUMN "contactName" TEXT,
    ADD COLUMN "nameNormalized" TEXT,
    ADD COLUMN "notes" TEXT,
    ADD COLUMN "phone" TEXT;

UPDATE "Factory"
SET "name" = btrim("name"),
    "nameNormalized" = lower(btrim("name"));

ALTER TABLE "Factory"
    ALTER COLUMN "nameNormalized" SET NOT NULL,
    ADD CONSTRAINT "Factory_name_nonempty_check" CHECK (length(btrim("name")) > 0),
    ADD CONSTRAINT "Factory_name_normalized_check" CHECK ("nameNormalized" = lower(btrim("name")));

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "status" "DictionaryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Category_name_nonempty_check" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "Category_name_normalized_check" CHECK ("nameNormalized" = lower(btrim("name")))
);

-- CreateTable
CREATE TABLE "Material" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "status" "DictionaryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Material_name_nonempty_check" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "Material_name_normalized_check" CHECK ("nameNormalized" = lower(btrim("name")))
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "sku" TEXT,
    "skuNormalized" TEXT,
    "name" TEXT NOT NULL,
    "categoryId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'ENABLED',
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Product_name_nonempty_check" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "Product_sku_pair_check" CHECK (
        ("sku" IS NULL AND "skuNormalized" IS NULL)
        OR (
            "sku" IS NOT NULL
            AND length(btrim("sku")) > 0
            AND "skuNormalized" = upper(btrim("sku"))
        )
    )
);

-- Unique and access-path indexes
CREATE UNIQUE INDEX "Category_nameNormalized_key" ON "Category"("nameNormalized");
CREATE INDEX "Category_status_idx" ON "Category"("status");
CREATE UNIQUE INDEX "Material_nameNormalized_key" ON "Material"("nameNormalized");
CREATE INDEX "Material_status_idx" ON "Material"("status");
CREATE UNIQUE INDEX "Product_skuNormalized_key" ON "Product"("skuNormalized");
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");
CREATE INDEX "Product_materialId_idx" ON "Product"("materialId");
CREATE INDEX "Product_status_updatedAt_idx" ON "Product"("status", "updatedAt" DESC);
CREATE UNIQUE INDEX "Factory_nameNormalized_key" ON "Factory"("nameNormalized");

-- Restrict deletion so dictionary records cannot break existing products.
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_materialId_fkey"
    FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
