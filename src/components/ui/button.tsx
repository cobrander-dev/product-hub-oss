import { Slot } from "radix-ui";
import { type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const variants = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary-hover border-transparent",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-secondary/75 border-transparent",
  outline: "border-border-strong bg-surface hover:bg-surface-muted",
  ghost: "border-transparent bg-transparent hover:bg-muted",
  danger:
    "border-transparent bg-danger text-white hover:bg-danger/90 focus-visible:outline-danger",
} as const;

const sizes = {
  sm: "h-9 px-3 text-xs",
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-5 text-sm",
  icon: "size-11 p-0",
} as const;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
};

export function Button({
  asChild,
  className,
  variant = "primary",
  size = "md",
  type = "button",
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap transition-colors duration-150 outline-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      type={asChild ? undefined : type}
      {...props}
    />
  );
}
