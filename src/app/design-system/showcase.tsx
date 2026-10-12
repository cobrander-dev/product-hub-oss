"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleHelp,
  Ellipsis,
  ImageIcon,
  Menu,
  Package2,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/controls";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { RetryState, Skeleton, StatePanel } from "@/components/ui/feedback";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/floating";
import { Input, Textarea } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const colors = [
  ["Background", "bg-background"],
  ["Surface", "bg-surface"],
  ["Surface muted", "bg-surface-muted"],
  ["Primary", "bg-primary"],
  ["Secondary", "bg-secondary"],
  ["Success", "bg-success"],
  ["Warning", "bg-warning"],
  ["Danger", "bg-danger"],
  ["Info", "bg-info"],
] as const;

function Section({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t py-10 first:border-t-0 first:pt-0 sm:py-14">
      <div className="mb-7 grid gap-3 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.16em] text-primary uppercase">
            {eyebrow}
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-[-0.02em]">
            {title}
          </h2>
        </div>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

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
    <label className="block space-y-2 text-sm font-medium">
      <span>{label}</span>
      {children}
      {hint ? (
        <span className="block text-xs leading-5 font-normal text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function ProductImageSlot({ compact }: { compact?: boolean }) {
  return (
    <div
      className={`flex items-center justify-center rounded-md border bg-surface-muted text-muted-foreground ${compact ? "size-11" : "aspect-[4/3] w-full"}`}
    >
      <div className="text-center">
        <ImageIcon className={compact ? "size-4" : "mx-auto size-6"} />
        {!compact ? (
          <p className="mt-2 text-[10px] font-medium">待上传主图</p>
        ) : null}
      </div>
    </div>
  );
}

export function DesignSystemShowcase() {
  const [toast, setToast] = useState(false);

  return (
    <TooltipProvider>
      <main className="min-h-svh bg-background">
        <header className="sticky top-0 z-40 border-b bg-background/92 backdrop-blur-md">
          <div className="mx-auto flex h-16 max-w-[90rem] items-center justify-between px-4 sm:px-6 lg:px-10">
            <div className="flex items-center gap-3">
              <span className="inline-flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Package2 className="size-[18px]" />
              </span>
              <div>
                <p className="text-sm font-semibold">Product Hub</p>
                <p className="text-[10px] text-muted-foreground">
                  Design System · Dev only
                </p>
              </div>
            </div>
            <Badge variant="warning">Fixture 展示</Badge>
          </div>
        </header>

        <div className="mx-auto max-w-[90rem] px-4 py-10 sm:px-6 lg:px-10 lg:py-14">
          <div className="mb-12 max-w-3xl">
            <p className="text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
              Phase 03 foundation
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
              让数据安静地成为主角
            </h1>
            <p className="mt-4 text-base leading-7 text-muted-foreground">
              面向中文 B2B
              数据工作的浅色界面系统。以排版、对齐、细边框和明确状态建立品质，不依赖装饰性效果。
            </p>
          </div>

          <Section
            eyebrow="01 · Foundations"
            title="颜色与排版"
            description="低饱和中性色承载长时间工作，蓝绿色仅用于操作与焦点；状态色必须与文字共同表达语义。"
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {colors.map(([name, color]) => (
                <div
                  className="overflow-hidden rounded-lg border bg-surface"
                  key={name}
                >
                  <div className={`h-16 border-b ${color}`} />
                  <p className="px-3 py-2.5 text-xs font-medium">{name}</p>
                </div>
              ))}
            </div>
            <div className="mt-6 grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
              <Card>
                <CardContent className="space-y-6 p-6">
                  <div>
                    <p className="text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
                      Display
                    </p>
                    <p className="mt-2 text-3xl font-semibold tracking-[-0.035em]">
                      产品资料，清晰可循
                    </p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold tracking-tight">
                      中文标题与 English units
                    </p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      适合持续阅读的正文行高，以及更明确的次级说明。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-x-7 gap-y-2 text-xs text-muted-foreground">
                    <span>Caption · 更新于 10:24</span>
                    <span className="font-medium text-foreground">
                      Label · 厂家价格
                    </span>
                    <span className="font-mono">SKU · PH-240918</span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="grid gap-4 p-6">
                  {["¥328.50", "7.80 kg", "0.0567 m³", "1,240 PCS"].map(
                    (value) => (
                      <div
                        className="numeric flex items-baseline justify-between border-b pb-3 last:border-b-0 last:pb-0"
                        key={value}
                      >
                        <span className="text-xs text-muted-foreground">
                          Numeric
                        </span>
                        <strong className="text-lg font-semibold">
                          {value}
                        </strong>
                      </div>
                    ),
                  )}
                </CardContent>
              </Card>
            </div>
          </Section>

          <Section
            eyebrow="02 · Actions"
            title="按钮与浮层"
            description="常用动作保持 44px 触控高度。Dialog 用于确认，Sheet/Drawer 用于移动导航或辅助编辑，焦点由 Radix 管理。"
          >
            <div className="flex flex-wrap items-center gap-3">
              <Button>主要操作</Button>
              <Button variant="secondary">次要操作</Button>
              <Button variant="outline">边框按钮</Button>
              <Button variant="ghost">文字按钮</Button>
              <Button variant="danger">危险操作</Button>
              <Button disabled>不可用</Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button aria-label="帮助" size="icon" variant="outline">
                    <CircleHelp />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>查看字段说明</TooltipContent>
              </Tooltip>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline">打开 Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogTitle>确认更新资料？</DialogTitle>
                  <DialogDescription>
                    此示例只验证弹层层级、键盘焦点和操作布局，不会写入任何数据。
                  </DialogDescription>
                  <div className="mt-6 flex justify-end gap-2">
                    <DialogClose asChild>
                      <Button variant="ghost">取消</Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button>确认更新</Button>
                    </DialogClose>
                  </div>
                </DialogContent>
              </Dialog>
              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="outline">
                    <Menu />
                    打开 Sheet
                  </Button>
                </SheetTrigger>
                <SheetContent side="left">
                  <SheetTitle className="text-lg font-semibold">
                    移动导航
                  </SheetTitle>
                  <SheetDescription className="mt-2 text-sm text-muted-foreground">
                    真实手机体验使用独立导航结构。
                  </SheetDescription>
                  <div className="mt-6 space-y-1">
                    {["概览", "产品", "账户资料"].map((item) => (
                      <button
                        className="flex min-h-11 w-full items-center rounded-md px-3 text-sm font-medium hover:bg-muted"
                        key={item}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </SheetContent>
              </Sheet>
              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="outline">打开 Drawer</Button>
                </SheetTrigger>
                <SheetContent side="right">
                  <SheetTitle className="text-lg font-semibold">
                    快速查看
                  </SheetTitle>
                  <SheetDescription className="mt-2 text-sm text-muted-foreground">
                    桌面端辅助信息，不替代长表单页面。
                  </SheetDescription>
                  <div className="mt-6">
                    <StatePanel
                      compact
                      type="empty"
                      title="暂无记录"
                      description="这里会展示与当前对象相关的信息。"
                    />
                  </div>
                </SheetContent>
              </Sheet>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    更多操作 <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem>查看详情</DropdownMenuItem>
                  <DropdownMenuItem>复制 SKU</DropdownMenuItem>
                  <DropdownMenuItem className="text-danger">
                    停用项目
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline">
                    <SlidersHorizontal />
                    筛选
                  </Button>
                </PopoverTrigger>
                <PopoverContent>
                  <p className="text-sm font-semibold">快速筛选</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    后续业务筛选会同步到 URL。
                  </p>
                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-sm">仅显示启用项</span>
                    <Switch aria-label="仅显示启用项" defaultChecked />
                  </div>
                </PopoverContent>
              </Popover>
              <Button
                onClick={() => {
                  setToast(true);
                  window.setTimeout(() => setToast(false), 2600);
                }}
                variant="outline"
              >
                显示 Toast
              </Button>
            </div>
          </Section>

          <Section
            eyebrow="03 · Forms"
            title="表单语言"
            description="标签、帮助文字、单位和错误各有固定位置；数字单位使用紧凑附加区，不让表单变成单位墙。"
          >
            <Card>
              <CardContent className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6 lg:grid-cols-4">
                <Field label="产品名称">
                  <Input placeholder="输入产品名称" />
                </Field>
                <Field label="人民币价格" hint="正常报价必须大于 ¥0">
                  <div className="relative">
                    <span className="absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">
                      ¥
                    </span>
                    <Input
                      className="numeric pl-8"
                      inputMode="decimal"
                      placeholder="0.00"
                    />
                  </div>
                </Field>
                <Field label="毛重">
                  <div className="relative">
                    <Input
                      className="numeric pr-11"
                      inputMode="decimal"
                      placeholder="0.000"
                    />
                    <span className="absolute top-1/2 right-3 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                      kg
                    </span>
                  </div>
                </Field>
                <Field label="分类">
                  <Select>
                    <SelectTrigger>
                      <SelectValue placeholder="选择分类" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="shower">淋浴系统</SelectItem>
                      <SelectItem value="faucet">龙头</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="搜索">
                  <div className="relative">
                    <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="pl-9"
                      placeholder="搜索 SKU 或名称"
                      type="search"
                    />
                  </div>
                </Field>
                <Field label="无效状态" hint="请输入大于 0 的金额">
                  <Input
                    aria-invalid
                    className="border-danger focus-visible:border-danger focus-visible:ring-danger/15"
                    defaultValue="0"
                  />
                </Field>
                <Field label="只读字段">
                  <Input readOnly value="系统自动计算" />
                </Field>
                <Field label="不可用字段">
                  <Input disabled value="当前不可编辑" />
                </Field>
                <div className="space-y-4 sm:col-span-2">
                  <p className="text-sm font-medium">选项控制</p>
                  <label className="flex min-h-11 items-center gap-3 text-sm">
                    <Checkbox defaultChecked />
                    保存筛选条件
                  </label>
                  <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
                    <span>启用产品</span>
                    <Switch defaultChecked />
                  </label>
                </div>
                <div className="sm:col-span-2">
                  <Field label="备注">
                    <Textarea placeholder="补充必要的内部说明" />
                  </Field>
                </div>
              </CardContent>
            </Card>
          </Section>

          <Section
            eyebrow="04 · Data display"
            title="表格、卡片与数值"
            description="以下为明确标记的视觉 fixture，不连接数据库。桌面表格用于比较，移动端在 768px 以下改为数据卡片。"
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Badge>视觉 Fixture</Badge>
                <span className="text-xs text-muted-foreground">
                  仅验证扫描节奏
                </span>
              </div>
              <div className="flex gap-2">
                <span className="inline-flex min-h-9 items-center rounded-full border bg-surface px-3 text-xs">
                  分类：淋浴系统 <X className="ml-2 size-3" />
                </span>
              </div>
            </div>
            <Card className="hidden overflow-hidden md:block">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">产品数据表视觉示例</caption>
                  <thead className="bg-surface-muted/70 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    <tr>
                      {[
                        "产品",
                        "SKU",
                        "分类",
                        "厂家",
                        "价格",
                        "毛重",
                        "状态",
                        "更新时间",
                        "",
                      ].map((item) => (
                        <th
                          className="h-11 border-b px-4 font-semibold"
                          key={item}
                        >
                          {item}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="transition-colors hover:bg-surface-muted/45">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <ProductImageSlot compact />
                          <span className="font-medium">恒温淋浴系统</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">PH-240918</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        淋浴系统
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        Fixture 厂家
                      </td>
                      <td className="numeric px-4 py-3 font-semibold">
                        ¥328.50
                      </td>
                      <td className="numeric px-4 py-3">7.80 kg</td>
                      <td className="px-4 py-3">
                        <Badge variant="success">已启用</Badge>
                      </td>
                      <td className="numeric px-4 py-3 text-xs text-muted-foreground">
                        2026-09-18
                      </td>
                      <td className="px-4 py-3">
                        <Button
                          aria-label="更多操作"
                          size="icon"
                          variant="ghost"
                        >
                          <Ellipsis />
                        </Button>
                      </td>
                    </tr>
                    <tr aria-disabled className="bg-muted/25 opacity-55">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <ProductImageSlot compact />
                          <span className="font-medium">停用行示例</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">PH-000002</td>
                      <td className="px-4 py-3 text-muted-foreground">龙头</td>
                      <td className="px-4 py-3 text-muted-foreground">—</td>
                      <td className="numeric px-4 py-3 text-muted-foreground">
                        未报价
                      </td>
                      <td className="px-4 py-3">—</td>
                      <td className="px-4 py-3">
                        <Badge>已停用</Badge>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        —
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="flex min-h-14 items-center justify-between border-t px-4">
                <p className="text-xs text-muted-foreground">
                  第 1–2 项，共 2 项
                </p>
                <div className="flex gap-2">
                  <Button disabled size="sm" variant="outline">
                    上一页
                  </Button>
                  <Button disabled size="sm" variant="outline">
                    下一页
                  </Button>
                </div>
              </div>
            </Card>
            <div className="grid gap-3 md:hidden">
              <Card>
                <CardContent className="p-4">
                  <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-4">
                    <ProductImageSlot />
                    <div className="min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-mono text-[11px] text-muted-foreground">
                            PH-240918
                          </p>
                          <h3 className="mt-1 font-semibold">恒温淋浴系统</h3>
                        </div>
                        <Badge variant="success">已启用</Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        淋浴系统 · Fixture 厂家
                      </p>
                      <p className="numeric mt-4 text-lg font-semibold">
                        ¥328.50
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardContent className="p-5">
                  <p className="text-xs font-medium text-muted-foreground">
                    价格
                  </p>
                  <p className="numeric mt-3 text-2xl font-semibold tracking-tight">
                    ¥328.50
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    人民币工厂价
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-5">
                  <p className="text-xs font-medium text-muted-foreground">
                    包装体积
                  </p>
                  <p className="numeric mt-3 text-2xl font-semibold tracking-tight">
                    0.0567 m³
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    系统计算预览
                  </p>
                </CardContent>
              </Card>
            </div>
          </Section>

          <Section
            eyebrow="05 · States"
            title="完整状态"
            description="状态与最终布局同构，避免只设计“有数据”这一种理想情况。大型插画不会占据工作区域。"
          >
            <Tabs defaultValue="empty">
              <TabsList className="max-w-full overflow-x-auto">
                <TabsTrigger value="empty">空状态</TabsTrigger>
                <TabsTrigger value="search">无结果</TabsTrigger>
                <TabsTrigger value="error">错误</TabsTrigger>
                <TabsTrigger value="loading">加载</TabsTrigger>
                <TabsTrigger value="forbidden">无权限</TabsTrigger>
              </TabsList>
              <TabsContent className="mt-4" value="empty">
                <StatePanel
                  title="暂无产品"
                  description="产品建立后会显示在这里。"
                  type="empty"
                />
              </TabsContent>
              <TabsContent className="mt-4" value="search">
                <StatePanel
                  action={<Button variant="outline">清除筛选</Button>}
                  title="没有匹配结果"
                  description="尝试调整关键词或清除当前筛选条件。"
                  type="search"
                />
              </TabsContent>
              <TabsContent className="mt-4" value="error">
                <RetryState />
              </TabsContent>
              <TabsContent className="mt-4" value="loading">
                <Card>
                  <CardContent className="space-y-4 p-5">
                    <Skeleton className="h-6 w-32" />
                    <Skeleton className="h-11 w-full" />
                    <Skeleton className="h-11 w-full" />
                    <Skeleton className="h-11 w-4/5" />
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent className="mt-4" value="forbidden">
                <StatePanel
                  title="无法访问此内容"
                  description="该内容不存在，或当前账号没有查看权限。"
                  type="forbidden"
                />
              </TabsContent>
            </Tabs>
          </Section>

          <Section
            eyebrow="06 · Responsive"
            title="移动表单与底部操作"
            description="复杂编辑在手机端采用全屏或底部 Sheet，并预留安全区；关键操作不依赖 hover。"
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold">报价表单片段</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        桌面双列，手机单列
                      </p>
                    </div>
                    <Badge variant="info">Responsive</Badge>
                  </div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <Field label="MOQ">
                      <div className="relative">
                        <Input className="numeric pr-12" inputMode="numeric" />
                        <span className="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">
                          PCS
                        </span>
                      </div>
                    </Field>
                    <Field label="装箱数量">
                      <div className="relative">
                        <Input className="numeric pr-20" inputMode="numeric" />
                        <span className="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">
                          PCS/箱
                        </span>
                      </div>
                    </Field>
                  </div>
                  <div className="mt-5 flex justify-end gap-2 border-t pt-4">
                    <Button variant="ghost">取消</Button>
                    <Button>保存资料</Button>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-warning/25 bg-warning-surface/45">
                <CardContent className="flex gap-3 p-5">
                  <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
                  <div>
                    <p className="text-sm font-semibold">离线状态预留</p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      网络不可用时保留已输入内容，并明确提示尚未保存；本阶段只定义视觉，不实现业务缓存。
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </Section>
        </div>

        {toast ? (
          <div
            aria-live="polite"
            className="fixed right-4 bottom-4 z-[70] flex max-w-[calc(100%-2rem)] items-center gap-3 rounded-lg border bg-foreground px-4 py-3 text-sm text-background shadow-[var(--shadow-overlay)]"
          >
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-success text-white">
              <Check className="size-3" />
            </span>
            <span>视觉状态已更新</span>
          </div>
        ) : null}
      </main>
    </TooltipProvider>
  );
}
