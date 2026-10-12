import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getAuthContext } from "@/lib/auth/context";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const actor = await getAuthContext();
  if (!actor) redirect("/login");
  if (actor.role !== "ADMIN") redirect("/factory");
  return children;
}
