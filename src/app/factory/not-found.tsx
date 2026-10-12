import Link from "next/link";

import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/feedback";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-3xl p-6 sm:p-10">
      <StatePanel
        type="empty"
        title="该产品当前不可访问"
        description="产品可能已被撤销分配或停用。请返回产品列表查看当前可用内容。"
        action={
          <Button asChild>
            <Link href="/factory/products">返回产品列表</Link>
          </Button>
        }
      />
    </div>
  );
}
