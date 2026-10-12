import { assertTrustedMutationOrigin } from "@/features/images/http";
import { dataFileErrorResponse } from "@/features/imports/http";
import { confirmProductImport } from "@/features/imports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    assertTrustedMutationOrigin(request);
    return Response.json(
      await confirmProductImport(request.headers, (await context.params).jobId),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return dataFileErrorResponse(error);
  }
}
