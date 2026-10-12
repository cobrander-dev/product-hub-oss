"use client";

import {
  CheckCircle2,
  ImageUp,
  LoaderCircle,
  RefreshCcw,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { submitOwnQuoteAction } from "@/features/quotes/actions";

type QuoteValues = {
  price: string;
  moq: string;
  packingLengthCm: string;
  packingWidthCm: string;
  packingHeightCm: string;
  netWeightKg: string;
  grossWeightKg: string;
  pcsPerCarton: string;
  factoryNotes: string;
};

type QuoteData = {
  priceCents: string;
  moq: number | null;
  packingLengthCm: string | null;
  packingWidthCm: string | null;
  packingHeightCm: string | null;
  netWeightKg: string | null;
  grossWeightKg: string | null;
  pcsPerCarton: number | null;
  factoryNotes: string | null;
  version: number;
};

type FieldErrors = Partial<Record<keyof QuoteValues, string>>;

function priceInputValue(cents: string | null) {
  if (cents === null) return "";
  const value = BigInt(cents);
  const fraction = (value % 100n).toString().padStart(2, "0");
  return fraction === "00"
    ? (value / 100n).toString()
    : `${value / 100n}.${fraction.replace(/0$/, "")}`;
}

function valuesFromQuote(quote: QuoteData | null): QuoteValues {
  return {
    price: priceInputValue(quote?.priceCents ?? null),
    moq: quote?.moq?.toString() ?? "",
    packingLengthCm: quote?.packingLengthCm ?? "",
    packingWidthCm: quote?.packingWidthCm ?? "",
    packingHeightCm: quote?.packingHeightCm ?? "",
    netWeightKg: quote?.netWeightKg ?? "",
    grossWeightKg: quote?.grossWeightKg ?? "",
    pcsPerCarton: quote?.pcsPerCarton?.toString() ?? "",
    factoryNotes: quote?.factoryNotes ?? "",
  };
}

function normalized(values: QuoteValues) {
  return JSON.stringify({
    ...values,
    price: values.price.trim(),
    moq: values.moq.trim(),
    packingLengthCm: values.packingLengthCm.trim(),
    packingWidthCm: values.packingWidthCm.trim(),
    packingHeightCm: values.packingHeightCm.trim(),
    netWeightKg: values.netWeightKg.trim(),
    grossWeightKg: values.grossWeightKg.trim(),
    pcsPerCarton: values.pcsPerCarton.trim(),
    factoryNotes: values.factoryNotes.trim(),
  });
}

function validate(values: QuoteValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!/^\d+(?:\.\d{1,2})?$/.test(values.price.trim())) {
    errors.price = "请输入大于 0、最多两位小数的人民币价格";
  } else if (Number(values.price) <= 0) {
    errors.price = "价格必须大于 0";
  }
  const positiveInteger = (key: "moq" | "pcsPerCarton", label: string) => {
    const value = values[key].trim();
    if (value && (!/^\d+$/.test(value) || Number(value) <= 0)) {
      errors[key] = `${label}必须是正整数`;
    }
  };
  positiveInteger("moq", "MOQ");
  positiveInteger("pcsPerCarton", "每箱数量");
  const decimalKeys: Array<[keyof QuoteValues, string]> = [
    ["packingLengthCm", "包装长度"],
    ["packingWidthCm", "包装宽度"],
    ["packingHeightCm", "包装高度"],
    ["netWeightKg", "净重"],
    ["grossWeightKg", "毛重"],
  ];
  for (const [key, label] of decimalKeys) {
    const value = values[key].trim();
    if (
      value &&
      (!/^\d{1,9}(?:\.\d{1,3})?$/.test(value) || Number(value) <= 0)
    ) {
      errors[key] = `${label}必须大于 0，最多保留 3 位小数`;
    }
  }
  if (
    !errors.netWeightKg &&
    !errors.grossWeightKg &&
    values.netWeightKg &&
    values.grossWeightKg &&
    Number(values.grossWeightKg) < Number(values.netWeightKg)
  ) {
    errors.grossWeightKg = "毛重不能小于净重";
  }
  if (values.factoryNotes.length > 5000) {
    errors.factoryNotes = "厂家备注不能超过 5000 个字符";
  }
  return errors;
}

function Field({
  name,
  label,
  unit,
  error,
  children,
}: {
  name: keyof QuoteValues;
  label: string;
  unit?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      <span className="flex items-center justify-between gap-2">
        <span>{label}</span>
        {unit ? (
          <span className="text-xs font-normal text-muted-foreground">
            {unit}
          </span>
        ) : null}
      </span>
      {children}
      {error ? (
        <span className="text-xs font-normal text-danger" id={`${name}-error`}>
          {error}
        </span>
      ) : null}
    </label>
  );
}

function cbmPreview(values: QuoteValues) {
  const dimensions = [
    values.packingLengthCm,
    values.packingWidthCm,
    values.packingHeightCm,
  ];
  if (dimensions.some((value) => !value.trim() || Number(value) <= 0)) {
    return "—";
  }
  return `${(
    dimensions.reduce((total, value) => total * Number(value), 1) / 1_000_000
  ).toFixed(4)} m³`;
}

