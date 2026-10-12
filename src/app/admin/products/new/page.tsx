import { headers } from "next/headers";

import { Card, CardContent } from "@/components/ui/card";
import { ProductForm } from "@/features/admin/admin-client";
import { getAdminPicklists } from "@/features/admin/service";
import { AdminShell } from "@/features/admin/ui";

export default async function NewProductPage() {
  const picks = await getAdminPicklists(await headers());
  return (
    <AdminShell
      title="新建产品"
      eyebrow="Product operations"
      description="建立产品基础资料；厂家分配和主图可在创建后继续维护。"
    >
      <Card className="max-w-4xl">
        <CardContent className="p-5 sm:p-7">
          <ProductForm
            categories={picks.categories}
            materials={picks.materials}
          />
        </CardContent>
      </Card>
    </AdminShell>
  );
}
