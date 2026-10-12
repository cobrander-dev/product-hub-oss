import {
  assertTrustedMutationOrigin,
  imageErrorResponse,
  imageIdSchema,
  promotionInputSchema,
} from "@/features/images/http";
import { promoteFactoryPrivateImage } from "@/features/images/service";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ productId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    assertTrustedMutationOrigin(request);
    await requireAdminFromHeaders(request.headers);
    const productId = imageIdSchema.parse((await context.params).productId);
    const input = promotionInputSchema.parse(await request.json());
    const result = await promoteFactoryPrivateImage(
      request.headers,
      productId,
      input.factoryImageId,
    );
    return Response.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return imageErrorResponse(error);
  }
}
