import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import type { AuthActor } from "@/lib/auth/context-core";

type AuditValue = string | number | boolean | null;
type AuditInputValue = AuditValue | bigint | Prisma.Decimal | Date;

const eventPolicies = {
  PRODUCT_CREATED: {
    entityType: "PRODUCT",
    fields: ["sku", "name", "categoryId", "materialId", "status", "notes"],
    metadata: [],
  },
  PRODUCT_UPDATED: {
    entityType: "PRODUCT",
    fields: ["sku", "name", "categoryId", "materialId", "notes"],
    metadata: [],
  },
  PRODUCT_ENABLED: {
    entityType: "PRODUCT",
    fields: ["status"],
    metadata: [],
  },
  PRODUCT_DISABLED: {
    entityType: "PRODUCT",
    fields: ["status"],
    metadata: [],
  },
  CATEGORY_CREATED: {
    entityType: "CATEGORY",
    fields: ["name", "status"],
    metadata: [],
  },
  CATEGORY_UPDATED: {
    entityType: "CATEGORY",
    fields: ["name"],
    metadata: [],
  },
  CATEGORY_ENABLED: {
    entityType: "CATEGORY",
    fields: ["status"],
    metadata: [],
  },
  CATEGORY_DISABLED: {
    entityType: "CATEGORY",
    fields: ["status"],
    metadata: [],
  },
  MATERIAL_CREATED: {
    entityType: "MATERIAL",
    fields: ["name", "status"],
    metadata: [],
  },
  MATERIAL_UPDATED: {
    entityType: "MATERIAL",
    fields: ["name"],
    metadata: [],
  },
  MATERIAL_ENABLED: {
    entityType: "MATERIAL",
    fields: ["status"],
    metadata: [],
  },
  MATERIAL_DISABLED: {
    entityType: "MATERIAL",
    fields: ["status"],
    metadata: [],
  },
  FACTORY_CREATED: {
    entityType: "FACTORY",
    fields: ["name", "contactName", "phone", "notes", "status"],
    metadata: [],
  },
  FACTORY_UPDATED: {
    entityType: "FACTORY",
    fields: ["name", "contactName", "phone", "notes"],
    metadata: [],
  },
  FACTORY_ENABLED: {
    entityType: "FACTORY",
    fields: ["status"],
    metadata: [],
  },
  FACTORY_DISABLED: {
    entityType: "FACTORY",
    fields: ["status"],
    metadata: [],
  },
  ASSIGNMENT_ASSIGNED: {
    entityType: "ASSIGNMENT",
    fields: ["productId", "factoryId", "status"],
    metadata: ["productId", "factoryId"],
  },
  ASSIGNMENT_REVOKED: {
    entityType: "ASSIGNMENT",
    fields: ["status"],
    metadata: ["productId", "factoryId"],
  },
  ASSIGNMENT_REACTIVATED: {
    entityType: "ASSIGNMENT",
    fields: ["status"],
    metadata: ["productId", "factoryId"],
  },
  QUOTE_SUBMITTED: {
    entityType: "QUOTE",
    fields: [
      "priceCents",
      "moq",
      "packingLengthCm",
      "packingWidthCm",
      "packingHeightCm",
      "netWeightKg",
      "grossWeightKg",
      "pcsPerCarton",
      "factoryNotes",
    ],
    metadata: ["assignmentId", "productId"],
  },
  QUOTE_UPDATED: {
    entityType: "QUOTE",
    fields: [
      "priceCents",
      "moq",
      "packingLengthCm",
      "packingWidthCm",
      "packingHeightCm",
      "netWeightKg",
      "grossWeightKg",
      "pcsPerCarton",
      "factoryNotes",
    ],
    metadata: ["assignmentId", "productId"],
  },
  PRODUCT_MAIN_IMAGE_SET: {
    entityType: "PRODUCT",
    fields: ["storedObjectId"],
    metadata: ["productId"],
  },
  PRODUCT_MAIN_IMAGE_REPLACED: {
    entityType: "PRODUCT",
    fields: ["storedObjectId"],
    metadata: ["productId"],
  },
  PRODUCT_MAIN_IMAGE_REMOVED: {
    entityType: "PRODUCT",
    fields: ["storedObjectId"],
    metadata: ["productId"],
  },
  FACTORY_PRIVATE_IMAGE_SET: {
    entityType: "ASSIGNMENT",
    fields: ["storedObjectId"],
    metadata: ["assignmentId", "productId", "factoryId"],
  },
  FACTORY_PRIVATE_IMAGE_REPLACED: {
    entityType: "ASSIGNMENT",
    fields: ["storedObjectId"],
    metadata: ["assignmentId", "productId", "factoryId"],
  },
  FACTORY_PRIVATE_IMAGE_REMOVED: {
    entityType: "ASSIGNMENT",
    fields: ["storedObjectId"],
    metadata: ["assignmentId", "productId", "factoryId"],
  },
  PRODUCT_MAIN_IMAGE_PROMOTED: {
    entityType: "PRODUCT",
    fields: ["storedObjectId"],
    metadata: [
      "productId",
      "assignmentId",
      "factoryId",
      "sourceFactoryImageId",
    ],
  },
  USER_CREATED: {
    entityType: "USER",
    fields: ["username", "status", "factoryId"],
    metadata: [],
  },
  USER_ENABLED: {
    entityType: "USER",
    fields: ["status"],
    metadata: [],
  },
  USER_DISABLED: {
    entityType: "USER",
    fields: ["status"],
    metadata: [],
  },
} as const;

