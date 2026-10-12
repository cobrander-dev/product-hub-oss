import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Clock3, ImageIcon, PackageCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  FactoryPrivateImageManager,
  MainImagePreview,
  QuoteForm,
} from "@/features/factory/factory-client";
import { getFactoryProduct } from "@/features/factory/service";
import {
  FactoryProductImage,
  FactoryShell,
  formatDate,
  formatMoney,
  requireFactoryPageActor,
} from "@/features/factory/ui";
import { ApplicationError } from "@/lib/application/errors";

export const dynamic = "force-dynamic";

export default async function FactoryProductDetailPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  await requireFactoryPageActor();
  const { productId } = await params;
  let detail;
  try {
    detail = await getFactoryProduct(await headers(), productId);
  } catch (error) {
    if (
      error instanceof ApplicationError &&
      (error.kind === "NOT_FOUND" || error.kind === "VALIDATION")
    ) {
      redirect("/factory/products?notice=unavailable");
    }
    throw error;
  }
  const quote = detail.quote;
  return (
    <FactoryShell
      title={detail.product.name}
      eyebrow="Product & quote"
      description={`${detail.product.sku ?? "无 SKU"} · ${detail.product.category.name} · ${detail.product.material.name}`}
      actions={
        <Button asChild variant="outline">
          <Link href="/factory/products">
            <ArrowLeft />
            返回产品
          </Link>
        </Button>
      }
    >
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(18rem,.7fr)_minmax(0,1.3fr)]">
        <aside className="grid min-w-0 content-start gap-5">
          <FactoryProductImage
            large
            alt={`${detail.product.name}主图`}
            src={detail.product.imageUrl}
          />
          {detail.product.imageUrl ? (
            <MainImagePreview
              productName={detail.product.name}
              src={detail.product.imageUrl}
            />
          ) : null}
          <Card>
            <CardContent className="grid gap-4 p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">产品资料</h2>
                <Badge variant={quote ? "success" : "warning"}>
                  {quote ? "已提交" : "待填写"}
                </Badge>
              </div>
              <dl className="grid gap-4 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">SKU</dt>
                  <dd className="mt-1 font-mono break-all">
                    {detail.product.sku ?? "未填写"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">分类</dt>
                  <dd className="mt-1">{detail.product.category.name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">材质</dt>
                  <dd className="mt-1">{detail.product.material.name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">分配时间</dt>
                  <dd className="numeric mt-1">
                    {formatDate(detail.assignedAt)}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-4 p-5">
              <div className="flex items-center gap-2">
                <ImageIcon className="size-5 text-muted-foreground" />
                <div>
                  <h2 className="font-semibold">厂家图片</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    仅本厂与管理员可查看。
                  </p>
                </div>
              </div>
              <FactoryPrivateImageManager
                assignmentId={detail.id}
                image={detail.privateImage}
                productName={detail.product.name}
              />
            </CardContent>
          </Card>
        </aside>

        <div className="grid min-w-0 content-start gap-6">
          <section className="min-w-0 rounded-xl border bg-surface p-5 sm:p-6">
            <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b pb-5">
              <div>
                <div className="flex items-center gap-2">
                  <PackageCheck className="size-5 text-muted-foreground" />
                  <h2 className="font-semibold">我的报价资料</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {quote
                    ? `当前 ${formatMoney(quote.priceCents)} · 最后更新 ${formatDate(quote.updatedAt)}`
                    : "首次提交只要求填写有效人民币价格，其余字段可留空。"}
                </p>
              </div>
              <Badge variant={quote ? "success" : "warning"}>
                {quote ? "已提交" : "待填写"}
              </Badge>
            </div>
            <QuoteForm assignmentId={detail.id} quote={quote} />
          </section>

          <section className="min-w-0 rounded-xl border bg-surface">
            <div className="flex items-center justify-between gap-3 border-b p-5">
              <div className="flex items-center gap-2">
                <Clock3 className="size-5 text-muted-foreground" />
                <div>
                  <h2 className="font-semibold">价格历史</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    只显示本厂自己的价格变更，最新在前。
                  </p>
                </div>
              </div>
              {quote ? (
                <Badge variant="neutral">{quote.historyTotal} 条</Badge>
              ) : null}
            </div>
            {quote?.history.length ? (
              <ol className="divide-y">
                {quote.history.map((item, index) => (
                  <li
                    className="flex items-center justify-between gap-4 p-5"
                    key={item.id}
                  >
                    <div>
                      <p className="numeric font-semibold">
                        {formatMoney(item.newPriceCents)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        操作者：
                        {item.changedByUser
                          ? (item.changedByUser.username ??
                            item.changedByUser.name)
                          : "已永久删除用户"}
                      </p>
                    </div>
                    <div className="text-right">
                      {index === 0 ? <Badge variant="info">当前</Badge> : null}
                      <p className="numeric mt-1 text-xs text-muted-foreground">
                        {formatDate(item.changedAt)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="p-8 text-center text-sm text-muted-foreground">
                还没有价格历史，首次提交后会自动记录。
              </p>
            )}
            {quote && quote.historyTotal > quote.history.length ? (
              <p className="border-t p-4 text-center text-xs text-muted-foreground">
                当前显示最近 {quote.history.length} 条记录。
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </FactoryShell>
  );
}
