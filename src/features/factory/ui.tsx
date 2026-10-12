import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shared/app-shell";
import { getAuthContext } from "@/lib/auth/context";

export async function requireFactoryPageActor() {
  const actor = await getAuthContext();
  if (!actor) redirect("/login");
  if (actor.role !== "FACTORY") redirect("/admin");
  return actor;
}

export async function FactoryShell({
  title,
  eyebrow,
  description,
  actions,
  children,
}: {
  title: string;
  eyebrow: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const actor = await requireFactoryPageActor();
  return (
    <AppShell
      actions={actions}
      description={description}
      eyebrow={eyebrow}
      role="factory"
      subtitle={actor.factoryName}
      title={title}
      username={actor.username}
    >
      {children}
    </AppShell>
  );
}

export function formatMoney(cents: string | null) {
  if (cents === null) return "待填写";
  const value = BigInt(cents);
  return `¥${(value / 100n).toLocaleString("zh-CN")}.${(value % 100n)
    .toString()
    .padStart(2, "0")}`;
}

export function formatDate(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

export function FactoryProductImage({
  src,
  alt,
  large = false,
}: {
  src: string | null;
  alt: string;
  large?: boolean;
}) {
  return (
    <div
      className={
        large
          ? "aspect-[4/3] w-full overflow-hidden rounded-xl border bg-surface-muted"
          : "aspect-[4/3] w-full overflow-hidden rounded-lg border bg-surface-muted"
      }
    >
      {src ? (
        // Images are streamed through authenticated same-origin routes.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="size-full object-contain" src={src} alt={alt} />
      ) : (
        <div className="flex size-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
          暂无产品主图
        </div>
      )}
    </div>
  );
}
