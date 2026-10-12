import { redirect } from "next/navigation";
import { Suspense } from "react";
import { HardDeleteCompletionNotice } from "@/features/hard-delete/completion-notice";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shared/app-shell";
import { getAuthContext } from "@/lib/auth/context";

export async function AdminShell({
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
  const actor = await getAuthContext();
  if (!actor) redirect("/login");
  if (actor.role !== "ADMIN") redirect("/factory");
  return (
    <AppShell
      actions={actions}
      description={description}
      eyebrow={eyebrow}
      role="admin"
      subtitle="管理员"
      title={title}
      username={actor.username}
    >
      <Suspense fallback={null}>
        <HardDeleteCompletionNotice />
      </Suspense>
      {children}
    </AppShell>
  );
}

export function formatMoney(cents: string | null) {
  if (cents === null) return "未报价";
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

export function ProductThumb({
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
          : "size-12 shrink-0 overflow-hidden rounded-md border bg-surface-muted"
      }
    >
      {src ? (
        // The image is streamed through an authenticated same-origin route.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="size-full object-contain" src={src} alt={alt} />
      ) : (
        <div className="flex size-full items-center justify-center px-2 text-center text-[10px] text-muted-foreground">
          待上传
        </div>
      )}
    </div>
  );
}
