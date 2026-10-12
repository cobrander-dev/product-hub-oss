import { headers } from "next/headers";
import { Building2, CircleUserRound, LockKeyhole } from "lucide-react";

import { PasswordForm } from "@/app/factory/password-form";
import { Card, CardContent } from "@/components/ui/card";
import { getFactoryProfile } from "@/features/factory/service";
import { FactoryShell, requireFactoryPageActor } from "@/features/factory/ui";

export const dynamic = "force-dynamic";

export default async function FactoryProfilePage() {
  await requireFactoryPageActor();
  const profile = await getFactoryProfile(await headers());
  return (
    <FactoryShell
      title="账户"
      eyebrow="Profile & security"
      description="查看当前登录身份并安全修改自己的密码。"
    >
      <div className="grid max-w-5xl gap-5 lg:grid-cols-[minmax(0,.8fr)_minmax(22rem,1.2fr)]">
        <Card>
          <CardContent className="grid gap-5 p-5 sm:p-6">
            <div className="flex items-center gap-3 border-b pb-5">
              <CircleUserRound className="size-5 text-muted-foreground" />
              <h2 className="font-semibold">当前账户</h2>
            </div>
            <dl className="grid gap-5 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">用户名</dt>
                <dd className="mt-1 font-medium">{profile.username}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Building2 className="size-3.5" />
                  厂家名称
                </dt>
                <dd className="mt-1 font-medium">{profile.factoryName}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 sm:p-6">
            <div className="mb-5 flex items-center gap-3 border-b pb-5">
              <LockKeyhole className="size-5 text-muted-foreground" />
              <div>
                <h2 className="font-semibold">修改密码</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  不展示或修改系统内部邮箱。
                </p>
              </div>
            </div>
            <PasswordForm />
          </CardContent>
        </Card>
      </div>
    </FactoryShell>
  );
}
