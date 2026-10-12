import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PromoteImageButton } from "@/features/admin/admin-client";
import { getAdminQuoteWorkspace } from "@/features/admin/service";
import {
  AdminShell,
  formatDate,
  formatMoney,
  ProductThumb,
} from "@/features/admin/ui";
import { HardDeleteDangerZone } from "@/features/hard-delete/admin-client";
import { ApplicationError } from "@/lib/application/errors";

const value = (input: string | number | null, suffix = "") =>
  input === null ? "—" : `${input}${suffix}`;

export default async function QuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string; quoteRecordId?: string }>;
}) {
  const { id, quoteRecordId } = await params;
  let item;
  try {
    item = await getAdminQuoteWorkspace(await headers(), id);
  } catch (error) {
    if (error instanceof ApplicationError && error.kind === "NOT_FOUND")
      notFound();
    throw error;
  }
  const quote = item.quote;
  if (quoteRecordId && quote?.id !== quoteRecordId) notFound();
  const facts = quote
    ? [
        ["含税单价", formatMoney(quote.priceCents)],
        ["MOQ", value(quote.moq, " PCS")],
        [
          "包装尺寸",
          `${value(quote.packingLengthCm)} × ${value(quote.packingWidthCm)} × ${value(quote.packingHeightCm)} cm`,
        ],
        [
          "CBM",
          value(quote.cbmM3 ? Number(quote.cbmM3).toFixed(4) : null, " m³"),
        ],
        ["净重", value(quote.netWeightKg, " kg")],
        ["毛重", value(quote.grossWeightKg, " kg")],
        ["每箱数量", value(quote.pcsPerCarton, " PCS")],
        ["首次提交", formatDate(quote.submittedAt)],
        ["最近更新", formatDate(quote.updatedAt)],
      ]
    : [];
  return (
    <AdminShell
      title={`${item.product.name} · ${item.factory.name}`}
      eyebrow="Quote detail"
      description="管理员只读查看厂家提交内容、私图与不可变价格历史。"
      actions={
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/admin/products/${item.productId}`}>产品详情</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/admin/factories/${item.factoryId}`}>厂家详情</Link>
          </Button>
          {quote && (
            <Button asChild variant="outline">
              <Link href={`/admin/quotes/records/${quote.id}`}>
                报价记录详情
              </Link>
            </Button>
          )}
        </div>
      }
    >
      {quote && <HardDeleteDangerZone targetType="QUOTE" targetId={quote.id} />}
      <HardDeleteDangerZone targetType="ASSIGNMENT" targetId={item.id} />
      {item.privateImage && (
        <HardDeleteDangerZone
          targetType="FACTORY_PRIVATE_IMAGE"
          targetId={item.privateImage.id}
        />
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(18rem,.65fr)_minmax(0,1.35fr)]">
        <div className="grid content-start gap-5">
          <ProductThumb
            large
            src={item.product.imageUrl}
            alt={`${item.product.name}主图`}
          />
          <section className="rounded-xl border bg-surface p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-mono text-xs text-muted-foreground">
                  {item.product.sku ?? "无 SKU"}
                </p>
                <h2 className="mt-1 font-semibold">{item.product.name}</h2>
              </div>
              <Badge variant={quote ? "info" : "warning"}>
                {quote ? "已提交" : "待报价"}
              </Badge>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              {item.product.category.name} · {item.product.material.name}
            </p>
            <p className="mt-2 text-sm">
              报价厂家：<span className="font-medium">{item.factory.name}</span>
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              分配状态：{item.status === "ACTIVE" ? "有效" : "已撤销"}
            </p>
          </section>
          {item.privateImage ? (
            <section className="overflow-hidden rounded-xl border bg-surface">
              <ProductThumb
                large
                src={item.privateImage.url}
                alt={`${item.factory.name}上传的私图`}
              />
              <div className="flex items-center justify-between gap-3 p-4">
                <div>
                  <h2 className="text-sm font-semibold">厂家私图</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.privateImage.width} × {item.privateImage.height}
                  </p>
                </div>
                <PromoteImageButton
                  productId={item.productId}
                  imageId={item.privateImage.id}
                />
              </div>
            </section>
          ) : (
            <section className="rounded-xl border border-dashed bg-surface-muted/40 p-8 text-center text-sm text-muted-foreground">
              厂家尚未上传私图
            </section>
          )}
        </div>
        <div className="grid content-start gap-6">
          {quote ? (
            <>
              <section className="rounded-xl border bg-surface">
                <div className="border-b p-5">
                  <h2 className="font-semibold">当前报价</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    版本 {quote.version}，所有派生值由服务端计算。
                  </p>
                </div>
                <dl className="grid sm:grid-cols-2 lg:grid-cols-3">
                  {facts.map(([label, fact]) => (
                    <div className="border-b p-5 sm:border-r" key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="numeric mt-2 text-sm font-semibold">
                        {fact}
                      </dd>
                    </div>
                  ))}
                </dl>
                {quote.factoryNotes ? (
                  <div className="p-5">
                    <p className="text-xs text-muted-foreground">厂家备注</p>
                    <p className="mt-2 text-sm leading-6 whitespace-pre-wrap">
                      {quote.factoryNotes}
                    </p>
                  </div>
                ) : null}
              </section>
              <section className="rounded-xl border bg-surface">
                <div className="border-b p-5">
                  <h2 className="font-semibold">价格历史</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    价格记录仅追加，不覆盖。
                  </p>
                </div>
                <div className="divide-y">
                  {quote.priceHistory.map((history) => (
                    <div
                      className="grid gap-2 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                      key={history.id}
                    >
                      <div>
                        <p className="numeric text-sm">
                          <span className="text-muted-foreground">
                            {formatMoney(history.oldPriceCents)}
                          </span>{" "}
                          →{" "}
                          <span className="font-semibold">
                            {formatMoney(history.newPriceCents)}
                          </span>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          操作人{" "}
                          {history.changedByUser
                            ? (history.changedByUser.username ??
                              history.changedByUser.name)
                            : "已永久删除用户"}
                        </p>
                      </div>
                      <time className="numeric text-xs text-muted-foreground">
                        {formatDate(history.changedAt)}
                      </time>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <section className="rounded-xl border border-dashed bg-warning-surface/45 p-10 text-center">
              <h2 className="font-semibold">等待厂家提交报价</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                当前没有 FactoryQuote 记录，因此价格、包装、重量与历史均为空。
              </p>
            </section>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