export type BusinessEventType = keyof typeof eventPolicies;
type Policy<E extends BusinessEventType> = (typeof eventPolicies)[E];
type FieldName<E extends BusinessEventType> = Policy<E>["fields"][number];
type MetadataName<E extends BusinessEventType> = Policy<E>["metadata"][number];
export type AuditSnapshot<E extends BusinessEventType> = Record<
  FieldName<E>,
  AuditInputValue
>;
type AuditMetadata<E extends BusinessEventType> = Record<
  MetadataName<E>,
  AuditInputValue
>;

export type UserActivityInput<E extends BusinessEventType> = {
  eventType: E;
  actor: AuthActor;
  entityId: string;
  entityLabelSnapshot: string;
  factoryId: string | null;
  before: AuditSnapshot<E>;
  after: AuditSnapshot<E>;
  metadata: AuditMetadata<E>;
};

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} contains non-allowlisted fields: ${unknown.join(", ")}`,
    );
  }
}

function buildChanges(
  before: Record<string, AuditInputValue>,
  after: Record<string, AuditInputValue>,
  fields: readonly string[],
) {
  assertAllowedKeys(before, fields, "Audit before snapshot");
  assertAllowedKeys(after, fields, "Audit after snapshot");
  const changes: Record<string, { before: AuditValue; after: AuditValue }> = {};
  for (const field of fields) {
    const previous = normalizeAuditValue(before[field] ?? null);
    const next = normalizeAuditValue(after[field] ?? null);
    if (previous !== next) changes[field] = { before: previous, after: next };
  }
  return changes;
}

function normalizeAuditValue(value: AuditInputValue): AuditValue {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("Audit value must be an allowlisted scalar");
}

function normalizeMetadata(
  metadata: Record<string, AuditInputValue>,
  allowed: readonly string[],
) {
  assertAllowedKeys(metadata, allowed, "Audit metadata");
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      normalizeAuditValue(value),
    ]),
  );
}

export async function writeUserActivity<E extends BusinessEventType>(
  tx: Prisma.TransactionClient,
  input: UserActivityInput<E>,
) {
  const policy = eventPolicies[input.eventType];
  const metadata = normalizeMetadata(input.metadata, policy.metadata);
  const changes = buildChanges(input.before, input.after, policy.fields);
  if (Object.keys(changes).length === 0) return null;

  return tx.activityLog.create({
    data: {
      eventType: input.eventType,
      entityType: policy.entityType,
      entityId: input.entityId,
      entityLabelSnapshot: input.entityLabelSnapshot,
      actorSource: "USER",
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      actorUsernameSnapshot: input.actor.username,
      factoryId: input.factoryId,
      changes,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    },
  });
}

export function auditText(value: string | null, limit = 200) {
  if (value === null || value.length <= limit) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `[长文本 ${value.length} 字，SHA-256:${digest}]`;
}

export function productLabel(value: { sku: string | null; name: string }) {
  return value.sku ? `${value.sku} · ${value.name}` : value.name;
}

export function assignmentLabel(value: {
  product: { sku: string | null; name: string };
  factory: { name: string };
}) {
  return `${productLabel(value.product)} · ${value.factory.name}`;
}
