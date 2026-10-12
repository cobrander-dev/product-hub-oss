import type { Prisma } from "@/generated/prisma/client";

export const activityEventLabels: Record<string, string> = {
  PRODUCT_CREATED: "产品已创建",
  PRODUCT_UPDATED: "产品已更新",
  PRODUCT_ENABLED: "产品已启用",
  PRODUCT_DISABLED: "产品已停用",
  CATEGORY_CREATED: "分类已创建",
  CATEGORY_UPDATED: "分类已更新",
  CATEGORY_ENABLED: "分类已启用",
  CATEGORY_DISABLED: "分类已停用",
  MATERIAL_CREATED: "材质已创建",
  MATERIAL_UPDATED: "材质已更新",
  MATERIAL_ENABLED: "材质已启用",
  MATERIAL_DISABLED: "材质已停用",
  FACTORY_CREATED: "厂家已创建",
  FACTORY_UPDATED: "厂家已更新",
  FACTORY_ENABLED: "厂家已启用",
  FACTORY_DISABLED: "厂家已停用",
  ASSIGNMENT_ASSIGNED: "厂家分配已建立",
  ASSIGNMENT_REVOKED: "厂家分配已撤销",
  ASSIGNMENT_REACTIVATED: "厂家分配已恢复",
  QUOTE_SUBMITTED: "报价已提交",
  QUOTE_UPDATED: "报价已更新",
  PRODUCT_MAIN_IMAGE_SET: "产品主图已设置",
  PRODUCT_MAIN_IMAGE_REPLACED: "产品主图已替换",
  PRODUCT_MAIN_IMAGE_REMOVED: "产品主图已移除",
  PRODUCT_MAIN_IMAGE_PROMOTED: "厂家图片已提升为主图",
  FACTORY_PRIVATE_IMAGE_SET: "厂家图片已设置",
  FACTORY_PRIVATE_IMAGE_REPLACED: "厂家图片已替换",
  FACTORY_PRIVATE_IMAGE_REMOVED: "厂家图片已移除",
  USER_CREATED: "用户已创建",
  USER_ENABLED: "用户已启用",
  USER_DISABLED: "用户已停用",
};

export const activityEntityLabels: Record<string, string> = {
  PRODUCT: "产品",
  CATEGORY: "分类",
  MATERIAL: "材质",
  FACTORY: "厂家",
  ASSIGNMENT: "厂家分配",
  QUOTE: "报价",
  USER: "用户",
};

const fieldLabels: Record<string, string> = {
  sku: "SKU",
  name: "名称",
  categoryId: "分类",
  materialId: "材质",
  status: "状态",
  notes: "备注",
  contactName: "联系人",
  phone: "电话",
  productId: "产品",
  factoryId: "厂家",
  priceCents: "价格",
  moq: "MOQ",
  packingLengthCm: "包装长度",
  packingWidthCm: "包装宽度",
  packingHeightCm: "包装高度",
  netWeightKg: "净重",
  grossWeightKg: "毛重",
  pcsPerCarton: "每箱数量",
  factoryNotes: "厂家备注",
  storedObjectId: "图片",
  username: "用户名",
};

function scalar(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return "未填写";
  if (field === "priceCents") {
    const cents = BigInt(String(value));
    return `¥${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  }
  if (["packingLengthCm", "packingWidthCm", "packingHeightCm"].includes(field))
    return `${value} cm`;
  if (["netWeightKg", "grossWeightKg"].includes(field)) return `${value} kg`;
  if (field === "storedObjectId") return value ? "已设置图片" : "无图片";
  const mapped: Record<string, string> = {
    ENABLED: "启用",
    DISABLED: "停用",
    ACTIVE: "有效",
    REVOKED: "已撤销",
  };
  return mapped[String(value)] ?? String(value);
}

export function readableActivityChanges(value: Prisma.JsonValue) {
  if (!value || Array.isArray(value) || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([field, change]) => {
    if (!change || Array.isArray(change) || typeof change !== "object")
      return [];
    const pair = change as { before?: unknown; after?: unknown };
    return [
      {
        field,
        label: fieldLabels[field] ?? field,
        before: scalar(pair.before, field),
        after: scalar(pair.after, field),
      },
    ];
  });
}
