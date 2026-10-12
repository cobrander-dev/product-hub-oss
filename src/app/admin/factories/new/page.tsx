import { Card, CardContent } from "@/components/ui/card";
import { FactoryForm } from "@/features/admin/admin-client";
import { AdminShell } from "@/features/admin/ui";

export default function NewFactoryPage() {
  return (
    <AdminShell
      title="新建厂家"
      eyebrow="Factory operations"
      description="仅建立现有数据模型支持的名称、联系人、电话和内部备注。"
    >
      <Card className="max-w-4xl">
        <CardContent className="p-5 sm:p-7">
          <FactoryForm />
        </CardContent>
      </Card>
    </AdminShell>
  );
}
