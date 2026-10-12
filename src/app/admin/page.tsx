import { headers } from "next/headers";
import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CircleDollarSign,
  PackageCheck,
  PackageSearch,
  Scale,
  Send,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getAdminDashboard } from "@/features/admin/service";
import { AdminShell, formatDate, formatMoney } from "@/features/admin/ui";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const dashboard = await getAdminDashboard(await headers());
  const metrics = [
    {
      label: "全部产品",
      value: dashboard.metrics.products,
      detail: `${dashboard.metrics.enabledProducts} 个启用`,
      icon: PackageSearch,
    },
    {
      label: "厂家",
      value: dashboard.metrics.factories,
      detail: `${dashboard.metrics.activeAssignments} 个有效分配`,
      icon: Building2,
    },
    {
      label: "待报价",
      value: dashboard.metrics.pendingQuotes,
      detail: `${dashboard.metrics.submittedQuotes} 份已提交`,
      icon: Send,
    },
    {
      label: "包装待补",
      value: dashboard.metrics.missingPackaging,
      detail: "缺少一项或多项包装尺寸",
      icon: Scale,
    },
    {
      label: "重量待补",
      value: dashboard.metrics.missingWeight,
      detail: "缺少净重或毛重",
      icon: Scale,
    },
  ];
  return (
    <AdminShell
      title="工作台概览"
      eyebrow="Admin workspace"
      description="今天需要处理的产品、厂家报价和资料完整度，全部来自当前数据库。"
      actions={
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/products/import">导入产品</Link>
          </Button>
          <Button asChild>
            <Link href="/admin/products/new">新建产品</Link>
          </Button>
        </div>
      }
    >
      <section
        aria-label="核心指标"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
      >
        {metrics.map(({ label, value, detail, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {label}
                  </p>
                  <p className="numeric mt-2 text-3xl font-semibold tracking-tight">
                    {value}
                  </p>
                </div>
                <span className="rounded-lg bg-accent p-2.5 text-accent-foreground">
                  <Icon className="size-5" />
                </span>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">{detail}</p>
            </CardContent>
          </Card>
        ))}
      </section>
      <section aria-label="快捷入口" className="mt-5 flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link href="/admin/quotes?quoteStatus=PENDING">查看待报价</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/admin/activity">查看活动</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/admin/users">管理厂家账号</Link>
        </Button>
      </section>
      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        <section className="rounded-xl border bg-surface">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <h2 className="font-semibold">待报价任务</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                最近分配且尚未提交报价
              </p>
            </div>
            <Button asChild size="sm" variant="ghost">
              <Link href="/admin/quotes?quoteStatus=PENDING">
                查看全部
                <ArrowRight />
              </Link>
            </Button>
          </div>
          <div className="divide-y">
            {dashboard.pendingAssignments.length ? (
              dashboard.pendingAssignments.map((item) => (
                <Link
                  className="flex min-h-16 min-w-0 items-center justify-between gap-4 px-5 py-3 transition-colors hover:bg-surface-muted"
                  href={`/admin/quotes/${item.id}`}
                  key={item.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {item.product.sku ? `${item.product.sku} · ` : ""}
                      {item.product.name}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {item.factory.name}
                    </p>
                  </div>
                  <Badge variant="warning">待报价</Badge>
                </Link>
              ))
            ) : (
              <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                当前没有待报价任务
              </p>
            )}
          </div>
        </section>
        <section className="rounded-xl border bg-surface">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <h2 className="font-semibold">最近价格变化</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                来自不可变 Price History
              </p>
            </div>
            <CircleDollarSign className="size-5 text-muted-foreground" />
          </div>
          <div className="divide-y">
            {dashboard.recentPrices.length ? (
              dashboard.recentPrices.map((item) => (
                <Link
                  className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-3 transition-colors hover:bg-surface-muted"
                  href={`/admin/quotes/${item.assignmentId}`}
                  key={item.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {item.product.name} · {item.factory.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(item.changedAt)}
                    </p>
                  </div>
                  <div className="numeric text-right text-sm font-semibold">
                    <p>{formatMoney(item.newPriceCents)}</p>
                    {item.oldPriceCents ? (
                      <p className="mt-1 text-[11px] font-normal text-muted-foreground">
                        原 {formatMoney(item.oldPriceCents)}
                      </p>
                    ) : null}
                  </div>
                </Link>
              ))
            ) : (
              <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                尚无价格历史
              </p>
            )}
          </div>
        </section>
      </div>
      <section className="mt-6 rounded-xl border bg-surface">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="font-semibold">最近更新产品</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              快速回到刚刚维护过的资料
            </p>
          </div>
          <PackageCheck className="size-5 text-muted-foreground" />
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
          {dashboard.recentProducts.map((item) => (
            <Link
              className="min-w-0 bg-surface p-5 transition-colors hover:bg-surface-muted"
              href={`/admin/products/${item.id}`}
              key={item.id}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{item.name}</p>
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
                {item.category.name} · {item.material.name} ·{" "}
                {formatDate(item.updatedAt)}
              </p>
            </Link>
          ))}
        </div>
      </section>
    </AdminShell>
  );
}
