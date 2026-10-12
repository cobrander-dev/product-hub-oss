"use client";

import { CheckCircle2, LoaderCircle } from "lucide-react";
import { useState, useSyncExternalStore, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PasswordForm() {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const hydrated = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setPending(true);
    setMessage("");
    const form = new FormData(formElement);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmation = String(form.get("confirmPassword") ?? "");
    if (confirmation && newPassword !== confirmation) {
      setMessage("两次输入的新密码不一致。");
      setPending(false);
      const confirmControl = formElement.elements.namedItem("confirmPassword");
      if (confirmControl instanceof HTMLElement) confirmControl.focus();
      return;
    }
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: String(form.get("currentPassword") ?? ""),
          newPassword,
          revokeOtherSessions: true,
        }),
      });
      setMessage(
        response.ok
          ? "密码已更新，其他登录会话已退出。"
          : "密码修改失败，请检查当前密码与新密码要求。",
      );
      if (response.ok) formElement.reset();
    } catch {
      setMessage("密码修改失败，请检查当前密码与新密码要求。");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div>
        <h2 className="text-base font-semibold">登录安全</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          更新后，其他设备上的登录会话会自动退出。
        </p>
      </div>
      <label className="block space-y-2 text-sm font-medium">
        <span>当前密码</span>
        <Input
          autoComplete="current-password"
          name="currentPassword"
          required
          type="password"
        />
      </label>
      <label className="block space-y-2 text-sm font-medium">
        <span>新密码（至少 8 位）</span>
        <Input
          autoComplete="new-password"
          minLength={8}
          name="newPassword"
          required
          type="password"
        />
      </label>
      <label className="block space-y-2 text-sm font-medium">
        <span>确认新密码</span>
        <Input
          autoComplete="new-password"
          minLength={8}
          name="confirmPassword"
          type="password"
        />
      </label>
      <p
        aria-live="polite"
        className="flex min-h-6 items-center gap-2 text-sm text-muted-foreground"
      >
        {message.startsWith("密码已更新") ? (
          <CheckCircle2 className="size-4 text-success" />
        ) : null}
        <span>{message}</span>
      </p>
      <Button disabled={pending || !hydrated} type="submit">
        {pending ? <LoaderCircle className="animate-spin" /> : null}
        {pending ? "正在更新…" : "更新密码"}
      </Button>
    </form>
  );
}