export function QuoteForm({
  assignmentId,
  quote,
}: {
  assignmentId: string;
  quote: QuoteData | null;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState(() => valuesFromQuote(quote));
  const [baseline, setBaseline] = useState(() =>
    normalized(valuesFromQuote(quote)),
  );
  const [expectedVersion, setExpectedVersion] = useState(
    quote?.version ?? null,
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<{
    kind: "success" | "error" | "conflict";
    text: string;
  } | null>(null);
  const changed = normalized(values) !== baseline;
  const cbm = useMemo(() => cbmPreview(values), [values]);

  function update(name: keyof QuoteValues, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
    setMessage(null);
  }

  function submit() {
    const nextErrors = validate(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setMessage({
        kind: "error",
        text: "请检查标出的字段后再提交。",
      });
      requestAnimationFrame(() => {
        formRef.current
          ?.querySelector<HTMLElement>("[aria-invalid='true']")
          ?.focus();
      });
      return;
    }
    startTransition(async () => {
      const result = await submitOwnQuoteAction({
        assignmentId,
        expectedVersion,
        ...values,
      });
      if (!result.ok) {
        setMessage({
          kind: result.error === "CONFLICT" ? "conflict" : "error",
          text: result.message,
        });
        return;
      }
      const data = result.data as QuoteData;
      setExpectedVersion(data.version);
      setBaseline(normalized(values));
      setMessage({
        kind: "success",
        text: quote ? "报价已更新提交。" : "报价已提交。",
      });
      router.refresh();
    });
  }

  const input = (name: keyof QuoteValues, inputMode: "decimal" | "numeric") => (
    <Input
      aria-describedby={errors[name] ? `${name}-error` : undefined}
      aria-invalid={Boolean(errors[name])}
      inputMode={inputMode}
      name={name}
      onChange={(event) => update(name, event.target.value)}
      type="text"
      value={values[name]}
    />
  );

  return (
    <form
      ref={formRef}
      action={submit}
      className="grid gap-7"
      data-testid="quote-form"
      noValidate
    >
      {message ? (
        <div
          className={
            message.kind === "success"
              ? "flex items-start gap-2 rounded-lg bg-success-surface p-4 text-sm text-success"
              : "rounded-lg bg-danger-surface p-4 text-sm text-danger"
          }
          role={message.kind === "success" ? "status" : "alert"}
        >
          {message.kind === "success" ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          ) : null}
          <div>
            <p>{message.text}</p>
            {message.kind === "conflict" ? (
              <Button
                className="mt-3"
                onClick={() => window.location.reload()}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCcw />
                刷新最新数据
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <section className="grid gap-4">
        <div>
          <h2 className="font-semibold">工厂价格</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            直接输入人民币元，例如 328、328.5 或 328.50。
          </p>
        </div>
        <div className="max-w-sm">
          <Field
            name="price"
            label="人民币价格"
            unit="¥ / 元"
            error={errors.price}
          >
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                ¥
              </span>
              <Input
                aria-describedby={errors.price ? "price-error" : undefined}
                aria-invalid={Boolean(errors.price)}
                className="pl-8 text-base font-semibold"
                inputMode="decimal"
                name="price"
                onChange={(event) => update("price", event.target.value)}
                type="text"
                value={values.price}
              />
            </div>
          </Field>
        </div>
      </section>

      <section className="grid gap-4 border-t pt-6">
        <div>
          <h2 className="font-semibold">起订与包装</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            可选字段可以留空；CBM 由系统根据完整尺寸计算。
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field name="moq" label="MOQ" unit="PCS" error={errors.moq}>
            {input("moq", "numeric")}
          </Field>
          <Field
            name="pcsPerCarton"
            label="每箱数量"
            unit="PCS/箱"
            error={errors.pcsPerCarton}
          >
            {input("pcsPerCarton", "numeric")}
          </Field>
          <div className="rounded-lg border bg-surface-muted/45 p-4">
            <p className="text-xs font-medium text-muted-foreground">
              系统计算 CBM
            </p>
            <p className="numeric mt-2 text-lg font-semibold">{cbm}</p>
          </div>
          <Field
            name="packingLengthCm"
            label="包装长度"
            unit="cm"
            error={errors.packingLengthCm}
          >
            {input("packingLengthCm", "decimal")}
          </Field>
          <Field
            name="packingWidthCm"
            label="包装宽度"
            unit="cm"
            error={errors.packingWidthCm}
          >
            {input("packingWidthCm", "decimal")}
          </Field>
          <Field
            name="packingHeightCm"
            label="包装高度"
            unit="cm"
            error={errors.packingHeightCm}
          >
            {input("packingHeightCm", "decimal")}
          </Field>
        </div>
      </section>

      <section className="grid gap-4 border-t pt-6">
        <div>
          <h2 className="font-semibold">重量</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            净重和毛重均以 kg 填写。
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="netWeightKg"
            label="净重"
            unit="kg"
            error={errors.netWeightKg}
          >
            {input("netWeightKg", "decimal")}
          </Field>
          <Field
            name="grossWeightKg"
            label="毛重"
            unit="kg"
            error={errors.grossWeightKg}
          >
            {input("grossWeightKg", "decimal")}
          </Field>
        </div>
      </section>

      <section className="grid gap-4 border-t pt-6">
        <Field name="factoryNotes" label="厂家备注" error={errors.factoryNotes}>
          <Textarea
            aria-describedby={
              errors.factoryNotes ? "factoryNotes-error" : undefined
            }
            aria-invalid={Boolean(errors.factoryNotes)}
            maxLength={5000}
            name="factoryNotes"
            onChange={(event) => update("factoryNotes", event.target.value)}
            rows={5}
            value={values.factoryNotes}
          />
        </Field>
        <p className="text-right text-xs text-muted-foreground">
          {values.factoryNotes.length} / 5000
        </p>
      </section>

      <div className="sticky bottom-0 z-10 -mx-5 border-t bg-surface/95 px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:mx-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:backdrop-blur-none">
        <Button
          className="w-full sm:w-auto"
          disabled={pending || (quote !== null && !changed)}
          type="submit"
        >
          {pending ? <LoaderCircle className="animate-spin" /> : null}
          {pending
            ? "正在提交…"
            : quote
              ? changed
                ? "更新提交"
                : "没有需要提交的修改"
              : "提交"}
        </Button>
      </div>
    </form>
  );
}

export function MainImagePreview({
  src,
  productName,
}: {
  src: string;
  productName: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">查看大图</Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
        <DialogTitle>产品主图</DialogTitle>
        <DialogDescription>{productName}，仅供查看。</DialogDescription>
        <div className="mt-4 flex max-h-[70svh] items-center justify-center overflow-hidden rounded-lg border bg-surface-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={`${productName}主图大图预览`}
            className="max-h-[70svh] max-w-full object-contain"
            src={src}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function FactoryPrivateImageManager({
  assignmentId,
  image,
  productName,
}: {
  assignmentId: string;
  image: { url: string } | null;
  productName: string;
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
    if (!file) {
      setMessage({ kind: "error", text: "请先选择图片。" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setMessage({ kind: "error", text: "图片不能超过 10 MB。" });
      return;
    }
    setPending(true);
    setMessage(null);
    const form = new FormData();
    form.set("file", file);
    const response = await fetch(
      `/api/images/assignments/${assignmentId}/private`,
      { method: "PUT", body: form },
    );
    const body = response.ok
      ? null
      : ((await response.json().catch(() => null)) as {
          message?: string;
        } | null);
    setMessage(
      response.ok
        ? {
            kind: "success",
            text: image ? "厂家图片已更换。" : "厂家图片已上传。",
          }
        : { kind: "error", text: body?.message ?? "图片上传失败。" },
    );
    setPending(false);
    if (response.ok) router.refresh();
  }

  async function remove() {
    if (!window.confirm("确定移除这张厂家图片吗？")) return;
    setPending(true);
    setMessage(null);
    const response = await fetch(
      `/api/images/assignments/${assignmentId}/private`,
      { method: "DELETE" },
    );
    setMessage(
      response.ok
        ? { kind: "success", text: "厂家图片已移除。" }
        : { kind: "error", text: "图片移除失败，请稍后重试。" },
    );
    setPending(false);
    if (response.ok) router.refresh();
  }

  return (
    <div className="grid gap-4">
      {image ? (
        <Dialog>
          <DialogTrigger asChild>
            <button
              className="aspect-[4/3] overflow-hidden rounded-xl border bg-surface-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={`${productName}厂家图片`}
                className="size-full object-contain"
                src={image.url}
              />
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-4xl">
            <DialogTitle>厂家图片</DialogTitle>
            <DialogDescription>
              你所在厂家针对该产品上传的图片。
            </DialogDescription>
            <div className="mt-4 flex max-h-[70svh] items-center justify-center overflow-hidden rounded-lg border bg-surface-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={`${productName}厂家图片大图预览`}
                className="max-h-[70svh] max-w-full object-contain"
                src={image.url}
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : (
        <div className="flex aspect-[4/3] items-center justify-center rounded-xl border border-dashed bg-surface-muted/35 px-5 text-center text-sm text-muted-foreground">
          还没有厂家图片
        </div>
      )}
      <Input
        ref={fileRef}
        accept="image/jpeg,image/png,image/webp"
        aria-label="选择厂家图片"
        type="file"
      />
      <p className="text-xs leading-5 text-muted-foreground">
        JPEG、PNG 或 WebP，最大 10 MB。上传处理中不会显示虚假的进度百分比。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={upload} type="button">
          {pending ? <LoaderCircle className="animate-spin" /> : <ImageUp />}
          {image ? "更换图片" : "上传图片"}
        </Button>
        {image ? (
          <Button
            disabled={pending}
            onClick={remove}
            type="button"
            variant="danger"
          >
            <Trash2 />
            移除图片
          </Button>
        ) : null}
      </div>
      {message ? (
        <p
          className={
            message.kind === "success"
              ? "text-sm text-success"
              : "text-sm text-danger"
          }
          role={message.kind === "success" ? "status" : "alert"}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
