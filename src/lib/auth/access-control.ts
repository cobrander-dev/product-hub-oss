import { adminAc, defaultAc, userAc } from "better-auth/plugins/admin/access";
import type { AccessControl, Role } from "better-auth/plugins/access";

// Better Auth 1.7.5 publishes AdminOptions with non-generic AccessControl/Role
// types, while its built-in controls retain narrower statement generics.
// These are the package's own matching runtime values; the casts bridge that
// declaration-only variance without widening the role keys below.
export const authAccessControl = defaultAc as unknown as AccessControl;

export const authRoles = {
  ADMIN: adminAc as unknown as Role,
  FACTORY: userAc as unknown as Role,
} as const;
