import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowRight,
  Boxes,
  CircleCheck,
  Clock3,
  RefreshCcw,
} from "lucide-react";

import { PasswordForm } from "@/app/factory/password-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatePanel } from "@/components/ui/feedback";
import { getFactoryDashboard } from "@/features/factory/service";
import {
  FactoryShell,
  formatDate,
  formatMoney,
  requireFactoryPageActor,
} from "@/features/factory/ui";
import { AuthorizationError } from "@/lib/auth/context";
import { resolveFactoryTenant } from "@/lib/auth/tenant-policy";

export const dynamic = "force-dynamic";

export default async function FactoryPage({
  searchParams,
}: {
  searchParams: Promise<{ factoryId?: string }>;
}) {
  const actor = await requireFactoryPageActor();
  try {
    resolveFactoryTenant(actor, (await searchParams).factoryId);
  } catch (error) {
    if (error instanceof AuthorizationError && error.kind === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }
  const dashboard = await getFactoryDashboard(await headers());
  const metrics = [
    { label: "已分配产品", value: dashboard.total, icon: Boxes },
    { label: "待填写", value: dashboard.pending, icon: Clock3 },
    { label: "已提交", value: dashboard.submitted, icon: CircleCheck },
  ];
  return (
    <FactoryShell
      title="厂家概览"
      eyebrow="Factory workspace"
      description={`${dashboard.factoryName} 的产品与报价进度。这里只展示当前厂家自己的数据。`}
      actions={
        <Button asChild>
          <Link href="/factory/products?quoteStatus=pending">
            查看待填写产品
            <ArrowRight />
          </Link>
        </Button>
      }
    >
      <p className="mb-5 text-sm text-muted-foreground">
        当前厂家：
        <span
          className="font-medium text-foreground"
          data-testid="factory-name"
        >
          {dashboard.factoryName}
        </span>
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <Card key={metric.label}>
              <CardContent className="flex items-center justify-between gap-4 p-5">
                <div>
                  <p className="text-sm text-muted-foreground">
                    {metric.label}
                  </p>
                  <p className="numeric mt-2 text-3xl font-semibold">
                    {metric.value}
                  </p>
                </div>
                <span className="inline-flex size-11 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Icon className="size-5" />
                </span>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <section className="mt-7 rounded-xl border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
          <div>
            <h2 className="font-semibold">最近更新</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              最近提交或更新的本厂报价。
            </p>
          </div>
          <Button asChild size="sm" variant="ghost">
            <Link href="/factory/products?quoteStatus=submitted">查看全部</Link>
          </Button>
        </div>
        {dashboard.recent.length ? (
          <div className="divide-y">
            {dashboard.recent.map((item) => (
              <Link
                className="flex min-h-16 items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-muted/60"
                href={`/factory/products/${item.product.id}`}
                key={item.assignmentId}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {item.product.name}
                  </p>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {item.product.sku ?? "无 SKU"} ·{" "}
                    {formatDate(item.updatedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="numeric font-semibold">
                    {formatMoney(item.priceCents)}
                  </span>
                  <RefreshCcw className="size-4 text-muted-foreground" />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="p-5">
            <StatePanel
              compact
              type="empty"
              title={
                dashboard.total ? "还没有已提交报价" : "目前没有分配给你的产品"
              }
              description={
                dashboard.total
                  ? "从待填写产品开始提交第一份报价。"
                  : "产品分配后会自动出现在这里，无需刷新账号设置。"
              }
              action={
                dashboard.total ? (
                  <Button asChild variant="outline">
                    <Link href="/factory/products?quoteStatus=pending">
                      查看待填写
                    </Link>
                  </Button>
                ) : undefined
              }
            />
          </div>
        )}
      </section>
      {dashboard.pending === 0 && dashboard.total > 0 ? (
        <div className="mt-5 flex items-center gap-3 rounded-xl border bg-success-surface p-4 text-sm text-success">
          <CircleCheck className="size-5 shrink-0" />
          所有已分配产品都已提交报价。
          <Badge variant="success">已完成</Badge>
        </div>
      ) : null}
      <section className="mt-7 max-w-2xl rounded-xl border bg-surface p-5 sm:p-6">
        <h2 className="font-semibold">账户安全</h2>
        <p className="mt-1 mb-5 text-sm text-muted-foreground">
          可在此快速修改当前账户密码；完整账户资料位于“账户”页面。
        </p>
        <PasswordForm />
      </section>
    </FactoryShell>
  );
}
