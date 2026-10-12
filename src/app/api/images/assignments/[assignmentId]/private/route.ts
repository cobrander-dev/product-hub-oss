import {
  removeOwnFactoryPrivateImage,
  setOwnFactoryPrivateImage,
} from "@/features/images/service";
import {
  assertTrustedMutationOrigin,
  imageErrorResponse,
  imageIdSchema,
  readImageUpload,
} from "@/features/images/http";
import { requireFactoryUserFromHeaders } from "@/lib/auth/context-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ assignmentId: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    assertTrustedMutationOrigin(request);
    await requireFactoryUserFromHeaders(request.headers);
    const assignmentId = imageIdSchema.parse(
      (await context.params).assignmentId,
    );
    const result = await setOwnFactoryPrivateImage(
      request.headers,
      assignmentId,
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
    const assignmentId = imageIdSchema.parse(
      (await context.params).assignmentId,
    );
    await removeOwnFactoryPrivateImage(request.headers, assignmentId);
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return imageErrorResponse(error);
  }
}
