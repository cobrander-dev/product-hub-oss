import { dataFileErrorResponse } from "@/features/imports/http";
import { getProductImportJob } from "@/features/imports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    return Response.json(
      await getProductImportJob(request.headers, (await context.params).jobId),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return dataFileErrorResponse(error);
  }
}
