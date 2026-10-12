"use client";
import { useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { previewHardDeleteAction, confirmHardDeleteAction } from "./actions";
import { blockerMessages, countLabels, entityLabels } from "./presentation";
import type { AuthorizedHardDeleteTargetType } from "./types";

type Preview =
  Awaited<ReturnType<typeof previewHardDeleteAction>> extends infer R
    ? R extends { ok: true; data: infer D }
      ? D
      : never
    : never;
export function ImpactCounts({ values }: { values: Record<string, number> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {Object.entries(values).map(([key, value]) => (
        <div key={key} className="flex min-w-0 justify-between gap-2">
          <dt className="break-words">{countLabels[key] ?? "其他关联记录"}</dt>
          <dd className="numeric shrink-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function HardDeleteDangerZone({
  targetType,
  targetId,
  children,
}: {
  targetType: AuthorizedHardDeleteTargetType;
  targetId: string;
  children?: ReactNode;
}) {
  const router = useRouter();
  const inputId = useId();
  const busy = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [typed, setTyped] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  async function load() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setTyped("");
    setPreview(null);
    setNotice("");
    setStale(false);
    setOpen(true);
    try {
      const result = await previewHardDeleteAction({ targetType, targetId });
      if (!result.ok) {
        setNotice(result.message);
        return;
      }
      if (result.data.status === "ACTIVE") {
        setNotice("该对象已有永久删除任务正在执行。");
        router.push(`/admin/hard-delete/${result.data.operationId}`);
        return;
      }
      setPreview(result.data);
    } catch {
      setNotice("无法读取删除影响，请稍后重试。");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function confirm() {
    if (
      busy.current ||
      !preview ||
      preview.status !== "PREVIEWED" ||
      typed !== preview.confirmationPhrase ||
      stale
    )
      return;
    busy.current = true;
    setPending(true);
    setNotice("");
    try {
      const result = await confirmHardDeleteAction({
        operationId: preview.operationId,
        previewSha256: preview.previewSha256,
        expectedVersion: preview.version,
        confirmationPhrase: typed,
      });
      if (!result.ok) {
        setNotice(result.message);
        setTyped("");
        if (result.error === "CONFLICT") setStale(true);
        return;
      }
      router.push(`/admin/hard-delete/${result.data.operationId}`);
    } catch {
      setNotice("确认结果暂时无法读取，请重新检查已有任务。");
      setTyped("");
      setStale(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <section
      className="mt-4 min-w-0 rounded-lg border border-danger/35 bg-danger/5 p-4"
      aria-label={`${entityLabels[targetType]}危险操作`}
    >
      <h2 className="text-sm font-semibold">
        危险操作 · {entityLabels[targetType]}
      </h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        停用或撤销可保留历史；永久删除不可恢复。请先检查删除影响。
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {children}
        <Button
          id={inputId + "-trigger"}
          variant="danger"
          disabled={pending}
          onClick={load}
        >
          永久删除{entityLabels[targetType]}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) {
            setOpen(value);
            if (!value) {
              setTyped("");
              setPreview(null);
            }
          }
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById(inputId + "-trigger")?.focus();
          }}
        >
          <DialogTitle className="pr-10">
            永久删除{entityLabels[targetType]}
          </DialogTitle>
          <DialogDescription>
            不可恢复。仅清除当前数据库与属于删除范围的专属 uploads
            文件。历史服务器备份与运维日志不修改，按保留周期自然过期。
          </DialogDescription>
          {pending && !preview && (
            <p className="mt-4" role="status">
              正在检查删除影响…
            </p>
          )}
          {preview && preview.status !== "ACTIVE" && (
            <div className="mt-5 space-y-5">
              <p className="text-sm font-medium break-all">
                目标：{preview.target.label}
              </p>
              <div>
                <h3 className="mb-2 text-sm font-semibold">
                  将永久删除 / 解除关联
                </h3>
                <ImpactCounts values={preview.counts} />
                <p className="mt-2 text-sm">
                  服务器专属物理文件：{preview.fileCount}
                </p>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold">将保留</h3>
                <ImpactCounts values={preview.preservation} />
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  共享业务对象和其他不在批准闭包内的历史保留。账号删除后保留历史的操作者显示为“已永久删除用户”。
                </p>
              </div>
              {preview.status === "BLOCKED" ? (
                <div
                  role="alert"
                  className="rounded-md border border-danger/30 p-3 text-sm"
                >
                  <p className="font-semibold">无法永久删除</p>
                  {!!preview.referenceCount && (
                    <p>仍有 {preview.referenceCount} 个产品使用。</p>
                  )}
                  <ul className="mt-2 space-y-2">
                    {preview.blockers.map((code) => (
                      <li key={code}>
                        {blockerMessages[code] ??
                          "目标未满足永久删除条件，请先处理相关状态或引用。"}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div>
                  <label htmlFor={inputId} className="text-sm font-medium">
                    确认短语
                  </label>
                  <p className="mt-1 mb-2 text-sm break-all">
                    请精确输入：
                    <span
                      data-testid="confirmation-phrase"
                      className="font-mono"
                    >
                      {preview.confirmationPhrase}
                    </span>
                  </p>
                  <Input
                    id={inputId}
                    autoComplete="off"
                    spellCheck={false}
                    value={typed}
                    disabled={pending || stale}
                    onChange={(event) => setTyped(event.target.value)}
                    aria-describedby={`${inputId}-help`}
                  />
                  <p
                    id={`${inputId}-help`}
                    className="mt-2 text-xs text-muted-foreground"
                  >
                    大小写与每个空格必须完全一致，不自动去除首尾空格。
                  </p>
                </div>
              )}
            </div>
          )}
          <p role="alert" className="mt-3 text-sm leading-6 text-danger">
            {notice}
          </p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            {stale && (
              <Button disabled={pending} onClick={load}>
                重新检查删除影响
              </Button>
            )}
            <Button
              variant="danger"
              disabled={
                pending ||
                stale ||
                preview?.status !== "PREVIEWED" ||
                typed !== preview.confirmationPhrase
              }
              onClick={confirm}
            >
              {pending ? "正在提交…" : "确认永久删除"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
