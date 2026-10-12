"use client";

import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Upload,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExportButton } from "@/features/admin-operations/export-button";

type Job = {
  id: string;
  originalFilename: string;
  status: string;
  totalRows: number;
  createRows: number;
  updateRows: number;
  noChangeRows: number;
  errorRows: number;
};
type Row = {
  id: string;
  rowNumber: number;
  action: "CREATE" | "UPDATE" | "NO_CHANGE" | "ERROR";
  normalizedData: Record<string, unknown> | null;
  changes: Record<string, { before?: unknown; after?: unknown }> | null;
  errors: Array<{ field: string; message: string }>;
};

const actionMeta = {
  CREATE: ["新增", "success"],
  UPDATE: ["更新", "info"],
  NO_CHANGE: ["无变化", "neutral"],
  ERROR: ["错误", "danger"],
} as const;
const fieldLabels: Record<string, string> = {
  sku: "SKU",
  name: "产品名称",
  category: "分类",
  material: "材质",
  status: "状态",
  notes: "内部备注",
};

async function message(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    message?: string;
  } | null;
  return body?.message ?? "操作失败，请稍后重试";
}

export function ImportWorkspace({ recent }: { recent: Job[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [rowPage, setRowPage] = useState(1);
  const [rowPages, setRowPages] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState(false);

  const upload = useCallback(async (file?: File) => {
    if (!file) return;
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      setNotice("仅支持 CSV 或 XLSX 文件");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setNotice("文件不能超过 10 MB");
      return;
    }
    setBusy(true);
    setNotice("正在校验并生成预览…");
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/imports/products/preview", {
        method: "POST",
        body: form,
      });
      if (!response.ok) throw new Error(await message(response));
      const nextJob = (await response.json()) as Job;
      const rowResponse = await fetch(
        `/api/imports/${nextJob.id}/rows?page=1&pageSize=50`,
      );
      if (!rowResponse.ok) throw new Error(await message(rowResponse));
      const rowResult = (await rowResponse.json()) as {
        items: Row[];
        totalPages: number;
      };
      setJob(nextJob);
      setRows(rowResult.items);
      setRowPage(1);
      setRowPages(rowResult.totalPages);
      setNotice("预览已生成；确认前不会修改任何产品。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法生成预览");
    } finally {
      setBusy(false);
    }
  }, []);

  async function loadRowPage(page: number) {
    if (!job) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/imports/${job.id}/rows?page=${page}&pageSize=50`,
      );
      if (!response.ok) throw new Error(await message(response));
      const result = (await response.json()) as {
        items: Row[];
        totalPages: number;
      };
      setRows(result.items);
      setRowPage(page);
      setRowPages(result.totalPages);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取预览行");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!job) return;
    setBusy(true);
    setConfirming(false);
    try {
      const response = await fetch(`/api/imports/${job.id}/confirm`, {
        method: "POST",
      });
      if (!response.ok) {
        if (response.status === 409) {
          throw new Error("部分产品在预览后已被修改，请重新生成预览。");
        }
        throw new Error(await message(response));
      }
      setJob({ ...job, status: "CONFIRMED" });
      setNotice("导入完成，产品资料已安全更新。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "确认导入失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold">1. 下载固定模板</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              请保留列名；更新产品时必须填写导出的 product_id。
            </p>
          </div>
          <div className="flex gap-2">
            <ExportButton
              endpoint="/api/imports/products/templates/csv"
              label="CSV 模板"
            />
            <ExportButton
              endpoint="/api/imports/products/templates/xlsx"
              label="XLSX 模板"
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border bg-surface p-5 sm:p-6">
        <h2 className="font-semibold">2. 上传并预览</h2>
        <button
          className="mt-4 flex min-h-44 w-full flex-col items-center justify-center rounded-xl border border-dashed border-border-strong bg-surface-muted/50 p-6 text-center transition-colors outline-none hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-ring"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void upload(event.dataTransfer.files[0]);
          }}
          type="button"
        >
          <Upload className="mb-3 size-6 text-primary" />
          <span className="font-medium">拖放文件到这里，或点击选择</span>
          <span className="mt-1 text-sm text-muted-foreground">
            CSV / XLSX，最多 10 MB；上传只生成预览
          </span>
        </button>
        <input
          accept=".csv,.xlsx"
          aria-label="选择产品导入文件"
          className="sr-only"
          onChange={(event) => void upload(event.target.files?.[0])}
          ref={inputRef}
          type="file"
        />
        <p aria-live="polite" className="mt-3 text-sm text-muted-foreground">
          {notice}
        </p>
      </section>

      {job ? (
        <section className="rounded-xl border bg-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">3. 核对预览</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {job.originalFilename} · 共 {job.totalRows} 行
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="success">新增 {job.createRows}</Badge>
              <Badge variant="info">更新 {job.updateRows}</Badge>
              <Badge>无变化 {job.noChangeRows}</Badge>
              <Badge variant={job.errorRows ? "danger" : "neutral"}>
                错误 {job.errorRows}
              </Badge>
            </div>
          </div>
          <div className="mt-5 overflow-x-auto rounded-lg border">
            <table className="hidden w-full min-w-[760px] text-left text-sm md:table">
              <thead className="bg-surface-muted text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">行</th>
                  <th className="p-3">动作</th>
                  <th className="p-3">产品</th>
                  <th className="p-3">差异 / 错误</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <PreviewRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
            <div className="divide-y md:hidden">
              {rows.map((row) => (
                <PreviewCard key={row.id} row={row} />
              ))}
            </div>
          </div>
          {rowPages > 1 ? (
            <nav
              aria-label="导入预览分页"
              className="mt-3 flex justify-end gap-2"
            >
              <Button
                disabled={busy || rowPage <= 1}
                onClick={() => void loadRowPage(rowPage - 1)}
                size="sm"
                variant="outline"
              >
                上一页
              </Button>
              <span className="inline-flex items-center px-2 text-sm text-muted-foreground">
                {rowPage} / {rowPages}
              </span>
              <Button
                disabled={busy || rowPage >= rowPages}
                onClick={() => void loadRowPage(rowPage + 1)}
                size="sm"
                variant="outline"
              >
                下一页
              </Button>
            </nav>
          ) : null}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {job.errorRows
                ? "请修正错误后重新上传。"
                : "预览无错误，可以确认导入。"}
            </p>
            {job.status === "CONFIRMED" ? (
              <span className="inline-flex items-center gap-2 text-sm font-medium text-success">
                <CheckCircle2 /> 已完成
              </span>
            ) : (
              <Button
                disabled={busy || job.errorRows > 0}
                onClick={() => setConfirming(true)}
              >
                确认导入
              </Button>
            )}
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border bg-surface p-5 sm:p-6">
        <h2 className="font-semibold">最近导入</h2>
        <div className="mt-4 divide-y rounded-lg border">
          {recent.length ? (
            recent.map((item) => (
              <div
                className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
                key={item.id}
              >
                <span className="inline-flex items-center gap-2">
                  <FileSpreadsheet className="size-4 text-muted-foreground" />
                  {item.originalFilename}
                </span>
                <span className="text-muted-foreground">
                  {item.totalRows} 行 ·{" "}
                  {item.status === "CONFIRMED" ? "已确认" : "待确认"}
                </span>
              </div>
            ))
          ) : (
            <p className="p-4 text-sm text-muted-foreground">暂无导入记录</p>
          )}
        </div>
      </section>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogTitle>确认导入产品？</DialogTitle>
          <DialogDescription>
            将新增 {job?.createRows ?? 0} 个、更新 {job?.updateRows ?? 0}{" "}
            个产品。此操作会写入数据库。
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)} variant="outline">
              取消
            </Button>
            <Button onClick={() => void confirm()}>确认导入</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RowDetails({ row }: { row: Row }) {
  if (row.errors?.length)
    return (
      <ul className="space-y-1 text-danger">
        {row.errors.map((item, index) => (
          <li key={`${item.field}-${index}`}>
            <AlertTriangle className="mr-1 inline size-3" />
            {item.field}：{item.message}
          </li>
        ))}
      </ul>
    );
  const changes = Object.entries(row.changes ?? {});
  return changes.length ? (
    <ul className="space-y-1">
      {changes.map(([field, value]) => (
        <li key={field}>
          <span className="font-medium">{fieldLabels[field] ?? field}</span>：
          <span className="text-muted-foreground">
            {String(value.before ?? "未填写")}
          </span>{" "}
          → {String(value.after ?? "未填写")}
        </li>
      ))}
    </ul>
  ) : (
    <span className="text-muted-foreground">无需修改</span>
  );
}
function PreviewRow({ row }: { row: Row }) {
  const meta = actionMeta[row.action];
  return (
    <tr>
      <td className="numeric p-3">{row.rowNumber}</td>
      <td className="p-3">
        <Badge variant={meta[1]}>{meta[0]}</Badge>
      </td>
      <td className="p-3">
        <span className="font-medium">
          {String(row.normalizedData?.name ?? "—")}
        </span>
        <span className="ml-2 font-mono text-xs text-muted-foreground">
          {String(row.normalizedData?.sku ?? "无 SKU")}
        </span>
      </td>
      <td className="p-3">
        <RowDetails row={row} />
      </td>
    </tr>
  );
}
function PreviewCard({ row }: { row: Row }) {
  const meta = actionMeta[row.action];
  return (
    <article className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          第 {row.rowNumber} 行
        </span>
        <Badge variant={meta[1]}>{meta[0]}</Badge>
      </div>
      <p className="font-medium">
        {String(row.normalizedData?.name ?? "无法识别产品")}
      </p>
      <div className="text-sm">
        <RowDetails row={row} />
      </div>
    </article>
  );
}
