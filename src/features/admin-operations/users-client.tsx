"use client";

import { HardDeleteDangerZone } from "@/features/hard-delete/admin-client";
import { Eye, EyeOff, KeyRound, Plus, Power } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  createFactoryUserAction,
  resetFactoryUserPasswordAction,
  setFactoryUserEnabledAction,
} from "@/features/admin-operations/actions";

type Result = { ok: boolean; message?: string };
type Factory = { id: string; name: string; status: string };

function PasswordInput({
  name,
  placeholder,
  label = placeholder,
}: {
  name: string;
  placeholder: string;
  label?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        aria-label={label}
        className="pr-12"
        minLength={8}
        name={name}
        placeholder={placeholder}
        required
        type={visible ? "text" : "password"}
      />
      <button
        aria-label={visible ? "隐藏密码" : "显示密码"}
        className="absolute top-0 right-0 flex size-11 items-center justify-center text-muted-foreground"
        onClick={() => setVisible(!visible)}
        type="button"
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function CreateFactoryUser({ factories }: { factories: Factory[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState("");
  const [factorySearch, setFactorySearch] = useState("");
  const activeFactories = factories.filter(
    (item) =>
      item.status === "ACTIVE" &&
      item.name.toLocaleLowerCase().includes(factorySearch.toLocaleLowerCase()),
  );
  function submit(form: FormData) {
    setNotice("");
    startTransition(async () => {
      const result = (await createFactoryUserAction({
        factoryId: form.get("factoryId"),
        username: form.get("username"),
        password: form.get("password"),
      })) as Result;
      if (!result.ok) return setNotice(result.message ?? "创建失败");
      setOpen(false);
      router.refresh();
    });
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          新建厂家用户
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>新建厂家用户</DialogTitle>
        <DialogDescription>
          账号只能访问所绑定厂家的产品和报价任务。
        </DialogDescription>
        <form action={submit} className="mt-5 space-y-4">
          <div className="space-y-2">
            <label
              className="block text-sm font-medium"
              htmlFor="factory-search"
            >
              搜索厂家
            </label>
            <Input
              id="factory-search"
              onChange={(event) => setFactorySearch(event.target.value)}
              placeholder="输入名称筛选启用厂家"
              value={factorySearch}
            />
            <label className="block text-sm font-medium" htmlFor="factory-id">
              选择厂家
            </label>
            <select
              className="h-11 w-full rounded-md border bg-surface px-3"
              id="factory-id"
              name="factoryId"
              required
              defaultValue=""
            >
              <option disabled value="">
                选择启用厂家
              </option>
              {activeFactories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <label className="block text-sm font-medium">
            用户名
            <Input
              className="mt-2"
              minLength={3}
              name="username"
              placeholder="例如 factory-shanghai"
              required
            />
          </label>
          <label className="block text-sm font-medium">
            初始密码
            <span className="mt-2 block">
              <PasswordInput
                name="password"
                placeholder="至少 8 位"
                label="初始密码"
              />
            </span>
          </label>
          <p aria-live="polite" className="text-sm text-danger">
            {notice}
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOpen(false)} variant="outline">
              取消
            </Button>
            <Button disabled={pending} type="submit">
              {pending ? "正在创建…" : "创建用户"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FactoryUserActions({
  user,
}: {
  user: { id: string; username: string | null; banned: boolean | null };
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"reset" | "status" | null>(null);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState("");
  const enabled = !user.banned;
  function reset(form: FormData) {
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (password !== confirm) return setNotice("两次输入的密码不一致");
    startTransition(async () => {
      const result = (await resetFactoryUserPasswordAction({
        userId: user.id,
        newPassword: password,
      })) as Result;
      if (!result.ok) return setNotice(result.message ?? "重置失败");
      setMode(null);
      router.refresh();
    });
  }
  function changeStatus() {
    startTransition(async () => {
      const result = (await setFactoryUserEnabledAction({
        userId: user.id,
        enabled: !enabled,
      })) as Result;
      if (!result.ok) return setNotice(result.message ?? "状态更新失败");
      setMode(null);
      router.refresh();
    });
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            setNotice("");
            setMode("reset");
          }}
          size="sm"
          variant="outline"
        >
          <KeyRound />
          重置密码
        </Button>
        <Button
          onClick={() => {
            setNotice("");
            setMode("status");
          }}
          size="sm"
          variant={enabled ? "danger" : "secondary"}
        >
          <Power />
          {enabled ? "停用" : "启用"}
        </Button>
      </div>
      <HardDeleteDangerZone targetType="USER" targetId={user.id} />
      <Dialog
        open={mode !== null}
        onOpenChange={(open) => !open && setMode(null)}
      >
        <DialogContent>
          <DialogTitle>
            {mode === "reset"
              ? "重置用户密码"
              : `${enabled ? "停用" : "启用"}用户`}
          </DialogTitle>
          <DialogDescription>
            {mode === "reset"
              ? `为 ${user.username ?? "该用户"} 设置新密码；其他会话将失效。`
              : enabled
                ? "用户将立即无法登录，现有会话也会被撤销。"
                : "用户将恢复登录权限。"}
          </DialogDescription>
          {mode === "reset" ? (
            <form action={reset} className="mt-5 space-y-4">
              <PasswordInput
                name="password"
                placeholder="新密码，至少 8 位"
                label="新密码"
              />
              <PasswordInput
                name="confirm"
                placeholder="再次输入新密码"
                label="确认密码"
              />
              <p aria-live="polite" className="text-sm text-danger">
                {notice}
              </p>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setMode(null)} variant="outline">
                  取消
                </Button>
                <Button disabled={pending} type="submit">
                  确认重置
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-6">
              <p aria-live="polite" className="mb-3 text-sm text-danger">
                {notice}
              </p>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setMode(null)} variant="outline">
                  取消
                </Button>
                <Button
                  disabled={pending}
                  onClick={changeStatus}
                  variant={enabled ? "danger" : "primary"}
                >
                  确认{enabled ? "停用" : "启用"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AdminPasswordForm() {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  async function submit(form: FormData) {
    const next = String(form.get("newPassword") ?? "");
    if (next !== form.get("confirmPassword"))
      return setNotice("两次输入的新密码不一致");
    setPending(true);
    setNotice("");
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: form.get("currentPassword"),
          newPassword: next,
          revokeOtherSessions: true,
        }),
      });
      if (!response.ok) throw new Error("当前密码不正确，或新密码不符合要求");
      setNotice("密码已更新，其他登录会话已撤销。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "密码更新失败");
    } finally {
      setPending(false);
    }
  }
  return (
    <form action={submit} className="mt-5 space-y-4">
      <PasswordInput
        name="currentPassword"
        placeholder="当前密码"
        label="当前密码"
      />
      <PasswordInput
        name="newPassword"
        placeholder="新密码，至少 8 位"
        label="新密码"
      />
      <PasswordInput
        name="confirmPassword"
        placeholder="再次输入新密码"
        label="确认新密码"
      />
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {notice}
      </p>
      <Button disabled={pending} type="submit">
        {pending ? "正在更新…" : "修改密码"}
      </Button>
    </form>
  );
}
