import { Prisma } from "@/generated/prisma/client";
import type { z } from "zod";

import { parseInput } from "@/features/master-data/shared";
import {
  adminQuoteListSchema,
  historyListSchema,
  parsePriceToCents,
  quoteIdSchema,
  submitQuoteSchema,
} from "@/features/quotes/validation";
import {
  ApplicationError,
  isUniqueConstraintError,
} from "@/lib/application/errors";
import {
  assignmentLabel,
  auditText,
  type AuditSnapshot,
  writeUserActivity,
} from "@/features/activity/writer";
import {
  requireAdminFromHeaders,
  requireFactoryUserFromHeaders,
} from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

const quoteRelations = {
  assignment: {
    include: {
      product: {
        select: { id: true, sku: true, name: true, status: true },
      },
      factory: { select: { id: true, name: true, status: true } },
    },
  },
} satisfies Prisma.FactoryQuoteInclude;

type QuoteWithRelations = Prisma.FactoryQuoteGetPayload<{
  include: typeof quoteRelations;
}>;

function decimalString(value: Prisma.Decimal | null) {
  return value?.toString() ?? null;
}

function computeCbm(quote: {
  packingLengthCm: Prisma.Decimal | null;
  packingWidthCm: Prisma.Decimal | null;
  packingHeightCm: Prisma.Decimal | null;
}) {
  if (
    !quote.packingLengthCm ||
    !quote.packingWidthCm ||
    !quote.packingHeightCm
  ) {
    return null;
  }
  return quote.packingLengthCm
    .mul(quote.packingWidthCm)
    .mul(quote.packingHeightCm)
    .div(1_000_000)
    .toDecimalPlaces(9)
    .toString();
}

function quoteDto(quote: QuoteWithRelations) {
  return {
    id: quote.id,
    assignmentId: quote.assignmentId,
    priceCents: quote.priceCents.toString(),
    moq: quote.moq,
    packingLengthCm: decimalString(quote.packingLengthCm),
    packingWidthCm: decimalString(quote.packingWidthCm),
    packingHeightCm: decimalString(quote.packingHeightCm),
    cbmM3: computeCbm(quote),
    netWeightKg: decimalString(quote.netWeightKg),
    grossWeightKg: decimalString(quote.grossWeightKg),
    pcsPerCarton: quote.pcsPerCarton,
    factoryNotes: quote.factoryNotes,
    submittedAt: quote.submittedAt,
    version: quote.version,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    product: quote.assignment.product,
    factory: quote.assignment.factory,
  };
}

function historyDto(history: {
  id: string;
  factoryQuoteId: string;
  oldPriceCents: bigint | null;
  newPriceCents: bigint;
  changedByUserId: string | null;
  changedAt: Date;
  changedByUser?: {
    id: string;
    username: string | null;
    name: string;
  } | null;
}) {
  return {
    ...history,
    oldPriceCents: history.oldPriceCents?.toString() ?? null,
    newPriceCents: history.newPriceCents.toString(),
  };
}

type SubmitQuoteInput = z.infer<typeof submitQuoteSchema>;

function quoteWriteData(values: SubmitQuoteInput) {
  return {
    priceCents: parsePriceToCents(values.price),
    moq: values.moq ?? null,
    packingLengthCm: values.packingLengthCm ?? null,
    packingWidthCm: values.packingWidthCm ?? null,
    packingHeightCm: values.packingHeightCm ?? null,
    netWeightKg: values.netWeightKg ?? null,
    grossWeightKg: values.grossWeightKg ?? null,
    pcsPerCarton: values.pcsPerCarton ?? null,
    factoryNotes: values.factoryNotes,
  };
}

type QuoteAuditSource = {
  priceCents: bigint;
  moq: number | null;
  packingLengthCm: Prisma.Decimal | string | null;
  packingWidthCm: Prisma.Decimal | string | null;
  packingHeightCm: Prisma.Decimal | string | null;
  netWeightKg: Prisma.Decimal | string | null;
  grossWeightKg: Prisma.Decimal | string | null;
  pcsPerCarton: number | null;
  factoryNotes: string | null;
};

