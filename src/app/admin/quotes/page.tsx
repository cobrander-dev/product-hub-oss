import { headers } from "next/headers";
import Link from "next/link";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatePanel } from "@/components/ui/feedback";
import { ExportActions } from "@/features/admin-operations/export-button";
import {
  getAdminPicklists,
  listAdminQuoteWorkspace,
} from "@/features/admin/service";
import {
  AdminShell,
  formatDate,
  formatMoney,
  ProductThumb,
} from "@/features/admin/ui";

export const dynamic = "force-dynamic";
const one = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const requestHeaders = await headers();
  const query = {
    page: one(raw.page) ?? "1",
    pageSize: 20,
    search: one(raw.search) ?? "",
    factoryId: one(raw.factoryId) || undefined,
    productId: one(raw.productId) || undefined,
    assignmentStatus: one(raw.assignmentStatus) || undefined,
    quoteStatus: one(raw.quoteStatus) || undefined,
    submittedFrom: one(raw.submittedFrom)
      ? new Date(`${one(raw.submittedFrom)}T00:00:00+08:00`).toISOString()
      : undefined,
    submittedTo: one(raw.submittedTo)
      ? new Date(`${one(raw.submittedTo)}T23:59:59.999+08:00`).toISOString()
      : undefined,
  };
  const [result, picks] = await Promise.all([
    listAdminQuoteWorkspace(requestHeaders, query),
    getAdminPicklists(requestHeaders),
  ]);
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value && key !== "page" && key !== "pageSize")
        params.set(key, String(value));
    });
    params.set("page", String(page));
    return `?${params}`;
  };
  const exportParams = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value && key !== "page" && key !== "pageSize")
      exportParams.set(key, String(value));
  });
  return (
    <AdminShell
      title="报价工作区"
      eyebrow="Quote operations"
      description="每条厂家分配都是一个报价任务；没有报价记录时明确显示待报价。"
      actions={
        <ExportActions
          baseEndpoint={`/api/exports/factory-quotes?${exportParams}`}
          count={result.exportableTotal}
          scopeLabel="当前筛选中的已提交报价"
        />
      }
    >
      <form
        className="grid gap-3 rounded-xl border bg-surface p-4 sm:grid-cols-2 xl:grid-cols-4"
        method="get"
      >
        <label className="relative">
          <span className="sr-only">搜索报价</span>
          <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            defaultValue={query.search}
            name="search"
            placeholder="产品、SKU 或厂家"
          />
        </label>
        <select
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          name="factoryId"
          defaultValue={query.factoryId ?? ""}
        >
          <option value="">全部厂家</option>
          {picks.factories.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <label className="text-xs text-muted-foreground">
          提交开始
          <input
            className="mt-1 block h-11 w-full rounded-md border bg-surface px-3 text-sm text-foreground"
            defaultValue={one(raw.submittedFrom) ?? ""}
            name="submittedFrom"
            type="date"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          提交结束
          <input
            className="mt-1 block h-11 w-full rounded-md border bg-surface px-3 text-sm text-foreground"
            defaultValue={one(raw.submittedTo) ?? ""}
            name="submittedTo"
            type="date"
          />
        </label>
        <select
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          name="quoteStatus"
          defaultValue={query.quoteStatus ?? ""}
        >
          <option value="">全部报价状态</option>
          <option value="PENDING">待报价</option>
          <option value="SUBMITTED">已提交</option>
        </select>
        <select
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          name="assignmentStatus"
          defaultValue={query.assignmentStatus ?? ""}
        >
          <option value="">全部分配状态</option>
          <option value="ACTIVE">有效</option>
          <option value="REVOKED">已撤销</option>
        </select>
        <Button type="submit" variant="secondary">
          筛选
        </Button>
      </form>
      <p className="mt-4 text-sm text-muted-foreground">
        共{" "}
        <span className="numeric font-semibold text-foreground">
          {result.total}
        </span>{" "}
        个报价任务
      </p>
      {!result.items.length ? (
        <div className="mt-5">
          <StatePanel
            type={
              query.search || query.factoryId || query.quoteStatus
                ? "search"
                : "empty"
            }
            title="没有匹配报价任务"
            description="调整搜索或筛选条件后重试。"
          />
        </div>
      ) : (
        <div className="mt-5 overflow-hidden rounded-xl border bg-surface">
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[1180px] text-left text-sm">
              <thead className="bg-surface-muted text-[11px] tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="p-4">产品</th>
                  <th className="p-4">厂家</th>
                  <th className="p-4">报价状态</th>
                  <th className="p-4">现价</th>
                  <th className="p-4">MOQ</th>
                  <th className="p-4">包装 cm</th>
                  <th className="p-4">CBM m³</th>
                  <th className="p-4">净重 / 毛重 kg</th>
                  <th className="p-4">PCS/箱</th>
                  <th className="p-4">更新</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {result.items.map((item) => (
                  <tr className="hover:bg-surface-muted/60" key={item.id}>
                    <td className="p-4">
                      <Link
                        className="flex items-center gap-3"
                        href={`/admin/quotes/${item.id}`}
                      >
                        <ProductThumb
                          src={item.product.imageUrl}
                          alt={`${item.product.name}主图`}
                        />
                        <span>
                          <span className="block font-medium">
                            {item.product.name}
                          </span>
                          <span className="mt-1 block font-mono text-xs text-muted-foreground">
                            {item.product.sku ?? "无 SKU"}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="p-4">{item.factory.name}</td>
                    <td className="p-4">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant={item.quote ? "info" : "warning"}>
                          {item.quote ? "已提交" : "待报价"}
                        </Badge>
                        {item.status === "REVOKED" ? (
                          <Badge>已撤销</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="numeric p-4 font-semibold">
                      {formatMoney(item.quote?.priceCents ?? null)}
                    </td>
                    <td className="numeric p-4">{item.quote?.moq ?? "—"}</td>
                    <td className="numeric p-4">
                      {item.quote
                        ? [
                            item.quote.packingLengthCm,
                            item.quote.packingWidthCm,
                            item.quote.packingHeightCm,
                          ]
                            .map((part) => part ?? "—")
                            .join(" × ")
                        : "—"}
                    </td>
                    <td className="numeric p-4">
                      {item.quote?.cbmM3
                        ? Number(item.quote.cbmM3).toFixed(4)
                        : "—"}
                    </td>
                    <td className="numeric p-4">
                      {item.quote
                        ? `${item.quote.netWeightKg ?? "—"} / ${item.quote.grossWeightKg ?? "—"}`
                        : "—"}
                    </td>
                    <td className="numeric p-4">
                      {item.quote?.pcsPerCarton ?? "—"}
                    </td>
                    <td className="numeric p-4 text-xs text-muted-foreground">
                      {formatDate(item.quote?.updatedAt ?? item.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="divide-y md:hidden">
            {result.items.map((item) => (
              <Link
                className="flex gap-3 p-4"
                href={`/admin/quotes/${item.id}`}
                key={item.id}
              >
                <ProductThumb
                  src={item.product.imageUrl}
                  alt={`${item.product.name}主图`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate font-semibold">
                      {item.product.name}
                    </p>
                    <Badge variant={item.quote ? "info" : "warning"}>
                      {item.quote ? "已提交" : "待报价"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.factory.name}
                  </p>
                  <p className="numeric mt-2 text-sm font-semibold">
                    {formatMoney(item.quote?.priceCents ?? null)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
      {result.totalPages > 1 ? (
        <nav
          className="mt-6 flex items-center justify-between"
          aria-label="报价分页"
        >
          <Button
            asChild={result.page > 1}
            disabled={result.page <= 1}
            variant="outline"
          >
            {result.page > 1 ? (
              <Link href={pageHref(result.page - 1)}>上一页</Link>
            ) : (
              <span>上一页</span>
            )}
          </Button>
          <span className="numeric text-sm text-muted-foreground">
            第 {result.page} / {result.totalPages} 页
          </span>
          <Button
            asChild={result.page < result.totalPages}
            disabled={result.page >= result.totalPages}
            variant="outline"
          >
            {result.page < result.totalPages ? (
              <Link href={pageHref(result.page + 1)}>下一页</Link>
            ) : (
              <span>下一页</span>
            )}
          </Button>
        </nav>
      ) : null}
    </AdminShell>
  );
}
