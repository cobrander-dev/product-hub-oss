import { redirect } from "next/navigation";
import { Database, Package2, ShieldCheck } from "lucide-react";

import { LoginForm } from "@/app/login/login-form";
import { getAuthContext } from "@/lib/auth/context";

export default async function LoginPage() {
  const actor = await getAuthContext();
  if (actor) redirect(actor.role === "ADMIN" ? "/admin" : "/factory");

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden px-4 py-10 sm:px-6">
      <div
        className="app-grid pointer-events-none absolute inset-0"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -top-32 left-1/2 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-accent/55 blur-3xl"
        aria-hidden="true"
      />

      <section className="relative w-full max-w-[29rem]">
        <div className="mb-6 flex items-center justify-center gap-3">
          <span className="inline-flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Package2 className="size-5" strokeWidth={1.8} />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-[-0.01em]">
              Product Hub
            </p>
            <p className="text-[11px] text-muted-foreground">
              内部产品资料与厂家报价数据库
            </p>
          </div>
        </div>

        <div className="rounded-xl border bg-surface p-6 shadow-[var(--shadow-float)] sm:p-8">
          <p className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
            Secure workspace
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">
            内部登录
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            使用管理员分配的用户名和密码进入工作台。
          </p>
          <LoginForm />
        </div>

        <div className="mt-5 flex items-center justify-center gap-5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="size-3.5" /> 受控访问
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Database className="size-3.5" /> 独立数据空间
          </span>
        </div>
      </section>
    </main>
  );
}