function quoteAuditSnapshot(
  quote: QuoteAuditSource,
): AuditSnapshot<"QUOTE_UPDATED"> {
  const decimal = (value: Prisma.Decimal | string | null) =>
    value === null ? null : new Prisma.Decimal(value).toString();
  return {
    priceCents: quote.priceCents.toString(),
    moq: quote.moq,
    packingLengthCm: decimal(quote.packingLengthCm),
    packingWidthCm: decimal(quote.packingWidthCm),
    packingHeightCm: decimal(quote.packingHeightCm),
    netWeightKg: decimal(quote.netWeightKg),
    grossWeightKg: decimal(quote.grossWeightKg),
    pcsPerCarton: quote.pcsPerCarton,
    factoryNotes: auditText(quote.factoryNotes),
  };
}

function emptyQuoteAuditSnapshot(): AuditSnapshot<"QUOTE_SUBMITTED"> {
  return {
    priceCents: null,
    moq: null,
    packingLengthCm: null,
    packingWidthCm: null,
    packingHeightCm: null,
    netWeightKg: null,
    grossWeightKg: null,
    pcsPerCarton: null,
    factoryNotes: null,
  };
}

function auditSnapshotsEqual(
  before: AuditSnapshot<"QUOTE_UPDATED">,
  after: AuditSnapshot<"QUOTE_UPDATED">,
) {
  return Object.keys(before).every(
    (key) =>
      before[key as keyof typeof before] === after[key as keyof typeof after],
  );
}

function assertWeightOrder(values: {
  netWeightKg?: string;
  grossWeightKg?: string;
}) {
  if (
    values.netWeightKg &&
    values.grossWeightKg &&
    new Prisma.Decimal(values.grossWeightKg).lt(
      new Prisma.Decimal(values.netWeightKg),
    )
  ) {
    throw new ApplicationError("VALIDATION", "毛重不能小于净重");
  }
}

