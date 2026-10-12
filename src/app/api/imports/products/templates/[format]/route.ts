import { downloadProductImportTemplate } from "@/features/exports/service";
import {
  dataFileErrorResponse,
  dataFileResponse,
} from "@/features/imports/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ format: string }> };

export async function GET(request: Request, context: Context) {
  try {
    return dataFileResponse(
      await downloadProductImportTemplate(
        request.headers,
        (await context.params).format,
      ),
    );
  } catch (error) {
    return dataFileErrorResponse(error);
  }
}
