import { headers } from "next/headers";
import Link from "next/link";
import { Plus, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatePanel } from "@/components/ui/feedback";
import { listAdminFactories } from "@/features/admin/service";
import { AdminShell, formatDate } from "@/features/admin/ui";

export const dynamic = "force-dynamic";
const one = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default async function FactoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const query = {
    page: one(raw.page) ?? "1",
    pageSize: 20,
    search: one(raw.search) ?? "",
    status: one(raw.status) || undefined,
  };
  const result = await listAdminFactories(await headers(), query);
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (query.search) params.set("search", query.search);
    if (query.status) params.set("status", query.status);
    params.set("page", String(page));
    return `?${params}`;
  };
  return (
    <AdminShell
      title="厂家"
      eyebrow="Factory operations"
      description="维护厂家联系资料，查看账号、产品分配和报价覆盖。"
      actions={
        <Button asChild>
          <Link href="/admin/factories/new">
            <Plus />
            新建厂家
          </Link>
        </Button>
      }
    >
      <form
        className="grid gap-3 rounded-xl border bg-surface p-4 sm:grid-cols-[minmax(14rem,1fr)_12rem_auto]"
        method="get"
      >
        <label className="relative">
          <span className="sr-only">搜索厂家</span>
          <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            defaultValue={query.search}
            name="search"
            placeholder="名称、联系人或电话"
          />
        </label>
        <select
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.status ?? ""}
          name="status"
        >
          <option value="">全部状态</option>
          <option value="ACTIVE">启用</option>
          <option value="DISABLED">停用</option>
        </select>
        <Button type="submit" variant="secondary">
          筛选
        </Button>
      </form>
      {!result.items.length ? (
        <div className="mt-5">
          <StatePanel
            type={query.search || query.status ? "search" : "empty"}
            title="没有匹配厂家"
            description="请调整筛选，或创建一个新厂家。"
          />
        </div>
      ) : (
        <div className="mt-5 overflow-hidden rounded-xl border bg-surface">
          <table className="hidden w-full text-left text-sm md:table">
            <thead className="bg-surface-muted text-[11px] tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="p-4">厂家</th>
                <th className="p-4">联系人</th>
                <th className="p-4">有效分配</th>
                <th className="p-4">已报价</th>
                <th className="p-4">账号</th>
                <th className="p-4">状态</th>
                <th className="p-4">更新</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {result.items.map((item) => (
                <tr key={item.id} className="hover:bg-surface-muted/60">
                  <td className="p-4">
                    <Link
                      className="font-semibold hover:text-primary"
                      href={`/admin/factories/${item.id}`}
                    >
                      {item.name}
                    </Link>
                  </td>
                  <td className="p-4">
                    <p>{item.contactName ?? "—"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.phone ?? "未填写电话"}
                    </p>
                  </td>
                  <td className="numeric p-4">{item.activeAssignmentCount}</td>
                  <td className="numeric p-4">{item.quotedCount}</td>
                  <td className="numeric p-4">{item.userCount}</td>
                  <td className="p-4">
                    <Badge
                      variant={item.status === "ACTIVE" ? "success" : "neutral"}
                    >
                      {item.status === "ACTIVE" ? "启用" : "停用"}
                    </Badge>
                  </td>
                  <td className="numeric p-4 text-xs text-muted-foreground">
                    {formatDate(item.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="divide-y md:hidden">
            {result.items.map((item) => (
              <Link
                className="block p-4"
                href={`/admin/factories/${item.id}`}
                key={item.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{item.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.contactName ?? "未填写联系人"} ·{" "}
                      {item.phone ?? "未填写电话"}
                    </p>
                  </div>
                  <Badge
                    variant={item.status === "ACTIVE" ? "success" : "neutral"}
                  >
                    {item.status === "ACTIVE" ? "启用" : "停用"}
                  </Badge>
                </div>
                <p className="numeric mt-3 text-xs text-muted-foreground">
                  {item.activeAssignmentCount} 个分配 · {item.quotedCount}{" "}
                  份报价 · {item.userCount} 个账号
                </p>
              </Link>
            ))}
          </div>
        </div>
      )}
      {result.totalPages > 1 ? (
        <nav
          className="mt-6 flex items-center justify-between"
          aria-label="厂家分页"
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
