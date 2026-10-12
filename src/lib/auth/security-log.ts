export type AuthSecurityEventType =
  | "login_success"
  | "login_failure"
  | "logout"
  | "password_change"
  | "admin_password_reset"
  | "user_disable"
  | "user_enable"
  | "factory_disable"
  | "factory_enable"
  | "factory_user_create";

type AuthSecurityEvent = {
  type: AuthSecurityEventType;
  result: "success" | "failure";
  actorId?: string;
  targetUserId?: string;
  factoryId?: string;
};

export function recordAuthSecurityEvent(event: AuthSecurityEvent) {
  const entry = {
    scope: "auth_security",
    occurredAt: new Date().toISOString(),
    ...event,
  };

  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
