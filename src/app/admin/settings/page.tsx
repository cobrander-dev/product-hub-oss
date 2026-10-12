import { headers } from "next/headers";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { AdminPasswordForm } from "@/features/admin-operations/users-client";

import { DictionaryManager } from "@/features/admin/admin-client";
import { getAdminDictionaries } from "@/features/admin/service";
import { AdminShell } from "@/features/admin/ui";
import { requireAdmin } from "@/lib/auth/context";

export default async function SettingsPage() {
  const [dictionaries, actor] = await Promise.all([
    getAdminDictionaries(await headers()),
    requireAdmin(),
  ]);
  return (
    <AdminShell
      title="设置"
      eyebrow="Admin settings"
      description="管理基础字典、数据工具和当前管理员账户安全。"
    >
      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-xl border bg-surface p-5 sm:p-6">
          <div className="mb-5">
            <h2 className="font-semibold">产品分类</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              只有启用分类可用于新建或重新绑定产品。
            </p>
          </div>
          <DictionaryManager kind="category" items={dictionaries.categories} />
        </section>
        <section className="rounded-xl border bg-surface p-5 sm:p-6">
          <div className="mb-5">
            <h2 className="font-semibold">产品材质</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              只有启用材质可用于新建或重新绑定产品。
            </p>
          </div>
          <DictionaryManager kind="material" items={dictionaries.materials} />
        </section>
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <section className="rounded-xl border bg-surface p-5 sm:p-6">
          <h2 className="font-semibold">数据工具</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            下载模板、导入产品或进入带筛选的导出工作区。
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/admin/products/import">产品导入</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/products">产品导出</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/quotes">报价导出</Link>
            </Button>
          </div>
        </section>
        <section className="rounded-xl border bg-surface p-5 sm:p-6">
          <h2 className="font-semibold">管理员账户</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            当前账号：{actor.username} · ADMIN。修改密码会撤销其他会话。
          </p>
          <AdminPasswordForm />
        </section>
      </div>
      <section className="mt-6 rounded-xl border bg-surface p-5 sm:p-6">
        <h2 className="font-semibold">系统信息</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Product Hub V1 · Phase 10C 完成后进入 Feature
          Freeze。系统不会在此页面展示密钥、数据库地址或其他敏感配置。
        </p>
      </section>
    </AdminShell>
  );
}
