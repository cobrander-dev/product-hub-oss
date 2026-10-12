import type { AuthorizedHardDeleteTargetType } from "./types";
export const entityLabels: Record<AuthorizedHardDeleteTargetType, string> = {
  PRODUCT: "产品",
  FACTORY: "厂家",
  USER: "厂家账号",
  CATEGORY: "分类",
  MATERIAL: "材质",
  ASSIGNMENT: "厂家分配",
  QUOTE: "报价",
  PRODUCT_MAIN_IMAGE: "产品主图",
  FACTORY_PRIVATE_IMAGE: "厂家私图",
};
export const countLabels: Record<string, string> = {
  products: "产品",
  factories: "厂家",
  users: "账号",
  accounts: "认证账户",
  sessions: "会话",
  categories: "分类",
  materials: "材质",
  assignments: "厂家分配",
  quotes: "报价",
  priceHistories: "价格历史",
  mainImages: "主图",
  privateImages: "厂家私图",
  storedObjects: "专属存储对象",
  activityLogs: "审计记录",
  importRowsToDetach: "解除稳定导入关联",
  imports: "导入记录",
  sharedStoredObjects: "共享存储对象与文件",
  otherBusinessHistory: "其他业务历史",
};
export const blockerMessages: Record<string, string> = {
  PRODUCT_NOT_DISABLED: "产品仍处于启用状态，请先停用产品。",
  FACTORY_NOT_DISABLED: "厂家仍处于启用状态，请先停用厂家。",
  FACTORY_CONTAINS_ADMIN: "厂家包含管理员账号，不能永久删除。",
  FACTORY_HAS_ENABLED_USERS: "厂家仍有启用账号，请先停用全部厂家账号。",
  USER_NOT_DISABLED_FACTORY:
    "只允许删除已停用的厂家账号；请先停用账号。管理员不能删除。",
  CURRENT_ADMIN: "不能永久删除当前登录账号。",
  CATEGORY_NOT_DISABLED: "分类仍处于启用状态，请先停用分类。",
  MATERIAL_NOT_DISABLED: "材质仍处于启用状态，请先停用材质。",
  CATEGORY_HAS_PRODUCTS: "仍有产品使用此分类，请先修改引用产品的分类。",
  MATERIAL_HAS_PRODUCTS: "仍有产品使用此材质，请先修改引用产品的材质。",
  ASSIGNMENT_NOT_REVOKED: "分配仍有效，请先撤销分配。",
  QUOTE_ASSIGNMENT_NOT_REVOKED: "报价所属分配仍有效，请先撤销分配。",
};
export function completedDestination(type: AuthorizedHardDeleteTargetType) {
  return type === "FACTORY"
    ? "/admin/factories"
    : type === "USER"
      ? "/admin/users"
      : ["CATEGORY", "MATERIAL"].includes(type)
        ? "/admin/settings"
        : ["ASSIGNMENT", "QUOTE"].includes(type)
          ? "/admin/quotes"
          : "/admin/products";
}
