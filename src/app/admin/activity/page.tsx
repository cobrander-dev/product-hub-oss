import { headers } from "next/headers";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getActivityFilterOptions } from "@/features/admin-operations/service";
import {
  activityEntityLabels,
  activityEventLabels,
  readableActivityChanges,
} from "@/features/activity/presentation";
import { listActivityLogs } from "@/features/activity/service";
import {
  activityEntityTypes,
  activityEventTypes,
} from "@/features/activity/validation";
import { AdminShell, formatDate } from "@/features/admin/ui";

export const dynamic = "force-dynamic";
const one = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;
const boundary = (value: string | undefined, end = false) =>
  value
    ? new Date(
        `${value}T${end ? "23:59:59.999" : "00:00:00"}+08:00`,
      ).toISOString()
    : undefined;

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const query = {
    page: one(raw.page) ?? "1",
    pageSize: 20,
    eventType: one(raw.eventType) || undefined,
    entityType: one(raw.entityType) || undefined,
    actorUserId: one(raw.actorUserId) || undefined,
    factoryId: one(raw.factoryId) || undefined,
    from: boundary(one(raw.from)),
    to: boundary(one(raw.to), true),
  };
  const requestHeaders = await headers();
  const [result, options] = await Promise.all([
    listActivityLogs(requestHeaders, query),
    getActivityFilterOptions(requestHeaders),
  ]);
  const pageHref = (page: number) => {
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
      title="活动记录"
      eyebrow="Operational audit"
      description="查看关键资料和报价操作；差异按业务字段呈现，不显示原始 JSON。"
    >
      <form
        className="grid gap-3 rounded-xl border bg-surface p-4 sm:grid-cols-2 xl:grid-cols-6"
        method="get"
      >
        <select
          aria-label="事件"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={one(raw.eventType) ?? ""}
          name="eventType"
        >
          <option value="">全部事件</option>
          {activityEventTypes.map((value) => (
            <option key={value} value={value}>
              {activityEventLabels[value]}
            </option>
          ))}
        </select>
        <select
          aria-label="对象"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={one(raw.entityType) ?? ""}
          name="entityType"
        >
          <option value="">全部对象</option>
          {activityEntityTypes.map((value) => (
            <option key={value} value={value}>
              {activityEntityLabels[value]}
            </option>
          ))}
        </select>
        <select
          aria-label="操作者"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={one(raw.actorUserId) ?? ""}
          name="actorUserId"
        >
          <option value="">全部操作者</option>
          {options.actors.map((item) => (
            <option key={item.id} value={item.id}>
              {item.username ?? item.name}
            </option>
          ))}
        </select>
        <select
          aria-label="厂家"
          className="h-11 rounded-md border bg-surface px-3 text-sm"
          defaultValue={one(raw.factoryId) ?? ""}
          name="factoryId"
        >
          <option value="">全部厂家</option>
          {options.factories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <label className="text-xs text-muted-foreground">
          开始日期
          <input
            className="mt-1 block h-11 w-full rounded-md border bg-surface px-3 text-sm text-foreground"
            defaultValue={one(raw.from) ?? ""}
            name="from"
            type="date"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          结束日期
          <input
            className="mt-1 block h-11 w-full rounded-md border bg-surface px-3 text-sm text-foreground"
            defaultValue={one(raw.to) ?? ""}
            name="to"
            type="date"
          />
        </label>
        <Button type="submit" variant="secondary">
          筛选
        </Button>
      </form>
      <p className="mt-4 text-sm text-muted-foreground">
        共{" "}
        <span className="numeric font-semibold text-foreground">
          {result.total}
        </span>{" "}
        条记录
      </p>
      <div className="mt-5 divide-y overflow-hidden rounded-xl border bg-surface">
        {result.items.map((item) => {
          const changes = readableActivityChanges(item.changes);
          const factoryName = options.factories.find(
            (factory) => factory.id === item.factoryId,
          )?.name;
          return (
            <article className="p-4 sm:p-5" key={item.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="info">
                      {activityEventLabels[item.eventType]}
                    </Badge>
                    <Badge>{activityEntityLabels[item.entityType]}</Badge>
                    <span className="font-medium">
                      {item.entityLabelSnapshot}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {item.actorUsernameSnapshot} · {formatDate(item.createdAt)}
                  </p>
                </div>
              </div>
              {changes.length ? (
                <ul className="mt-4 grid gap-2 text-sm lg:grid-cols-2">
                  {changes.slice(0, 4).map((change) => (
                    <li
                      className="rounded-md bg-surface-muted p-3"
                      key={change.field}
                    >
                      <span className="font-medium">{change.label}</span>
                      <span className="mt-1 block text-muted-foreground">
                        {change.before} →{" "}
                        <span className="text-foreground">{change.after}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  该事件没有字段差异。
                </p>
              )}
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer font-medium text-primary">
                  查看安全详情
                </summary>
                <div className="mt-3 rounded-md border bg-surface-muted p-4">
                  <dl className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">事件</dt>
                      <dd>{activityEventLabels[item.eventType]}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">对象</dt>
                      <dd>
                        {activityEntityLabels[item.entityType]} ·{" "}
                        {item.entityLabelSnapshot}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">操作者</dt>
                      <dd>{item.actorUsernameSnapshot}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        厂家上下文
                      </dt>
                      <dd>{factoryName ?? "无"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">时间</dt>
                      <dd>{formatDate(item.createdAt)}</dd>
                    </div>
                  </dl>
                  {changes.length ? (
                    <ul className="mt-4 space-y-2 border-t pt-4">
                      {changes.map((change) => (
                        <li key={change.field}>
                          {change.label}：{change.before} → {change.after}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </details>
            </article>
          );
        })}
        {!result.items.length ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            没有匹配的活动记录
          </p>
        ) : null}
      </div>
      {result.totalPages > 1 ? (
        <nav aria-label="分页" className="mt-5 flex justify-end gap-2">
          <Button asChild variant="outline">
            <Link href={pageHref(Math.max(1, result.page - 1))}>上一页</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={pageHref(Math.min(result.totalPages, result.page + 1))}>
              下一页
            </Link>
          </Button>
        </nav>
      ) : null}
    </AdminShell>
  );
}
