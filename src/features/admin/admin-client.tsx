"use client";

import { HardDeleteDangerZone } from "@/features/hard-delete/admin-client";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  Trash2,
  CheckCircle2,
  ImageUp,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";

import {
  assignProductToFactoryAction,
  reactivateAssignmentAction,
  revokeAssignmentAction,
} from "@/features/assignments/actions";
import {
  createCategoryAction,
  setCategoryStatusAction,
  updateCategoryAction,
} from "@/features/categories/actions";
import {
  createFactoryAction,
  setFactoryStatusAction,
  updateFactoryAction,
} from "@/features/factories/actions";
import {
  createMaterialAction,
  setMaterialStatusAction,
  updateMaterialAction,
} from "@/features/materials/actions";
import {
  createProductAction,
  setProductStatusAction,
  updateProductAction,
} from "@/features/products/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";

type ActionResult =
  { ok: true; data?: unknown } | { ok: false; message: string };
type Option = { id: string; name: string; status: string; sku?: string | null };

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      <span>{label}</span>
      {children}
      {hint ? (
        <span className="text-xs font-normal text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function Message({
  value,
}: {
  value: { kind: "success" | "error"; text: string } | null;
}) {
  if (!value) return null;
  return (
    <p
      className={
        value.kind === "error"
          ? "rounded-md bg-danger-surface p-3 text-sm text-danger"
          : "flex items-center gap-2 rounded-md bg-success-surface p-3 text-sm text-success"
      }
      role="status"
    >
      {value.kind === "success" ? <CheckCircle2 className="size-4" /> : null}
      {value.text}
    </p>
  );
}

export function ProductForm({
  categories,
  materials,
  product,
}: {
  categories: Option[];
  materials: Option[];
  product?: {
    id: string;
    sku: string | null;
    name: string;
    categoryId: string;
    materialId: string;
    status: "ENABLED" | "DISABLED";
    notes: string | null;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  function submit(formData: FormData) {
    const input = {
      ...(product ? { id: product.id } : {}),
      sku: String(formData.get("sku") ?? ""),
      name: String(formData.get("name") ?? ""),
      categoryId: String(formData.get("categoryId") ?? ""),
      materialId: String(formData.get("materialId") ?? ""),
      status: String(formData.get("status") ?? "ENABLED"),
      notes: String(formData.get("notes") ?? ""),
    };
    startTransition(async () => {
      const result = (
        product
          ? await updateProductAction(input)
          : await createProductAction(input)
      ) as ActionResult;
      if (!result.ok)
        return setMessage({ kind: "error", text: result.message });
      const id = product?.id ?? (result.data as { id: string }).id;
      router.push(`/admin/products/${id}`);
      router.refresh();
    });
  }
  return (
    <form action={submit} className="grid gap-6" data-testid="product-form">
      <Message value={message} />
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="产品名称">
          <Input
            defaultValue={product?.name ?? ""}
            name="name"
            required
            maxLength={200}
          />
        </Field>
        <Field label="SKU" hint="可留空；填写后在系统内唯一。">
          <Input defaultValue={product?.sku ?? ""} name="sku" maxLength={100} />
        </Field>
        <Field label="分类">
          <select
            className="h-11 rounded-md border bg-surface px-3 text-sm"
            defaultValue={product?.categoryId}
            name="categoryId"
            required
          >
            {categories
              .filter(
                (item) =>
                  item.status === "ACTIVE" || item.id === product?.categoryId,
              )
              .map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                  {item.status !== "ACTIVE" ? "（已停用）" : ""}
                </option>
              ))}
          </select>
        </Field>
        <Field label="材质">
          <select
            className="h-11 rounded-md border bg-surface px-3 text-sm"
            defaultValue={product?.materialId}
            name="materialId"
            required
          >
            {materials
              .filter(
                (item) =>
                  item.status === "ACTIVE" || item.id === product?.materialId,
              )
              .map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                  {item.status !== "ACTIVE" ? "（已停用）" : ""}
                </option>
              ))}
          </select>
        </Field>
        <Field label="状态">
          <select
            className="h-11 rounded-md border bg-surface px-3 text-sm"
            defaultValue={product?.status ?? "ENABLED"}
            name="status"
          >
            <option value="ENABLED">启用</option>
            <option value="DISABLED">停用</option>
          </select>
        </Field>
      </div>
      <Field label="内部备注" hint="仅管理员可见，按纯文本保存。">
        <Textarea
          defaultValue={product?.notes ?? ""}
          name="notes"
          maxLength={5000}
        />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Button disabled={pending} type="submit">
          {pending ? <LoaderCircle className="animate-spin" /> : null}
          {product ? "保存修改" : "创建产品"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          取消
        </Button>
      </div>
    </form>
  );
}

