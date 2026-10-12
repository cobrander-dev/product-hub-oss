"use client";

import { Download } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

export function ExportButton({
  endpoint,
  label,
}: {
  endpoint: string;
  label: string;
}) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? "导出失败，请稍后重试");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] ??
        disposition.match(/filename="?([^";]+)"?/)?.[1] ??
        "export";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = decodeURIComponent(filename);
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus("导出已开始");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button disabled={busy} onClick={download} variant="outline">
        <Download />
        {busy ? "正在导出…" : label}
      </Button>
      <span aria-live="polite" className="text-xs text-muted-foreground">
        {status}
      </span>
    </span>
  );
}

export function ExportActions({
  baseEndpoint,
  count,
  scopeLabel = "当前筛选结果",
}: {
  baseEndpoint: string;
  count: number;
  scopeLabel?: string;
}) {
  const [path, query] = baseEndpoint.split("?");
  const endpoint = (format: string) =>
    `${path}/${format}${query ? `?${query}` : ""}`;
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-xs text-muted-foreground">
        {scopeLabel} · 将导出 {count} 条
      </span>
      <span className="flex flex-wrap justify-end gap-2">
        <ExportButton endpoint={endpoint("csv")} label="导出 CSV" />
        <ExportButton endpoint={endpoint("xlsx")} label="导出 XLSX" />
      </span>
    </div>
  );
}
