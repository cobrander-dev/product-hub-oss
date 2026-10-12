import {
  authorizeProductMainImageRead,
  openAuthorizedImage,
  removeProductMainImage,
  setProductMainImage,
} from "@/features/images/service";
import {
  assertTrustedMutationOrigin,
  imageErrorResponse,
  imageIdSchema,
  imageResponse,
  readImageUpload,
} from "@/features/images/http";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ productId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const productId = imageIdSchema.parse((await context.params).productId);
    const authorized = await authorizeProductMainImageRead(
      request.headers,
      productId,
    );
    return imageResponse(request, await openAuthorizedImage(authorized));
  } catch (error) {
    return imageErrorResponse(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    assertTrustedMutationOrigin(request);
    await requireAdminFromHeaders(request.headers);
    const productId = imageIdSchema.parse((await context.params).productId);
    const result = await setProductMainImage(
      request.headers,
      productId,
      await readImageUpload(request),
    );
    return Response.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return imageErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    assertTrustedMutationOrigin(request);
    const productId = imageIdSchema.parse((await context.params).productId);
    await removeProductMainImage(request.headers, productId);
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return imageErrorResponse(error);
  }
}
