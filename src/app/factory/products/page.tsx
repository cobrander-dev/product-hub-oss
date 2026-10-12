import { headers } from "next/headers";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import {
  getFactoryProductFilters,
  listFactoryProducts,
} from "@/features/factory/service";
import {
  FactoryProductImage,
  FactoryShell,
  formatMoney,
  requireFactoryPageActor,
} from "@/features/factory/ui";

export const dynamic = "force-dynamic";
type Query = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default async function FactoryProductsPage({
  searchParams,
}: {
  searchParams: Query;
}) {
  await requireFactoryPageActor();
  const raw = await searchParams;
  const requestHeaders = await headers();
  const query = {
    page: one(raw.page) ?? "1",
    pageSize: 12,
    search: one(raw.search) ?? "",
    quoteStatus: one(raw.quoteStatus) || undefined,
    categoryId: one(raw.categoryId) || undefined,
    materialId: one(raw.materialId) || undefined,
  };
  const [result, filters] = await Promise.all([
    listFactoryProducts(requestHeaders, query),
    getFactoryProductFilters(requestHeaders),
  ]);
  const href = (page: number) => {
    const params = new URLSearchParams();
    Object.entries(raw).forEach(([key, value]) => {
      const first = one(value);
      if (first && key !== "page" && key !== "notice") params.set(key, first);
    });
    params.set("page", String(page));
    return `?${params}`;
  };
  const filtered = Boolean(
    query.search || query.quoteStatus || query.categoryId || query.materialId,
  );
  return (
    <FactoryShell
      title="产品"
      eyebrow="Assigned products"
      description="查看当前分配给本厂的启用产品，并完成自己的报价资料。"
    >
      {one(raw.notice) === "unavailable" ? (
        <p
          className="mb-5 rounded-lg bg-warning-surface p-4 text-sm text-warning"
          role="status"
        >
          该产品当前不可访问，可能已被撤销分配或停用。
        </p>
      ) : null}
      <form
        className="grid gap-3 rounded-xl border bg-surface p-4 md:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_repeat(3,minmax(9rem,.45fr))_auto]"
        method="get"
      >
        <label className="relative md:col-span-2 xl:col-span-1">
          <span className="sr-only">搜索产品</span>
          <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            defaultValue={query.search}
            name="search"
            placeholder="搜索 SKU 或产品名称"
          />
        </label>
        <select
          aria-label="报价状态"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.quoteStatus ?? ""}
          name="quoteStatus"
        >
          <option value="">全部状态</option>
          <option value="pending">待填写</option>
          <option value="submitted">已提交</option>
        </select>
        <select
          aria-label="产品分类"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.categoryId ?? ""}
          name="categoryId"
        >
          <option value="">全部分类</option>
          {filters.categories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <select
          aria-label="产品材质"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.materialId ?? ""}
          name="materialId"
        >
          <option value="">全部材质</option>
          {filters.materials.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary">
          筛选
        </Button>
      </form>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          共{" "}
          <span className="numeric font-semibold text-foreground">
            {result.total}
          </span>{" "}
          个产品
        </p>
        {filtered ? (
          <Button asChild size="sm" variant="ghost">
            <Link href="/factory/products">清除筛选</Link>
          </Button>
        ) : null}
      </div>
      {!result.items.length ? (
        <div className="mt-5">
          <StatePanel
            type={filtered ? "search" : "empty"}
            title={filtered ? "没有匹配产品" : "目前没有分配给你的产品"}
            description={
              filtered
                ? "请调整搜索词或筛选条件。"
                : "产品分配后会自动出现在这里。"
            }
            action={
              filtered ? (
                <Button asChild variant="outline">
                  <Link href="/factory/products">清除筛选</Link>
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {result.items.map((item) => (
            <Link
              className="group min-w-0 overflow-hidden rounded-xl border bg-surface transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              href={`/factory/products/${item.product.id}`}
              key={item.id}
            >
              <FactoryProductImage
                alt={`${item.product.name}主图`}
                src={item.imageUrl}
              />
              <div className="grid gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {item.product.sku ?? "无 SKU"}
                  </p>
                  <h2 className="mt-1 line-clamp-2 min-h-12 leading-6 font-semibold group-hover:text-primary">
                    {item.product.name}
                  </h2>
                </div>
                <p className="text-xs text-muted-foreground">
                  {item.product.category.name} · {item.product.material.name}
                </p>
                <div className="flex items-center justify-between gap-3 border-t pt-3">
                  <Badge variant={item.quote ? "success" : "warning"}>
                    {item.quote ? "已提交" : "待填写"}
                  </Badge>
                  <span className="numeric text-sm font-semibold">
                    {formatMoney(item.quote?.priceCents ?? null)}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
      {result.totalPages > 1 ? (
        <nav
          aria-label="产品分页"
          className="mt-7 flex items-center justify-center gap-3"
        >
          <Button
            asChild={result.page > 1}
            disabled={result.page <= 1}
            size="sm"
            variant="outline"
          >
            {result.page > 1 ? (
              <Link href={href(result.page - 1)}>
                <ChevronLeft />
                上一页
              </Link>
            ) : (
              <span>
                <ChevronLeft />
                上一页
              </span>
            )}
          </Button>
          <span className="numeric text-sm text-muted-foreground">
            {result.page} / {result.totalPages}
          </span>
          <Button
            asChild={result.page < result.totalPages}
            disabled={result.page >= result.totalPages}
            size="sm"
            variant="outline"
          >
            {result.page < result.totalPages ? (
              <Link href={href(result.page + 1)}>
                下一页
                <ChevronRight />
              </Link>
            ) : (
              <span>
                下一页
                <ChevronRight />
              </span>
            )}
          </Button>
        </nav>
      ) : null}
    </FactoryShell>
  );
}
