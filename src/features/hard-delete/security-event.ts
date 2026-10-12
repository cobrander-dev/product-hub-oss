import { createHash } from "node:crypto";
export function hardDeleteSecurityEvent(
  operationId: string,
  entityType: string,
  targetId: string,
  status: string,
) {
  const fingerprint = createHash("sha256")
    .update("product-hub-hard-delete-v1\0")
    .update(entityType)
    .update("\0")
    .update(targetId)
    .digest("hex");
  process.stdout.write(
    JSON.stringify({
      operationId,
      entityType,
      fingerprint,
      status,
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
}
