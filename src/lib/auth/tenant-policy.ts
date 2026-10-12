import { AuthorizationError, type FactoryActor } from "@/lib/auth/context-core";

export function resolveFactoryTenant(
  actor: FactoryActor,
  untrustedFactoryId?: string | null,
) {
  if (untrustedFactoryId && untrustedFactoryId !== actor.factoryId) {
    throw new AuthorizationError("NOT_FOUND");
  }

  return actor.factoryId;
}
