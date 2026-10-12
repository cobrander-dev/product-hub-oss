import {
  AlertCircle,
  Inbox,
  LoaderCircle,
  SearchX,
  ShieldAlert,
} from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      aria-hidden="true"
      {...props}
    />
  );
}

const icons = {
  empty: Inbox,
  search: SearchX,
  error: AlertCircle,
  forbidden: ShieldAlert,
  loading: LoaderCircle,
} as const;

export function StatePanel({
  type,
  title,
  description,
  action,
  compact,
}: {
  type: keyof typeof icons;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  const Icon = icons[type];
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed bg-surface-muted/35 px-5 text-center",
        compact ? "min-h-44 py-7" : "min-h-64 py-10",
      )}
    >
      <span className="mb-4 inline-flex size-10 items-center justify-center rounded-lg border bg-surface text-muted-foreground">
        <Icon className={cn("size-5", type === "loading" && "animate-spin")} />
      </span>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">
        {description}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function RetryState() {
  return (
    <StatePanel
      type="error"
      title="暂时无法载入"
      description="网络连接或服务出现异常，请稍后重试。"
      action={<Button variant="outline">重新加载</Button>}
    />
  );
}
