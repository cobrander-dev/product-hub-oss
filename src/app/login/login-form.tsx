"use client";

import {
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  UserRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const genericError = "用户名或密码错误";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const hydrated = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    const form = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/auth/sign-in/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: String(form.get("username") ?? ""),
          password: String(form.get("password") ?? ""),
        }),
      });

      if (!response.ok) {
        setError(genericError);
        return;
      }

      router.replace("/login");
      router.refresh();
    } catch {
      setError(genericError);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="mt-8 space-y-5" onSubmit={submit}>
      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="username">
          用户名
        </label>
        <div className="relative">
          <UserRound className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoCapitalize="none"
            autoComplete="username"
            className="pl-10"
            id="username"
            name="username"
            required
          />
        </div>
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="password">
          密码
        </label>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoComplete="current-password"
            className="pr-12 pl-10"
            id="password"
            name="password"
            required
            type={showPassword ? "text" : "password"}
          />
          <button
            aria-label={showPassword ? "隐藏口令" : "显示口令"}
            className="absolute top-0 right-0 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setShowPassword((current) => !current)}
            type="button"
          >
            {showPassword ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </button>
        </div>
      </div>
      <p
        aria-live="polite"
        className="min-h-6 rounded-md text-sm text-danger empty:min-h-0"
        role={error ? "alert" : undefined}
      >
        {error}
      </p>
      <Button className="w-full" disabled={pending || !hydrated} type="submit">
        {pending ? <LoaderCircle className="animate-spin" /> : null}
        {pending ? "正在登录…" : "登录"}
      </Button>
    </form>
  );
}
