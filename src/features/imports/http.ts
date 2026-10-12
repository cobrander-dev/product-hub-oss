import { z } from "zod";

import { MAX_IMPORT_BYTES } from "@/features/imports/parser";
import { ApplicationError } from "@/lib/application/errors";

const MULTIPART_ALLOWANCE = 1024 * 1024;

export async function readProductImportUpload(request: Request) {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_IMPORT_BYTES + MULTIPART_ALLOWANCE) {
    throw new ApplicationError("VALIDATION", "上传请求过大");
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ApplicationError("VALIDATION", "请选择 CSV 或 XLSX 文件");
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ApplicationError("VALIDATION", "导入文件不能超过 10 MB");
  }
  return { bytes: Buffer.from(await file.arrayBuffer()), filename: file.name };
}

export function dataFileErrorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json(
      {
        error: "VALIDATION",
        message: error.issues[0]?.message ?? "提交的数据无效",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof ApplicationError) {
    const status =
      error.kind === "UNAUTHENTICATED"
        ? 401
        : error.kind === "FORBIDDEN"
          ? 403
          : error.kind === "NOT_FOUND"
            ? 404
            : error.kind === "CONFLICT"
              ? 409
              : 400;
    return Response.json(
      { error: error.kind, message: error.message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { error: "INTERNAL", message: "操作失败，请稍后重试" },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export function dataFileResponse(file: {
  bytes: Buffer;
  filename: string;
  contentType: string;
}) {
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Content-Length": file.bytes.length.toString(),
      "Content-Type": file.contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
