import { headers } from "next/headers";

import { listRecentProductImports } from "@/features/admin-operations/service";
import { ImportWorkspace } from "@/features/admin-operations/import-client";
import { AdminShell } from "@/features/admin/ui";

export const dynamic = "force-dynamic";

export default async function ProductImportPage() {
  const recent = await listRecentProductImports(await headers());
  return (
    <AdminShell
      title="导入产品"
      eyebrow="Product import"
      description="使用固定模板生成逐行预览；只有管理员确认后才会写入产品资料。"
    >
      <ImportWorkspace recent={recent} />
    </AdminShell>
  );
}
