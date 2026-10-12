import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, UserRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AssignmentForm, StatusAction } from "@/features/admin/admin-client";
import { getAdminFactory, getAdminPicklists } from "@/features/admin/service";
import { AdminShell, formatDate, formatMoney } from "@/features/admin/ui";
import { HardDeleteDangerZone } from "@/features/hard-delete/admin-client";
import { ApplicationError } from "@/lib/application/errors";

export default async function FactoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const requestHeaders = await headers();
  let factory;
  try {
    factory = await getAdminFactory(requestHeaders, id);
  } catch (error) {
    if (error instanceof ApplicationError && error.kind === "NOT_FOUND")
      notFound();
    throw error;
  }
  const picks = await getAdminPicklists(requestHeaders);
  return (
    <AdminShell
      title={factory.name}
      eyebrow="Factory detail"
      description={`${factory.contactName ?? "未填写联系人"} · ${factory.phone ?? "未填写电话"}`}
      actions={
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/admin/factories/${factory.id}/edit`}>
              <Pencil />
              编辑资料
            </Link>
          </Button>
        </div>
      }
    >
      <HardDeleteDangerZone targetType="FACTORY" targetId={factory.id}>
        <StatusAction
          kind="factory"
          id={factory.id}
          active={factory.status === "ACTIVE"}
        />
      </HardDeleteDangerZone>
      <div className="grid gap-6 xl:grid-cols-[minmax(18rem,.65fr)_minmax(0,1.35fr)]">
        <div className="grid content-start gap-5">
          <section className="rounded-xl border bg-surface p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">厂家资料</h2>
              <Badge
                variant={factory.status === "ACTIVE" ? "success" : "neutral"}
              >
                {factory.status === "ACTIVE" ? "启用" : "停用"}
              </Badge>
            </div>
            <dl className="mt-5 grid gap-4 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">联系人</dt>
                <dd className="mt-1">{factory.contactName ?? "未填写"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">联系电话</dt>
                <dd className="mt-1">{factory.phone ?? "未填写"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">内部备注</dt>
                <dd className="mt-1 leading-6 whitespace-pre-wrap">
                  {factory.notes ?? "未填写"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">最近更新</dt>
                <dd className="numeric mt-1">
                  {formatDate(factory.updatedAt)}
                </dd>
              </div>
            </dl>
          </section>
          <section className="rounded-xl border bg-surface">
            <div className="flex items-center gap-2 border-b p-5">
              <UserRound className="size-5 text-muted-foreground" />
              <div>
                <h2 className="font-semibold">关联账号</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  关联账号摘要；账号启停与永久删除请前往账号管理。
                </p>
              </div>
            </div>
            <div className="divide-y">
              {factory.users.length ? (
                factory.users.map((user) => (
                  <div
                    className="flex items-center justify-between gap-3 p-4"
                    key={user.id}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {user.username ?? user.name}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {user.name}
                      </p>
                    </div>
                    <Badge variant={user.banned ? "neutral" : "success"}>
                      {user.banned ? "已禁用" : "启用"}
                    </Badge>
                  </div>
                ))
              ) : (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  尚无关联账号
                </p>
              )}
            </div>
          </section>
        </div>
        <section className="rounded-xl border bg-surface">
          <div className="border-b p-5">
            <h2 className="font-semibold">产品分配与报价</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              添加产品会复用既有分配关系；撤销不会删除历史。
            </p>
            <div className="mt-4">
              <AssignmentForm factoryId={factory.id} options={picks.products} />
            </div>
          </div>
          <div className="divide-y">
            {factory.assignments.length ? (
              factory.assignments.map((item) => (
                <div
                  className="grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  key={item.id}
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        className="font-medium hover:text-primary"
                        href={`/admin/products/${item.productId}`}
                      >
                        {item.product.sku ? `${item.product.sku} · ` : ""}
                        {item.product.name}
                      </Link>
                      <Badge
                        variant={
                          item.status === "ACTIVE" ? "success" : "neutral"
                        }
                      >
                        {item.status === "ACTIVE" ? "有效" : "已撤销"}
                      </Badge>
                    </div>
                    <p className="numeric mt-2 text-sm">
                      {item.quote
                        ? formatMoney(item.quote.priceCents)
                        : "未报价"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.product.category.name} ·{" "}
                      {item.product.material.name}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/admin/quotes/${item.id}`}>报价详情</Link>
                    </Button>
                    <StatusAction
                      kind="assignment"
                      id={item.id}
                      active={item.status === "ACTIVE"}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p className="p-8 text-center text-sm text-muted-foreground">
                尚未分配产品
              </p>
            )}
          </div>
        </section>
      </div>
    </AdminShell>
  );
}
