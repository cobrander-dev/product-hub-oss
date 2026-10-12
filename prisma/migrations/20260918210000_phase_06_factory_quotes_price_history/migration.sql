-- CreateTable
CREATE TABLE "FactoryQuote" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "priceCents" BIGINT NOT NULL,
    "moq" INTEGER,
    "packingLengthCm" DECIMAL(12,3),
    "packingWidthCm" DECIMAL(12,3),
    "packingHeightCm" DECIMAL(12,3),
    "netWeightKg" DECIMAL(12,3),
    "grossWeightKg" DECIMAL(12,3),
    "pcsPerCarton" INTEGER,
    "factoryNotes" TEXT,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FactoryQuote_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FactoryQuote_priceCents_check" CHECK ("priceCents" > 0),
    CONSTRAINT "FactoryQuote_moq_check" CHECK ("moq" IS NULL OR "moq" > 0),
    CONSTRAINT "FactoryQuote_packingLengthCm_check" CHECK ("packingLengthCm" IS NULL OR "packingLengthCm" > 0),
    CONSTRAINT "FactoryQuote_packingWidthCm_check" CHECK ("packingWidthCm" IS NULL OR "packingWidthCm" > 0),
    CONSTRAINT "FactoryQuote_packingHeightCm_check" CHECK ("packingHeightCm" IS NULL OR "packingHeightCm" > 0),
    CONSTRAINT "FactoryQuote_netWeightKg_check" CHECK ("netWeightKg" IS NULL OR "netWeightKg" > 0),
    CONSTRAINT "FactoryQuote_grossWeightKg_check" CHECK ("grossWeightKg" IS NULL OR "grossWeightKg" > 0),
    CONSTRAINT "FactoryQuote_weight_order_check" CHECK ("netWeightKg" IS NULL OR "grossWeightKg" IS NULL OR "grossWeightKg" >= "netWeightKg"),
    CONSTRAINT "FactoryQuote_pcsPerCarton_check" CHECK ("pcsPerCarton" IS NULL OR "pcsPerCarton" > 0),
    CONSTRAINT "FactoryQuote_version_check" CHECK ("version" >= 1)
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" UUID NOT NULL,
    "factoryQuoteId" UUID NOT NULL,
    "oldPriceCents" BIGINT,
    "newPriceCents" BIGINT NOT NULL,
    "changedByUserId" TEXT NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PriceHistory_oldPriceCents_check" CHECK ("oldPriceCents" IS NULL OR "oldPriceCents" > 0),
    CONSTRAINT "PriceHistory_newPriceCents_check" CHECK ("newPriceCents" > 0),
    CONSTRAINT "PriceHistory_price_change_check" CHECK ("oldPriceCents" IS NULL OR "oldPriceCents" <> "newPriceCents")
);

-- CreateIndex
CREATE UNIQUE INDEX "FactoryQuote_assignmentId_key" ON "FactoryQuote"("assignmentId");

-- CreateIndex
CREATE INDEX "FactoryQuote_updatedAt_idx" ON "FactoryQuote"("updatedAt" DESC);

-- CreateIndex
CREATE INDEX "PriceHistory_factoryQuoteId_changedAt_idx" ON "PriceHistory"("factoryQuoteId", "changedAt" DESC);

-- CreateIndex
CREATE INDEX "PriceHistory_changedByUserId_changedAt_idx" ON "PriceHistory"("changedByUserId", "changedAt" DESC);

-- AddForeignKey
ALTER TABLE "FactoryQuote" ADD CONSTRAINT "FactoryQuote_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ProductFactoryAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_factoryQuoteId_fkey" FOREIGN KEY ("factoryQuoteId") REFERENCES "FactoryQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
