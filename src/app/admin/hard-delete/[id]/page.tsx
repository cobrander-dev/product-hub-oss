import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { readHardDeleteOperation } from "@/features/hard-delete/service";
import { HardDeleteOperationStatus } from "@/features/hard-delete/operation-client";
import { AdminShell } from "@/features/admin/ui";
import { ApplicationError } from "@/lib/application/errors";
export const dynamic = "force-dynamic";
export default async function OperationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let operation;
  try {
    operation = await readHardDeleteOperation(await headers(), id);
  } catch (error) {
    if (
      error instanceof ApplicationError &&
      ["NOT_FOUND", "VALIDATION"].includes(error.kind)
    )
      notFound();
    throw error;
  }
  return (
    <AdminShell
      title="永久删除任务"
      eyebrow="Danger zone"
      description="数据库删除、文件清理和最终验证由系统持续执行。"
    >
      <HardDeleteOperationStatus
        initial={JSON.parse(JSON.stringify(operation))}
      />
    </AdminShell>
  );
}
