import Link from "next/link";

import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/feedback";

export default function AdminNotFound() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-5">
      <div className="w-full max-w-xl">
        <StatePanel
          type="empty"
          title="记录不存在"
          description="该记录可能已不存在，或当前地址无效。"
          action={
            <Button asChild variant="outline">
              <Link href="/admin">返回工作台</Link>
            </Button>
          }
        />
      </div>
    </main>
  );
}
