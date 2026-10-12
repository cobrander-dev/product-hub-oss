import {
  dataFileErrorResponse,
  readProductImportUpload,
} from "@/features/imports/http";
import { previewProductImport } from "@/features/imports/service";
import { assertTrustedMutationOrigin } from "@/features/images/http";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    await requireAdminFromHeaders(request.headers);
    const result = await previewProductImport(
      request.headers,
      await readProductImportUpload(request),
    );
    return Response.json(result, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return dataFileErrorResponse(error);
  }
}
