import { readHardDeleteOperation } from "@/features/hard-delete/service";
import { dataFileErrorResponse } from "@/features/imports/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return Response.json(await readHardDeleteOperation(request.headers, id), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return dataFileErrorResponse(error);
  }
}
