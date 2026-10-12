import {
  authorizeFactoryPrivateImageRead,
  openAuthorizedImage,
} from "@/features/images/service";
import {
  imageErrorResponse,
  imageIdSchema,
  imageResponse,
} from "@/features/images/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ imageId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const imageId = imageIdSchema.parse((await context.params).imageId);
    const authorized = await authorizeFactoryPrivateImageRead(
      request.headers,
      imageId,
    );
    return imageResponse(request, await openAuthorizedImage(authorized));
  } catch (error) {
    return imageErrorResponse(error);
  }
}
