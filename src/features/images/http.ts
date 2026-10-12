import { Readable } from "node:stream";

import { z } from "zod";

import { ApplicationError } from "@/lib/application/errors";
import { parseAuthEnv } from "@/lib/env";
import { MAX_IMAGE_BYTES } from "@/lib/storage/image-normalization";

const MULTIPART_OVERHEAD_ALLOWANCE = 1024 * 1024;

export function assertTrustedMutationOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const trusted = parseAuthEnv().BETTER_AUTH_TRUSTED_ORIGINS;
  if (!origin || !trusted.includes(origin)) {
    throw new ApplicationError("FORBIDDEN");
  }
}

export async function readImageUpload(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    Number(contentLength) > MAX_IMAGE_BYTES + MULTIPART_OVERHEAD_ALLOWANCE
  ) {
    throw new ApplicationError("VALIDATION", "上传请求过大");
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ApplicationError("VALIDATION", "请选择图片文件");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ApplicationError("VALIDATION", "图片不能超过 10 MB");
  }
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
    originalFilename: file.name,
  };
}

export function imageErrorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "VALIDATION", message: "提交的数据无效" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof ApplicationError) {
    const status =
      error.kind === "UNAUTHENTICATED"
        ? 401
        : error.kind === "VALIDATION"
          ? 400
          : error.kind === "CONFLICT"
            ? 409
            : 404;
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

export function imageResponse(
  request: Request,
  input: {
    stream: Readable;
    contentLength: number;
    etag: string;
  },
) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": "inline",
    "Content-Length": input.contentLength.toString(),
    "Content-Type": "image/webp",
    ETag: input.etag,
    "X-Content-Type-Options": "nosniff",
  });
  if (request.headers.get("if-none-match") === input.etag) {
    input.stream.destroy();
    return new Response(null, { status: 304, headers });
  }
  return new Response(Readable.toWeb(input.stream) as ReadableStream, {
    status: 200,
    headers,
  });
}

export const promotionInputSchema = z
  .object({ factoryImageId: z.uuid() })
  .strict();
export const imageIdSchema = z.uuid();
