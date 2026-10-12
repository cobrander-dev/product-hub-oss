import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, ImageIcon, Pencil, Scale } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AssignmentForm,
  ImageManager,
  PromoteImageButton,
  StatusAction,
} from "@/features/admin/admin-client";
import { getAdminPicklists, getAdminProduct } from "@/features/admin/service";
import {
  AdminShell,
  formatDate,
  formatMoney,
  ProductThumb,
} from "@/features/admin/ui";
import { HardDeleteDangerZone } from "@/features/hard-delete/admin-client";
import { ApplicationError } from "@/lib/application/errors";

export const dynamic = "force-dynamic";

export default async function ProductDetailPage({
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
  const submitted = product.assignments.filter((item) => item.quote);
  return (
    <AdminShell
      title={product.name}
      eyebrow="Product detail"
      description={`${product.sku ?? "无 SKU"} · ${product.category.name} · ${product.material.name}`}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href={`/admin/products/${product.id}/edit`}>
              <Pencil />
              编辑资料
            </Link>
          </Button>
        </div>
      }
    >
      <HardDeleteDangerZone targetType="PRODUCT" targetId={product.id}>
        <StatusAction
          kind="product"
          id={product.id}
          active={product.status === "ENABLED"}
        />
      </HardDeleteDangerZone>
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(18rem,.72fr)_minmax(0,1.28fr)]">
        <div className="grid min-w-0 content-start gap-5">
          <ProductThumb
            large
            src={product.image?.url ?? null}
            alt={`${product.name}主图`}
          />
          <Card>
            <CardContent className="grid gap-5 p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">产品主图</h2>
                <Badge variant={product.image ? "success" : "warning"}>
                  {product.image
                    ? `${product.image.width} × ${product.image.height}`
                    : "待上传"}
                </Badge>
              </div>
              <ImageManager
                productId={product.id}
                hasImage={Boolean(product.image)}
              />
              {product.image && (
                <HardDeleteDangerZone
                  targetType="PRODUCT_MAIN_IMAGE"
                  targetId={product.image.id}
                />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5">
              <h2 className="font-semibold">基础资料</h2>
              <dl className="mt-4 grid gap-4 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">状态</dt>
                  <dd className="mt-1">
                    <Badge
                      variant={
                        product.status === "ENABLED" ? "success" : "neutral"
                      }
                    >
                      {product.status === "ENABLED" ? "启用" : "停用"}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">内部备注</dt>
                  <dd className="mt-1 max-h-48 overflow-auto leading-6 break-words whitespace-pre-wrap">
                    {product.notes || "未填写"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">最近更新</dt>
                  <dd className="numeric mt-1">
                    {formatDate(product.updatedAt)}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <section className="min-w-0 rounded-xl border bg-surface">
            <div className="border-b p-5">
              <div className="flex items-center gap-2">
                <Building2 className="size-5 text-muted-foreground" />
                <h2 className="font-semibold">厂家分配</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                选择厂家建立分配；撤销会保留报价、历史和私图。
              </p>
              <div className="mt-4">
                <AssignmentForm
                  productId={product.id}
                  options={picks.factories}
                />
              </div>
            </div>
            <div className="divide-y">
              {product.assignments.length ? (
                product.assignments.map((item) => (
                  <div
                    className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                    key={item.id}
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          className="font-medium hover:text-primary"
                          href={`/admin/factories/${item.factoryId}`}
                        >
                          {item.factory.name}
                        </Link>
                        <Badge
                          variant={
                            item.status === "ACTIVE" ? "success" : "neutral"
                          }
                        >
                          {item.status === "ACTIVE" ? "有效" : "已撤销"}
                        </Badge>
                        <Badge variant={item.quote ? "info" : "warning"}>
                          {item.quote ? "已报价" : "待报价"}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        分配于 {formatDate(item.assignedAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/quotes/${item.id}`}>查看报价</Link>
                      </Button>
                      <HardDeleteDangerZone
                        targetType="ASSIGNMENT"
                        targetId={item.id}
                      >
                        <StatusAction
                          kind="assignment"
                          id={item.id}
                          active={item.status === "ACTIVE"}
                        />
                      </HardDeleteDangerZone>
                    </div>
                  </div>
                ))
              ) : (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  尚未分配厂家
                </p>
              )}
            </div>
          </section>
          <section className="min-w-0 overflow-hidden rounded-xl border bg-surface">
            <div className="flex items-center justify-between border-b p-5">
              <div>
                <div className="flex items-center gap-2">
                  <Scale className="size-5 text-muted-foreground" />
                  <h2 className="font-semibold">多厂家报价比较</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  同一产品的现价、MOQ、包装与重量并排核对。
                </p>
              </div>
              <Badge variant="info">{submitted.length} 份报价</Badge>
            </div>
            {submitted.length ? (
              <div className="max-w-full overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="bg-surface-muted text-[11px] tracking-wide text-muted-foreground uppercase">
                    <tr>
                      <th className="p-4">厂家</th>
                      <th className="p-4">价格</th>
                      <th className="p-4">MOQ</th>
                      <th className="p-4">包装 cm</th>
                      <th className="p-4">净重 / 毛重 kg</th>
                      <th className="p-4">更新</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {submitted.map((item) => (
                      <tr key={item.id}>
                        <td className="p-4">
                          <Link
                            className="font-medium hover:text-primary"
                            href={`/admin/quotes/${item.id}`}
                          >
                            {item.factory.name}
                          </Link>
                        </td>
                        <td className="numeric p-4 font-semibold">
                          {formatMoney(item.quote!.priceCents)}
                        </td>
                        <td className="numeric p-4">
                          {item.quote!.moq ?? "—"}
                        </td>
                        <td className="numeric p-4">
                          {[
                            item.quote!.packingLengthCm,
                            item.quote!.packingWidthCm,
                            item.quote!.packingHeightCm,
                          ]
                            .map((value) => value ?? "—")
                            .join(" × ")}
                        </td>
                        <td className="numeric p-4">
                          {item.quote!.netWeightKg ?? "—"} /{" "}
                          {item.quote!.grossWeightKg ?? "—"}
                        </td>
                        <td className="numeric p-4 text-xs text-muted-foreground">
                          {formatDate(item.quote!.updatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="p-8 text-center text-sm text-muted-foreground">
                已分配厂家尚未提交报价
              </p>
            )}
          </section>
          <section className="min-w-0 rounded-xl border bg-surface">
            <div className="flex items-center gap-2 border-b p-5">
              <ImageIcon className="size-5 text-muted-foreground" />
              <div>
                <h2 className="font-semibold">厂家私图</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  管理员可查看并复制设为产品主图。
                </p>
              </div>
            </div>
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
              {product.assignments
                .filter((item) => item.privateImage)
                .map((item) => (
                  <figure
                    className="overflow-hidden rounded-lg border"
                    key={item.id}
                  >
                    <ProductThumb
                      large
                      src={item.privateImage!.url}
                      alt={`${item.factory.name}上传的私图`}
                    />
                    <figcaption className="flex items-center justify-between gap-3 p-3">
                      <span className="truncate text-xs font-medium">
                        {item.factory.name}
                      </span>
                      <PromoteImageButton
                        productId={product.id}
                        imageId={item.privateImage!.id}
                      />
                    </figcaption>
                  </figure>
                ))}
              {!product.assignments.some((item) => item.privateImage) ? (
                <p className="col-span-full py-5 text-center text-sm text-muted-foreground">
                  尚无厂家私图
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </AdminShell>
  );
}
