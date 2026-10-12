"use client";

import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/feedback";

export default function AdminError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-5">
      <div className="w-full max-w-xl">
        <StatePanel
          type="error"
          title="管理工作台暂时无法载入"
          description="数据服务出现异常，请稍后重试。"
          action={
            <Button variant="outline" onClick={reset}>
              重新加载
            </Button>
          }
        />
      </div>
    </main>
  );
}
