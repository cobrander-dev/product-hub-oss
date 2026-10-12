import { headers } from "next/headers";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CreateFactoryUser,
  FactoryUserActions,
} from "@/features/admin-operations/users-client";
import { listAdminFactoryUsers } from "@/features/admin-operations/service";
import { AdminShell, formatDate } from "@/features/admin/ui";

export const dynamic = "force-dynamic";
const one = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const query = {
    page: one(raw.page) ?? "1",
    pageSize: 20,
    search: one(raw.search) ?? "",
    factoryId: one(raw.factoryId) || undefined,
    status: one(raw.status) || undefined,
  };
  const result = await listAdminFactoryUsers(await headers(), query);
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value && key !== "page" && key !== "pageSize")
        params.set(key, String(value));
    });
    params.set("page", String(page));
    return `?${params}`;
  };
  return (
    <AdminShell
      title="厂家用户"
      eyebrow="Access operations"
      description="创建并管理厂家登录账号；停用、密码重置会撤销既有会话。"
      actions={<CreateFactoryUser factories={result.factories} />}
    >
      <form
        className="grid gap-3 rounded-xl border bg-surface p-4 lg:grid-cols-[minmax(14rem,1fr)_minmax(10rem,.45fr)_minmax(9rem,.35fr)_auto]"
        method="get"
      >
        <Input
          defaultValue={query.search}
          name="search"
          placeholder="搜索用户名"
        />
        <select
          aria-label="厂家"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.factoryId ?? ""}
          name="factoryId"
        >
          <option value="">全部厂家</option>
          {result.factories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <select
          aria-label="用户状态"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={query.status ?? ""}
          name="status"
        >
          <option value="">全部状态</option>
          <option value="ENABLED">启用</option>
          <option value="DISABLED">停用</option>
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
        个厂家用户
      </p>
      <div className="mt-5 overflow-hidden rounded-xl border bg-surface">
        <table className="hidden w-full text-left text-sm md:table">
          <thead className="bg-surface-muted text-xs text-muted-foreground">
            <tr>
              <th className="p-4">用户名</th>
              <th className="p-4">厂家</th>
              <th className="p-4">账号 / 厂家状态</th>
              <th className="p-4">创建时间</th>
              <th className="p-4">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {result.items.map((item) => (
              <tr key={item.id}>
                <td className="p-4 font-medium">{item.username ?? "—"}</td>
                <td className="p-4">{item.factory?.name ?? "未绑定"}</td>
                <td className="p-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={item.banned ? "danger" : "success"}>
                      {item.banned ? "账号已停用" : "账号启用"}
                    </Badge>
                    <Badge
                      variant={
                        item.factory?.status === "ACTIVE"
                          ? "neutral"
                          : "warning"
                      }
                    >
                      {item.factory?.status === "ACTIVE"
                        ? "厂家启用"
                        : "厂家已停用"}
                    </Badge>
                  </div>
                </td>
                <td className="p-4 text-xs text-muted-foreground">
                  {formatDate(item.createdAt)}
                </td>
                <td className="p-4">
                  <FactoryUserActions user={item} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="divide-y md:hidden">
          {result.items.map((item) => (
            <article className="space-y-3 p-4" key={item.id}>
              <div className="flex items-center justify-between">
                <p className="font-medium">{item.username ?? "—"}</p>
                <Badge variant={item.banned ? "danger" : "success"}>
                  {item.banned ? "账号已停用" : "账号启用"}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {item.factory?.name ?? "未绑定厂家"}
              </p>
              <Badge
                variant={
                  item.factory?.status === "ACTIVE" ? "neutral" : "warning"
                }
              >
                {item.factory?.status === "ACTIVE" ? "厂家启用" : "厂家已停用"}
              </Badge>
              <FactoryUserActions user={item} />
            </article>
          ))}
        </div>
        {!result.items.length ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            没有匹配的厂家用户
          </p>
        ) : null}
      </div>
      {result.totalPages > 1 ? (
        <nav aria-label="分页" className="mt-5 flex justify-end gap-2">
          <Button asChild disabled={result.page <= 1} variant="outline">
            <Link
              aria-disabled={result.page <= 1}
              href={pageHref(Math.max(1, result.page - 1))}
            >
              上一页
            </Link>
          </Button>
          <Button
            asChild
            disabled={result.page >= result.totalPages}
            variant="outline"
          >
            <Link
              aria-disabled={result.page >= result.totalPages}
              href={pageHref(Math.min(result.totalPages, result.page + 1))}
            >
              下一页
            </Link>
          </Button>
        </nav>
      ) : null}
    </AdminShell>
  );
}
