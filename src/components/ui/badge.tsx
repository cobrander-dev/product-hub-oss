import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const variants = {
  neutral: "border-border bg-surface-muted text-foreground",
  success: "border-success/20 bg-success-surface text-success",
  warning: "border-warning/20 bg-warning-surface text-warning",
  danger: "border-danger/20 bg-danger-surface text-danger",
  info: "border-info/20 bg-info-surface text-info",
} as const;

export function Badge({
  className,
  variant = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: keyof typeof variants }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center rounded-full border px-2 py-0.5 text-[11px] leading-4 font-semibold tracking-wide",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
