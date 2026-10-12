"use client";

import {
  Activity,
  Boxes,
  Building2,
  ChevronRight,
  CircleUserRound,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Package2,
  Settings,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode } from "react";

import { logoutAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type NavItem = {
  label: string;
  href?: string;
  icon: ComponentType<{ className?: string }>;
};

const adminNav: NavItem[] = [
  { label: "概览", href: "/admin", icon: LayoutDashboard },
  { label: "产品", href: "/admin/products", icon: Boxes },
  { label: "厂家", href: "/admin/factories", icon: Building2 },
  { label: "报价", href: "/admin/quotes", icon: FileText },
  { label: "活动", href: "/admin/activity", icon: Activity },
  { label: "用户", href: "/admin/users", icon: Users },
  { label: "设置", href: "/admin/settings", icon: Settings },
];

const factoryNav: NavItem[] = [
  { label: "概览", href: "/factory", icon: LayoutDashboard },
  { label: "产品", href: "/factory/products", icon: Boxes },
  { label: "账户", href: "/factory/profile", icon: CircleUserRound },
];

function Brand({ portal }: { portal: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Package2 className="size-[18px]" strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-[-0.01em]">
          Product Hub
        </p>
        <p className="truncate text-[11px] text-muted-foreground">{portal}</p>
      </div>
    </div>
  );
}

function Navigation({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="主要导航" className="space-y-1">
      {items.map((item) => {
        const active =
          item.href === "/admin" || item.href === "/factory"
            ? pathname === item.href
            : Boolean(item.href && pathname.startsWith(item.href));
        const Icon = item.icon;
        const content = (
          <>
            <Icon className="size-[18px]" />
            <span className="flex-1">{item.label}</span>
            {!item.href ? (
              <span className="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-muted-foreground">
                后续
              </span>
            ) : active ? (
              <ChevronRight className="size-3.5" />
            ) : null}
          </>
        );
        const classes = cn(
          "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
          !item.href && "cursor-not-allowed opacity-60",
        );
        return item.href ? (
          <Link key={item.label} className={classes} href={item.href}>
            {content}
          </Link>
        ) : (
          <button key={item.label} className={classes} disabled type="button">
            {content}
          </button>
        );
      })}
    </nav>
  );
}

function AccountBlock({
  username,
  subtitle,
}: {
  username: string;
  subtitle: string;
}) {
  return (
    <div className="border-t p-3">
      <div className="mb-2 flex items-center gap-3 rounded-md px-2 py-2">
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
          {username.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold" data-testid="username">
            {username}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {subtitle}
          </p>
        </div>
      </div>
      <form action={logoutAction}>
        <Button
          className="w-full justify-start"
          size="sm"
          type="submit"
          variant="ghost"
        >
          <LogOut />
          退出登录
        </Button>
      </form>
    </div>
  );
}

function SidebarContent({
  role,
  username,
  subtitle,
}: {
  role: "admin" | "factory";
  username: string;
  subtitle: string;
}) {
  const items = role === "admin" ? adminNav : factoryNav;
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-5 py-5">
        <Brand portal={role === "admin" ? "管理工作台" : "厂家工作台"} />
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-5">
        <p className="mb-2 px-3 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
          工作区
        </p>
        <Navigation items={items} />
      </div>
      <AccountBlock subtitle={subtitle} username={username} />
    </div>
  );
}

export function AppShell({
  role,
  username,
  subtitle,
  title,
  eyebrow,
  description,
  actions,
  children,
}: {
  role: "admin" | "factory";
  username: string;
  subtitle: string;
  title: string;
  eyebrow: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-svh bg-background lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-svh border-r bg-surface/90 lg:block">
        <SidebarContent role={role} subtitle={subtitle} username={username} />
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background/92 px-4 backdrop-blur-md lg:hidden">
          <Brand portal={role === "admin" ? "管理工作台" : "厂家工作台"} />
          <Sheet>
            <SheetTrigger asChild>
              <Button aria-label="打开导航" size="icon" variant="outline">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent className="p-0" side="left">
              <SheetTitle className="sr-only">移动导航</SheetTitle>
              <SidebarContent
                role={role}
                subtitle={subtitle}
                username={username}
              />
            </SheetContent>
          </Sheet>
        </header>

        <main className="mx-auto w-full max-w-[92rem] px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10 xl:px-10">
          <header className="mb-7 flex flex-col gap-5 border-b pb-7 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
                {eyebrow}
              </p>
              <h1 className="mt-2 text-2xl leading-tight font-semibold tracking-[-0.025em] sm:text-[1.75rem]">
                {title}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            </div>
            {actions ? <div className="shrink-0">{actions}</div> : null}
          </header>
          {children}
        </main>
      </div>
    </div>
  );
}