export async function submitOwnQuote(headers: Headers, input: unknown) {
  const actor = await requireFactoryUserFromHeaders(headers);
  const values = parseInput(submitQuoteSchema, input);
  assertWeightOrder(values);
  const writeData = quoteWriteData(values);

  try {
    const quote = await prisma.$transaction(async (tx) => {
      const assignment = await tx.productFactoryAssignment.findFirst({
        where: {
          id: values.assignmentId,
          factoryId: actor.factoryId,
          status: "ACTIVE",
          product: { status: "ENABLED" },
          factory: { status: "ACTIVE" },
        },
        include: {
          product: { select: { id: true, sku: true, name: true } },
          factory: { select: { id: true, name: true } },
        },
      });
      if (!assignment) {
        throw new ApplicationError("NOT_FOUND", "报价不存在或当前不可提交");
      }

      const current = await tx.factoryQuote.findUnique({
        where: { assignmentId: assignment.id },
      });
      if (!current) {
        const created = await tx.factoryQuote.create({
          data: { assignmentId: assignment.id, ...writeData },
        });
        await tx.priceHistory.create({
          data: {
            factoryQuoteId: created.id,
            oldPriceCents: null,
            newPriceCents: created.priceCents,
            changedByUserId: actor.userId,
          },
        });
        await writeUserActivity(tx, {
          eventType: "QUOTE_SUBMITTED",
          actor,
          entityId: created.id,
          entityLabelSnapshot: assignmentLabel(assignment),
          factoryId: assignment.factoryId,
          before: emptyQuoteAuditSnapshot(),
          after: quoteAuditSnapshot(created),
          metadata: {
            assignmentId: assignment.id,
            productId: assignment.productId,
          },
        });
        return tx.factoryQuote.findUniqueOrThrow({
          where: { id: created.id },
          include: quoteRelations,
        });
      }

      if (values.expectedVersion !== current.version) {
        throw new ApplicationError(
          "CONFLICT",
          "该报价已被其他用户更新，请刷新后重试。",
        );
      }

      const beforeAudit = quoteAuditSnapshot(current);
      const afterAudit = quoteAuditSnapshot(writeData);
      if (auditSnapshotsEqual(beforeAudit, afterAudit)) {
        return tx.factoryQuote.findUniqueOrThrow({
          where: { id: current.id },
          include: quoteRelations,
        });
      }

      const updated = await tx.factoryQuote.updateMany({
        where: { id: current.id, version: values.expectedVersion },
        data: { ...writeData, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new ApplicationError(
          "CONFLICT",
          "该报价已被其他用户更新，请刷新后重试。",
        );
      }
      if (current.priceCents !== writeData.priceCents) {
        await tx.priceHistory.create({
          data: {
            factoryQuoteId: current.id,
            oldPriceCents: current.priceCents,
            newPriceCents: writeData.priceCents,
            changedByUserId: actor.userId,
          },
        });
      }
      const updatedQuote = await tx.factoryQuote.findUniqueOrThrow({
        where: { id: current.id },
        include: quoteRelations,
      });
      await writeUserActivity(tx, {
        eventType: "QUOTE_UPDATED",
        actor,
        entityId: updatedQuote.id,
        entityLabelSnapshot: assignmentLabel(assignment),
        factoryId: assignment.factoryId,
        before: beforeAudit,
        after: quoteAuditSnapshot(updatedQuote),
        metadata: {
          assignmentId: assignment.id,
          productId: assignment.productId,
        },
      });
      return updatedQuote;
    });
    return quoteDto(quote);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApplicationError(
        "CONFLICT",
        "该报价已被其他用户提交，请刷新后重试。",
      );
    }
    throw error;
  }
}

export async function getOwnQuoteForAssignment(
  headers: Headers,
  assignmentIdInput: unknown,
) {
  const actor = await requireFactoryUserFromHeaders(headers);
  const assignmentId = parseInput(
    submitQuoteSchema.shape.assignmentId,
    assignmentIdInput,
  );
  const assignment = await prisma.productFactoryAssignment.findFirst({
    where: {
      id: assignmentId,
      factoryId: actor.factoryId,
      status: "ACTIVE",
      product: { status: "ENABLED" },
      factory: { status: "ACTIVE" },
    },
    select: { quote: { include: quoteRelations } },
  });
  if (!assignment) throw new ApplicationError("NOT_FOUND", "报价不存在");
  return assignment.quote ? quoteDto(assignment.quote) : null;
}

export async function getAdminQuote(headers: Headers, quoteIdInput: unknown) {
  await requireAdminFromHeaders(headers);
  const quoteId = parseInput(quoteIdSchema.shape.quoteId, quoteIdInput);
  const quote = await prisma.factoryQuote.findUnique({
    where: { id: quoteId },
    include: quoteRelations,
  });
  if (!quote) throw new ApplicationError("NOT_FOUND", "报价不存在");
  return quoteDto(quote);
}

export async function listAdminQuotes(headers: Headers, input: unknown = {}) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(adminQuoteListSchema, input);
  const where: Prisma.FactoryQuoteWhereInput = {
    assignment: {
      productId: query.productId,
      factoryId: query.factoryId,
      ...(query.search
        ? {
            OR: [
              {
                product: {
                  sku: { contains: query.search, mode: "insensitive" },
                },
              },
              {
                product: {
                  name: { contains: query.search, mode: "insensitive" },
                },
              },
              {
                factory: {
                  name: { contains: query.search, mode: "insensitive" },
                },
              },
            ],
          }
        : {}),
    },
  };
  const [items, total] = await Promise.all([
    prisma.factoryQuote.findMany({
      where,
      include: quoteRelations,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.factoryQuote.count({ where }),
  ]);
  return {
    items: items.map(quoteDto),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

async function listHistory(quoteId: string, page: number, pageSize: number) {
  const where = { factoryQuoteId: quoteId };
  const [items, total] = await Promise.all([
    prisma.priceHistory.findMany({
      where,
      include: {
        changedByUser: { select: { id: true, username: true, name: true } },
      },
      orderBy: [{ changedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.priceHistory.count({ where }),
  ]);
  return {
    items: items.map(historyDto),
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function listOwnPriceHistory(headers: Headers, input: unknown) {
  const actor = await requireFactoryUserFromHeaders(headers);
  const query = parseInput(historyListSchema, input);
  const quote = await prisma.factoryQuote.findFirst({
    where: {
      id: query.quoteId,
      assignment: {
        factoryId: actor.factoryId,
        status: "ACTIVE",
        product: { status: "ENABLED" },
        factory: { status: "ACTIVE" },
      },
    },
    select: { id: true },
  });
  if (!quote) throw new ApplicationError("NOT_FOUND", "报价不存在");
  return listHistory(quote.id, query.page, query.pageSize);
}

export async function listAdminPriceHistory(headers: Headers, input: unknown) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(historyListSchema, input);
  const quote = await prisma.factoryQuote.findUnique({
    where: { id: query.quoteId },
    select: { id: true },
  });
  if (!quote) throw new ApplicationError("NOT_FOUND", "报价不存在");
  return listHistory(quote.id, query.page, query.pageSize);
}
