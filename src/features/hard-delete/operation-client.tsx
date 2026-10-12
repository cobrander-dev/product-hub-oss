"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { readHardDeleteOperation } from "./service";
import { completedDestination, entityLabels } from "./presentation";
import type { AuthorizedHardDeleteTargetType } from "./types";
import { ImpactCounts } from "./admin-client";
type Operation = Awaited<ReturnType<typeof readHardDeleteOperation>>;
type WireOperation = Omit<
  Operation,
  | "requestedAt"
  | "confirmedAt"
  | "startedAt"
  | "databaseCommittedAt"
  | "completedAt"
  | "failedAt"
> &
  Record<
    | "requestedAt"
    | "confirmedAt"
    | "startedAt"
    | "databaseCommittedAt"
    | "completedAt"
    | "failedAt",
    string | null
  >;
const stages: Record<string, string> = {
  PREVIEWED: "尚未确认",
  CONFIRMED: "已确认，等待执行",
  EXECUTING: "正在删除",
  FILES_PENDING: "正在清理文件并验证",
  COMPLETED: "永久删除完成",
  FAILED: "已停止",
};
export function HardDeleteOperationStatus({
  initial,
}: {
  initial: WireOperation;
}) {
  const router = useRouter();
  const [operation, setOperation] = useState(initial);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (operation.status === "COMPLETED") {
      router.replace(
        `${completedDestination(operation.targetType as AuthorizedHardDeleteTargetType)}?hardDeleted=${operation.id}`,
      );
      router.refresh();
      return;
    }
    if (operation.status === "FAILED" || operation.status === "PREVIEWED")
      return;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/admin/hard-delete/${operation.id}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          setNotice(
            response.status === 401 || response.status === 403
              ? "会话已失效或没有权限，请重新登录。"
              : "无法读取任务状态，请刷新页面。",
          );
          return;
        }
        setOperation((await response.json()) as WireOperation);
        setNotice("");
      } catch {
        if (!controller.signal.aborted)
          setNotice("连接暂时中断，任务仍由系统处理。");
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [operation.id, operation.status, operation.targetType, router]);
  const type = operation.targetType as AuthorizedHardDeleteTargetType;
  return (
    <section className="min-w-0 rounded-xl border bg-surface p-5">
      <h2 className="font-semibold" role="status">
        {stages[operation.status]}
      </h2>
      <p className="mt-2 text-sm break-all">
        目标：{operation.targetLabelSnapshot}
      </p>
      <p className="mt-2 text-sm">
        开始时间：
        {operation.startedAt
          ? new Intl.DateTimeFormat("zh-CN", {
              timeZone: "Asia/Shanghai",
              dateStyle: "short",
              timeStyle: "medium",
            }).format(new Date(operation.startedAt))
          : "等待 Worker"}
      </p>
      <p className="mt-2 text-sm">
        文件任务：{operation.files.completed} / {operation.files.total}
      </p>
      {operation.files.retrying > 0 && (
        <p className="mt-2 text-sm text-warning">
          文件清理失败，系统将自动重试。已尝试 {operation.files.attempts} 次。
        </p>
      )}
      {operation.status !== "COMPLETED" && operation.status !== "FAILED" && (
        <p className="mt-2 text-sm text-muted-foreground">
          最终数据库与文件验证通过后才会显示完成。任务持续执行，请勿重复提交。
        </p>
      )}
      <div className="mt-5">
        <h3 className="mb-3 text-sm font-semibold">批准删除范围</h3>
        <ImpactCounts values={operation.preview.counts} />
      </div>
      <p role="alert" className="mt-4 text-sm text-danger">
        {operation.failureMessage ?? notice}
      </p>
      <Link
        className="mt-5 inline-block text-sm text-primary underline"
        href={completedDestination(type)}
      >
        返回{entityLabels[type]}管理
      </Link>
    </section>
  );
}
