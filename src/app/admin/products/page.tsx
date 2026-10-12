import { headers } from "next/headers";
import Link from "next/link";
import { Grid2X2, List, Plus, Search, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatePanel } from "@/components/ui/feedback";
import { ExportActions } from "@/features/admin-operations/export-button";
import { getAdminPicklists, listAdminProducts } from "@/features/admin/service";
import {
  AdminShell,
  formatDate,
  formatMoney,
  ProductThumb,
} from "@/features/admin/ui";

export const dynamic = "force-dynamic";
type Query = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Query;
}) {
  const raw = await searchParams;
  const requestHeaders = await headers();
  const query = {
    page: one(raw.page) ?? "1",
    pageSize: 20,
    search: one(raw.search) ?? "",
    status: one(raw.status) || undefined,
    categoryId: one(raw.categoryId) || undefined,
    materialId: one(raw.materialId) || undefined,
    hasMainImage: one(raw.hasMainImage) || undefined,
    sortBy: one(raw.sortBy) ?? "updatedAt",
    sortDirection: one(raw.sortDirection) ?? "desc",
  };
  const [result, picks] = await Promise.all([
    listAdminProducts(requestHeaders, query),
    getAdminPicklists(requestHeaders),
  ]);
  const view = one(raw.view) === "gallery" ? "gallery" : "table";
  const exportParams = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value && key !== "page" && key !== "pageSize")
      exportParams.set(key, String(value));
  });
  const href = (page: number) => {
    const params = new URLSearchParams();
    Object.entries(raw).forEach(([key, value]) => {
      const first = one(value);
      if (first && key !== "page") params.set(key, first);
    });
    params.set("page", String(page));
    return `?${params}`;
  };
  return (
    <AdminShell
      title="产品"
      eyebrow="Product operations"
      description="搜索、筛选并维护产品资料、主图、厂家分配和报价比较。"
      actions={
        <div className="flex flex-wrap items-start gap-2">
          <ExportActions
            baseEndpoint={`/api/exports/products?${exportParams}`}
            count={result.total}
          />
          <Button asChild variant="outline">
            <Link href="/admin/products/import">
              <Upload />
              导入
            </Link>
          </Button>
          <Button asChild>
            <Link href="/admin/products/new">
              <Plus />
              新建产品
            </Link>
          </Button>
        </div>
      }
    >
      <form
        className="grid gap-3 rounded-xl border bg-surface p-4 sm:grid-cols-2 xl:grid-cols-4"
        method="get"
      >
        <label className="relative">
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
          aria-label="主图状态"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.hasMainImage ?? ""}
          name="hasMainImage"
        >
          <option value="">全部主图</option>
          <option value="true">有主图</option>
          <option value="false">无主图</option>
        </select>
        <select
          aria-label="产品状态"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.status ?? ""}
          name="status"
        >
          <option value="">全部状态</option>
          <option value="ENABLED">启用</option>
          <option value="DISABLED">停用</option>
        </select>
        <select
          aria-label="产品分类"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.categoryId ?? ""}
          name="categoryId"
        >
          <option value="">全部分类</option>
          {picks.categories.map((item) => (
            <option value={item.id} key={item.id}>
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
          {picks.materials.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <select
          aria-label="排序字段"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.sortBy}
          name="sortBy"
        >
          <option value="updatedAt">更新时间</option>
          <option value="name">产品名称</option>
          <option value="sku">SKU</option>
        </select>
        <select
          aria-label="排序方向"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.sortDirection}
          name="sortDirection"
        >
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
        <input type="hidden" name="view" value={view} />
        <Button type="submit" variant="secondary">
          筛选
        </Button>
      </form>
      <div className="mt-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          共{" "}
          <span className="numeric font-semibold text-foreground">
            {result.total}
          </span>{" "}
          个产品
        </p>
        <div className="flex rounded-md border bg-surface p-1">
          <Button
            asChild
            className="h-8 px-2.5"
            size="sm"
            variant={view === "table" ? "secondary" : "ghost"}
          >
            <Link
              aria-label="表格视图"
              href={href(result.page).replace(/view=[^&]+&?/, "")}
            >
              <List />
            </Link>
          </Button>
          <Button
            asChild
            className="h-8 px-2.5"
            size="sm"
            variant={view === "gallery" ? "secondary" : "ghost"}
          >
            <Link
              aria-label="画廊视图"
              href={`${href(result.page)}&view=gallery`}
            >
              <Grid2X2 />
            </Link>
          </Button>
        </div>
      </div>
      {!result.items.length ? (
        <div className="mt-5">
          <StatePanel
            type={
              query.search ||
              query.status ||
              query.categoryId ||
              query.materialId ||
              query.hasMainImage
                ? "search"
                : "empty"
            }
            title={query.search ? "没有匹配产品" : "还没有产品"}
            description={
              query.search
                ? "请调整搜索词或筛选条件。"
                : "创建第一个产品后即可开始分配厂家。"
            }
            action={
              <Button asChild variant="outline">
                <Link href="/admin/products/new">新建产品</Link>
              </Button>
            }
          />
        </div>
      ) : null}
      {result.items.length && view === "table" ? (
        <div className="mt-5 overflow-x-auto rounded-xl border bg-surface">
          <table className="hidden w-full min-w-[900px] table-fixed text-left text-sm md:table">
            <thead className="bg-surface-muted text-[11px] tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-3">产品</th>
                <th className="px-4 py-3">分类 / 材质</th>
                <th className="px-4 py-3">厂家 / 报价</th>
                <th className="px-4 py-3">价格范围</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">更新时间</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {result.items.map((item) => (
                <tr className="hover:bg-surface-muted/60" key={item.id}>
                  <td className="px-4 py-3">
                    <Link
                      className="flex min-w-0 items-center gap-3"
                      href={`/admin/products/${item.id}`}
                    >
                      <ProductThumb
                        src={item.image?.url ?? null}
                        alt={`${item.name}主图`}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {item.name}
                        </span>
                        <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                          {item.sku ?? "无 SKU"}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {item.category.name}
                    <br />
                    {item.material.name}
                  </td>
                  <td className="numeric px-4 py-3">
                    {item.assignmentCount} / {item.quotedCount}
                  </td>
                  <td className="numeric px-4 py-3">
                    {item.priceMinCents
                      ? `${formatMoney(item.priceMinCents)}${item.priceMaxCents !== item.priceMinCents ? ` – ${formatMoney(item.priceMaxCents)}` : ""}`
                      : "未报价"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={
                        item.status === "ENABLED" ? "success" : "neutral"
                      }
                    >
                      {item.status === "ENABLED" ? "启用" : "停用"}
                    </Badge>
                  </td>
                  <td className="numeric px-4 py-3 text-xs text-muted-foreground">
                    {formatDate(item.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="divide-y md:hidden">
            {result.items.map((item) => (
              <Link
                className="flex gap-3 p-4"
                href={`/admin/products/${item.id}`}
                key={item.id}
              >
                <ProductThumb
                  src={item.image?.url ?? null}
                  alt={`${item.name}主图`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-semibold">
                      {item.name}
                    </p>
                    <Badge
                      variant={
                        item.status === "ENABLED" ? "success" : "neutral"
                      }
                    >
                      {item.status === "ENABLED" ? "启用" : "停用"}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {item.sku ?? "无 SKU"}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {item.category.name} · {item.material.name} ·{" "}
                    {item.assignmentCount} 家厂家
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
      {result.items.length && view === "gallery" ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {result.items.map((item) => (
            <Link
              className="overflow-hidden rounded-xl border bg-surface transition-colors hover:border-border-strong"
              href={`/admin/products/${item.id}`}
              key={item.id}
            >
              <ProductThumb
                large
                src={item.image?.url ?? null}
                alt={`${item.name}主图`}
              />
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold">
                      {item.name}
                    </h2>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {item.sku ?? "无 SKU"}
                    </p>
                  </div>
                  <Badge
                    variant={item.status === "ENABLED" ? "success" : "neutral"}
                  >
                    {item.status === "ENABLED" ? "启用" : "停用"}
                  </Badge>
                </div>
                <p className="mt-4 text-xs text-muted-foreground">
                  {item.category.name} · {item.material.name}
                </p>
                <p className="numeric mt-2 text-sm font-medium">
                  {item.priceMinCents
                    ? formatMoney(item.priceMinCents)
                    : "未报价"}
                </p>
              </div>
            </Link>
          ))}
        </div>
      ) : null}
      {result.totalPages > 1 ? (
        <nav
          aria-label="产品分页"
          className="mt-6 flex items-center justify-between"
        >
          <Button
            asChild={result.page > 1}
            disabled={result.page <= 1}
            variant="outline"
          >
            {result.page > 1 ? (
              <Link href={href(result.page - 1)}>上一页</Link>
            ) : (
              <span>上一页</span>
            )}
          </Button>
          <p className="numeric text-sm text-muted-foreground">
            第 {result.page} / {result.totalPages} 页
          </p>
          <Button
            asChild={result.page < result.totalPages}
            disabled={result.page >= result.totalPages}
            variant="outline"
          >
            {result.page < result.totalPages ? (
              <Link href={href(result.page + 1)}>下一页</Link>
            ) : (
              <span>下一页</span>
            )}
          </Button>
        </nav>
      ) : null}
    </AdminShell>
  );
}
