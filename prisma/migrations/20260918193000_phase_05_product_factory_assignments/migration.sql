-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "ProductFactoryAssignment" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductFactoryAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductFactoryAssignment_status_time_check" CHECK (
        ("status" = 'ACTIVE' AND "revokedAt" IS NULL)
        OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
    ),
    CONSTRAINT "ProductFactoryAssignment_assigned_time_check" CHECK (
        "assignedAt" >= "createdAt"
    ),
    CONSTRAINT "ProductFactoryAssignment_revoked_time_check" CHECK (
        "revokedAt" IS NULL OR "revokedAt" >= "assignedAt"
    )
);

-- CreateIndex
CREATE INDEX "ProductFactoryAssignment_factoryId_status_idx"
    ON "ProductFactoryAssignment"("factoryId", "status");

-- CreateIndex
CREATE INDEX "ProductFactoryAssignment_productId_status_idx"
    ON "ProductFactoryAssignment"("productId", "status");

-- A Product/Factory relationship is stable across revoke/reactivate cycles.
CREATE UNIQUE INDEX "ProductFactoryAssignment_productId_factoryId_key"
    ON "ProductFactoryAssignment"("productId", "factoryId");

-- Restrict deletion so assignments and future history cannot disappear with
-- Product or Factory cleanup.
ALTER TABLE "ProductFactoryAssignment" ADD CONSTRAINT "ProductFactoryAssignment_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProductFactoryAssignment" ADD CONSTRAINT "ProductFactoryAssignment_factoryId_fkey"
    FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