export function FactoryForm({
  factory,
}: {
  factory?: {
    id: string;
    name: string;
    contactName: string | null;
    phone: string | null;
    notes: string | null;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  function submit(formData: FormData) {
    const input = {
      ...(factory ? { id: factory.id } : {}),
      name: String(formData.get("name") ?? ""),
      contactName: String(formData.get("contactName") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      notes: String(formData.get("notes") ?? ""),
    };
    startTransition(async () => {
      const result = (
        factory
          ? await updateFactoryAction(input)
          : await createFactoryAction(input)
      ) as ActionResult;
      if (!result.ok)
        return setMessage({ kind: "error", text: result.message });
      const id = factory?.id ?? (result.data as { id: string }).id;
      router.push(`/admin/factories/${id}`);
      router.refresh();
    });
  }
  return (
    <form action={submit} className="grid gap-6" data-testid="factory-form">
      <Message value={message} />
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="厂家名称">
          <Input defaultValue={factory?.name ?? ""} name="name" required />
        </Field>
        <Field label="联系人">
          <Input defaultValue={factory?.contactName ?? ""} name="contactName" />
        </Field>
        <Field label="联系电话">
          <Input defaultValue={factory?.phone ?? ""} name="phone" />
        </Field>
      </div>
      <Field label="内部备注">
        <Textarea
          defaultValue={factory?.notes ?? ""}
          name="notes"
          maxLength={5000}
        />
      </Field>
      <div className="flex gap-3">
        <Button disabled={pending} type="submit">
          {pending ? <LoaderCircle className="animate-spin" /> : null}
          {factory ? "保存修改" : "创建厂家"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          取消
        </Button>
      </div>
    </form>
  );
}

export function StatusAction({
  kind,
  id,
  active,
}: {
  kind: "product" | "factory" | "assignment";
  id: string;
  active: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function changeStatus() {
    if (
      kind === "assignment" &&
      active &&
      !window.confirm(
        "确认撤销这项产品分配？厂家将无法继续访问，但既有报价、价格历史和厂家私图都会保留。",
      )
    ) {
      return;
    }
    startTransition(async () => {
      let result: ActionResult;
      if (kind === "product")
        result = (await setProductStatusAction({
          id,
          status: active ? "DISABLED" : "ENABLED",
        })) as ActionResult;
      else if (kind === "factory")
        result = (await setFactoryStatusAction({
          id,
          status: active ? "DISABLED" : "ACTIVE",
        })) as ActionResult;
      else
        result = (
          active
            ? await revokeAssignmentAction({ assignmentId: id })
            : await reactivateAssignmentAction({ assignmentId: id })
        ) as ActionResult;
      if (!result.ok) window.alert(result.message);
      router.refresh();
    });
  }
  return (
    <Button
      disabled={pending}
      variant={active ? "danger" : "outline"}
      onClick={changeStatus}
    >
      {pending ? (
        <LoaderCircle className="animate-spin" />
      ) : active ? (
        <Trash2 />
      ) : (
        <RotateCcw />
      )}
      {kind === "assignment"
        ? active
          ? "撤销分配"
          : "重新激活"
        : active
          ? "停用"
          : "启用"}
    </Button>
  );
}

export function AssignmentForm({
  productId,
  factoryId,
  options,
}: {
  productId?: string;
  factoryId?: string;
  options: Option[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  function submit(formData: FormData) {
    startTransition(async () => {
      const result = (await assignProductToFactoryAction({
        productId: productId ?? String(formData.get("productId")),
        factoryId: factoryId ?? String(formData.get("factoryId")),
      })) as ActionResult;
      setMessage(
        result.ok
          ? {
              kind: "success",
              text: "分配已保存；曾撤销的关系会复用原记录重新激活。",
            }
          : { kind: "error", text: result.message },
      );
      if (result.ok) router.refresh();
    });
  }
  return (
    <form
      action={submit}
      className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div>
        {productId ? (
          <select
            aria-label="选择厂家"
            className="h-11 w-full rounded-md border bg-surface px-3 text-sm"
            name="factoryId"
            required
          >
            <option value="">选择启用厂家</option>
            {options
              .filter((item) => item.status === "ACTIVE")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        ) : (
          <select
            aria-label="选择产品"
            className="h-11 w-full rounded-md border bg-surface px-3 text-sm"
            name="productId"
            required
          >
            <option value="">选择启用产品</option>
            {options
              .filter((item) => item.status === "ENABLED")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.sku ? `${item.sku} · ` : ""}
                  {item.name}
                </option>
              ))}
          </select>
        )}
        <Message value={message} />
      </div>
      <Button disabled={pending} type="submit">
        {pending ? <LoaderCircle className="animate-spin" /> : null}添加分配
      </Button>
    </form>
  );
}

export function ImageManager({
  productId,
  hasImage,
}: {
  productId: string;
  hasImage: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return setMessage({ kind: "error", text: "请先选择图片。" });
    setPending(true);
    const form = new FormData();
    form.set("file", file);
    const response = await fetch(`/api/images/products/${productId}/main`, {
      method: "PUT",
      body: form,
    });
    const body = response.ok
      ? null
      : ((await response.json().catch(() => null)) as {
          message?: string;
        } | null);
    setMessage(
      response.ok
        ? { kind: "success", text: hasImage ? "主图已替换。" : "主图已上传。" }
        : { kind: "error", text: body?.message ?? "图片上传失败。" },
    );
    setPending(false);
    if (response.ok) router.refresh();
  }
  return (
    <div className="grid gap-3">
      <Input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
      />
      <p className="text-xs text-muted-foreground">
        JPEG / PNG / WebP，最大 10 MB；上传后统一安全转换为 WebP。
      </p>
      <div className="flex flex-wrap gap-2">
        {hasImage ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">大图预览</Button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl">
              <DialogTitle>产品主图预览</DialogTitle>
              <DialogDescription>
                图片通过受控同源路由读取，不公开存储路径。
              </DialogDescription>
              <div className="mt-4 flex max-h-[70svh] items-center justify-center overflow-hidden rounded-lg border bg-surface-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt="产品主图大图预览"
                  className="max-h-[70svh] max-w-full object-contain"
                  src={`/api/images/products/${productId}/main`}
                />
              </div>
            </DialogContent>
          </Dialog>
        ) : null}
        <Button disabled={pending} onClick={upload}>
          {pending ? <LoaderCircle className="animate-spin" /> : <ImageUp />}
          {hasImage ? "替换主图" : "上传主图"}
        </Button>
      </div>
      <Message value={message} />
    </div>
  );
}

export function PromoteImageButton({
  productId,
  imageId,
}: {
  productId: string;
  imageId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={async () => {
        if (!window.confirm("将这张厂家私图复制为产品主图？原私图会继续保留。"))
          return;
        setPending(true);
        const response = await fetch(
          `/api/images/products/${productId}/main/promote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ factoryImageId: imageId }),
          },
        );
        setPending(false);
        if (!response.ok) window.alert("设置主图失败，请稍后重试。");
        else router.refresh();
      }}
    >
      设为主图
    </Button>
  );
}

export function DictionaryManager({
  kind,
  items,
}: {
  kind: "category" | "material";
  items: Array<{
    id: string;
    name: string;
    status: "ACTIVE" | "DISABLED";
    updatedAt: Date;
    _count: { products: number };
  }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  function create(formData: FormData) {
    startTransition(async () => {
      const result = (
        kind === "category"
          ? await createCategoryAction({ name: String(formData.get("name")) })
          : await createMaterialAction({ name: String(formData.get("name")) })
      ) as ActionResult;
      setMessage(
        result.ok
          ? { kind: "success", text: "已创建。" }
          : { kind: "error", text: result.message },
      );
      if (result.ok) router.refresh();
    });
  }
  return (
    <div className="grid gap-5">
      <form action={create} className="flex gap-2">
        <Input
          name="name"
          aria-label={`新建${kind === "category" ? "分类" : "材质"}`}
          placeholder={`输入${kind === "category" ? "分类" : "材质"}名称`}
          required
        />
        <Button disabled={pending} type="submit">
          新增
        </Button>
      </form>
      <Message value={message} />
      <div className="divide-y rounded-lg border bg-surface">
        {items.map((item) => (
          <DictionaryRow key={item.id} kind={kind} item={item} />
        ))}
      </div>
    </div>
  );
}

function DictionaryRow({
  kind,
  item,
}: {
  kind: "category" | "material";
  item: {
    id: string;
    name: string;
    status: "ACTIVE" | "DISABLED";
    updatedAt: Date;
    _count: { products: number };
  };
}) {
  const router = useRouter();
  const [name, setName] = useState(item.name);
  const [pending, startTransition] = useTransition();
  async function run(mode: "save" | "status") {
    const result =
      mode === "save"
        ? kind === "category"
          ? await updateCategoryAction({ id: item.id, name })
          : await updateMaterialAction({ id: item.id, name })
        : kind === "category"
          ? await setCategoryStatusAction({
              id: item.id,
              status: item.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
            })
          : await setMaterialStatusAction({
              id: item.id,
              status: item.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
            });
    if (!(result as ActionResult).ok)
      window.alert((result as { message: string }).message);
    router.refresh();
  }
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
      <div>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label={`${item.name}名称`}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {item.status === "ACTIVE" ? "启用" : "已停用"} ·{" "}
          {item._count.products} 个产品使用 · 更新于{" "}
          {new Intl.DateTimeFormat("zh-CN", {
            timeZone: "Asia/Shanghai",
          }).format(item.updatedAt)}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={pending || name === item.name}
        onClick={() => startTransition(() => run("save"))}
      >
        保存名称
      </Button>
      <Button
        size="sm"
        variant={item.status === "ACTIVE" ? "danger" : "outline"}
        disabled={pending}
        onClick={() => startTransition(() => run("status"))}
      >
        {item.status === "ACTIVE" ? "停用" : "启用"}
      </Button>
      <div className="sm:col-span-3">
        <HardDeleteDangerZone
          targetType={kind === "category" ? "CATEGORY" : "MATERIAL"}
          targetId={item.id}
        />
      </div>
    </div>
  );
}
