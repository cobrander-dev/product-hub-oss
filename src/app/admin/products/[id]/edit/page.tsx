import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";
import { ProductForm } from "@/features/admin/admin-client";
import { getAdminPicklists, getAdminProduct } from "@/features/admin/service";
import { AdminShell } from "@/features/admin/ui";
import { ApplicationError } from "@/lib/application/errors";

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const requestHeaders = await headers();
  let product;
  try {
    product = await getAdminProduct(requestHeaders, id);
  } catch (error) {
    if (error instanceof ApplicationError && error.kind === "NOT_FOUND")
      notFound();
    throw error;
  }
  const picks = await getAdminPicklists(requestHeaders);
  return (
    <AdminShell
      title="编辑产品"
      eyebrow="Product operations"
      description={`${product.sku ?? "无 SKU"} · ${product.name}`}
    >
      <Card className="max-w-4xl">
        <CardContent className="p-5 sm:p-7">
          <ProductForm
            product={{
              id: product.id,
              sku: product.sku,
              name: product.name,
              categoryId: product.categoryId,
              materialId: product.materialId,
              status: product.status,
              notes: product.notes,
            }}
            categories={picks.categories}
            materials={picks.materials}
          />
        </CardContent>
      </Card>
    </AdminShell>
  );
}
