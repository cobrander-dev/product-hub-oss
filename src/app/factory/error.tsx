"use client";

import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/feedback";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="mx-auto max-w-3xl p-6 sm:p-10">
      <StatePanel
        type="error"
        title="暂时无法载入厂家工作台"
        description="请检查网络后重试。你的产品和报价资料不会因此改变。"
        action={<Button onClick={reset}>重新加载</Button>}
      />
    </div>
  );
}
