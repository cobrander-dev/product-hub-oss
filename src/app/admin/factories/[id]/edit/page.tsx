import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";
import { FactoryForm } from "@/features/admin/admin-client";
import { getAdminFactory } from "@/features/admin/service";
import { AdminShell } from "@/features/admin/ui";
import { ApplicationError } from "@/lib/application/errors";

export default async function EditFactoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let factory;
  try {
    factory = await getAdminFactory(await headers(), id);
  } catch (error) {
    if (error instanceof ApplicationError && error.kind === "NOT_FOUND")
      notFound();
    throw error;
  }
  return (
    <AdminShell
      title="编辑厂家"
      eyebrow="Factory operations"
      description={factory.name}
    >
      <Card className="max-w-4xl">
        <CardContent className="p-5 sm:p-7">
          <FactoryForm
            factory={{
              id: factory.id,
              name: factory.name,
              contactName: factory.contactName,
              phone: factory.phone,
              notes: factory.notes,
            }}
          />
        </CardContent>
      </Card>
    </AdminShell>
  );
}
