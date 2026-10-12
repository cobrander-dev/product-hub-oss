import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAdminQuoteRecordAssignmentId } from "@/features/admin/service";
import { ApplicationError } from "@/lib/application/errors";
import QuoteWorkspacePage from "../../[id]/page";
export const dynamic = "force-dynamic";
export default async function QuoteRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let assignmentId;
  try {
    assignmentId = await getAdminQuoteRecordAssignmentId(await headers(), id);
  } catch (error) {
    if (
      error instanceof ApplicationError &&
      ["NOT_FOUND", "VALIDATION"].includes(error.kind)
    )
      notFound();
    throw error;
  }
  return (
    <QuoteWorkspacePage
      params={Promise.resolve({ id: assignmentId, quoteRecordId: id })}
    />
  );
}
