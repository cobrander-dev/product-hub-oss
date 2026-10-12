"use client";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { entityLabels } from "./presentation";
import { hardDeleteTargetTypeSchema } from "./types";
export function HardDeleteCompletionNotice() {
  const params = useSearchParams();
  const id = params.get("hardDeleted");
  const [verified, setVerified] = useState<{
    id: string;
    label: string;
  } | null>(null);
  useEffect(() => {
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return;
    const controller = new AbortController();
    fetch("/api/admin/hard-delete/" + id, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const result: unknown = await response.json();
        if (
          !result ||
          typeof result !== "object" ||
          !("status" in result) ||
          result.status !== "COMPLETED" ||
          !("targetType" in result)
        )
          return;
        const type = hardDeleteTargetTypeSchema.safeParse(result.targetType);
        if (type.success) setVerified({ id, label: entityLabels[type.data] });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [id]);
  if (!verified || verified.id !== id) return null;
  return (
    <p
      role="status"
      className="mb-5 rounded-lg border border-success/30 bg-success/10 p-4 text-sm"
    >
      {verified.label}已永久删除。
    </p>
  );
}
