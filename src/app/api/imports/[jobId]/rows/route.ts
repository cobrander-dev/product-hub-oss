import { dataFileErrorResponse } from "@/features/imports/http";
import { listProductImportRows } from "@/features/imports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(
      await listProductImportRows(
        request.headers,
        (await context.params).jobId,
        query,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return dataFileErrorResponse(error);
  }
}
