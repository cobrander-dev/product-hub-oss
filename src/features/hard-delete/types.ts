import { z } from "zod";

export const hardDeleteTargetTypeSchema = z.enum([
  "USER",
  "PRODUCT",
  "FACTORY",
  "CATEGORY",
  "MATERIAL",
  "ASSIGNMENT",
  "QUOTE",
  "PRODUCT_MAIN_IMAGE",
  "FACTORY_PRIVATE_IMAGE",
]);

export type AuthorizedHardDeleteTargetType = z.infer<
  typeof hardDeleteTargetTypeSchema
>;

export const createHardDeletePreviewSchema = z
  .object({
    targetType: hardDeleteTargetTypeSchema,
    targetId: z.string().trim().min(1).max(255),
  })
  .strict();

export const confirmHardDeleteSchema = z
  .object({
    operationId: z.string().uuid(),
    previewSha256: z.string().regex(/^[0-9a-f]{64}$/),
    expectedVersion: z.number().int().positive(),
    confirmationPhrase: z.string().min(1).max(1000),
  })
  .strict();

const fileSchema = z
  .object({
    storedObjectId: z.string().uuid(),
    storageProvider: z.literal("LOCAL"),
    storageKey: z.string(),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.string().regex(/^\d+$/),
  })
  .strict();

export const databasePlanSchema = z
  .object({
    schemaVersion: z.literal(2),
    target: z
      .object({
        type: hardDeleteTargetTypeSchema,
        id: z.string(),
        label: z.string(),
        status: z.string(),
        version: z.string(),
      })
      .strict(),
    blockers: z.array(z.string()),
    delete: z.record(z.string(), z.array(z.string())),
    preserve: z.record(z.string(), z.unknown()),
    files: z.array(fileSchema),
  })
  .passthrough();

export type HardDeleteDatabasePlan = z.infer<typeof databasePlanSchema>;

export type HardDeleteInternalPreview = {
  schemaVersion: 2;
  databasePlan: HardDeleteDatabasePlan;
  fileState: Array<{
    storedObjectId: string;
    exists: boolean;
    actualSizeBytes: number | null;
    actualChecksumSha256: string | null;
    expectedSizeBytes: string;
    checksumSha256: string;
  }>;
  consistency: {
    unknownFileKeys: string[];
    missingStoredObjectKeys: string[];
  };
};
