# Product Hub Design System

## Hard Delete interaction contract

Danger Zone 具有文字危险提示和独立边框；移动 390px modal 限高滚动、精确短语 input 有 label、键盘取消/Esc 与焦点返回。确认后展示真实异步阶段、文件完成/总数和自动重试；仅 COMPLETED 为成功，其他状态不 optimistic hide。

状态：Phase 03 已实现基线

更新时间：2026-09-18

## 1. 方向

视觉目标：modern premium B2B SaaS，高级、现代、克制、整洁、协调。产品图片和业务信息是主角，界面通过排版、留白、层级和细节建立品质，不依赖大面积渐变、玻璃拟态或夸张动画。

默认采用明亮中性界面；是否提供深色主题不属于 V1 必需范围。禁止传统 Bootstrap Admin、过度蓝色企业后台、黑金炫光和装饰性仪表盘。

## 2. Token

Phase 01 通过 CSS variables + Tailwind v4 `@theme` 固化：

- Color：background、surface、surface-subtle、foreground、muted、border、primary、success、warning、danger、focus。
- Typography：中文优先系统/本地可用字体栈，拉丁数字可配 Geist；正文、caption、label、title、display 有固定尺寸/行高/字重。
- Spacing：4px 基础刻度，常用 8/12/16/24/32；单页只使用一种密度体系。
- Radius：控件、中卡片、大容器三档，避免每个组件随意圆角。
- Shadow：仅浮层/抬升状态使用细微阴影，分隔优先 fine border。
- Motion：fast/normal/slow 三档；统一 easing；支持 `prefers-reduced-motion`。

颜色不直接承担唯一语义，状态同时使用文字/图标。对比度满足 WCAG 2.2 AA。

## 3. 组件策略

shadcn/ui 使用 new-york 风格、Radix primitives，组件源码入库并按需安装。优先：Button、Input、Textarea、Select、Checkbox、Label、Form、Table、Card、Badge、Dialog、AlertDialog、Sheet、Drawer、Tabs、DropdownMenu、Popover、Command、Tooltip、Skeleton、Alert、Sonner、Pagination。

- 不复制粘贴多套同类组件。
- 业务组件封装在 feature 下，基础组件保持通用。
- destructive 操作用 AlertDialog；普通编辑用 Dialog/Sheet；手机复杂编辑使用全屏页或全屏 Sheet。
- 所有弹层具备焦点管理、Esc、可见标题和返回焦点。

## 4. 信息架构

### 桌面

- 固定/可折叠 Sidebar：身份、主导航、账号入口。
- 顶部区域：页面标题、摘要、搜索/筛选、主操作。
- 数据密集列表以 Table 为主，产品浏览允许 Table/Gallery 切换。
- 详情页采用清晰 header + 状态 + 主内容 + 辅助信息，不堆叠多层 Card。
- 快速编辑可用右侧 Drawer；长表单进入专用详情页。

### 移动

- 使用移动导航，不保留压缩 sidebar。
- 产品列表默认 Product Cards：图、SKU/名称、状态、关键报价摘要和明确点击区。
- 筛选放 Bottom Sheet/Sheet；编辑报价使用全屏表单，底部固定主操作且避开安全区。
- Table 只用于真正需要横向比较的场景，并提供卡片替代，不依赖横向滚动完成核心任务。
- 触控目标至少约 44×44px，输入类型和数字键盘与字段匹配。

## 5. 页面模式

### Login

单一聚焦卡片，用户名、密码、显示/隐藏密码、提交、通用错误。不得显示注册入口或邮箱登录暗示。

### Product list

服务端搜索/筛选/分页；桌面 Table/Gallery 切换，移动 Card；筛选状态保存在 URL。空库、无搜索结果、无分配是不同 empty state。

### Quote edit

产品主图和身份信息固定可见；字段按价格、包装、重量、图片分组；CBM 即时预览但标注由系统计算并默认显示 4 位小数。首次提交按钮“提交”，之后“更新提交”。冲突、校验错误和上传进度有明确状态。

### Activity

按时间线/表格展示 actor、时间、动作、实体和可读 diff。敏感字段不出现，JSON 不直接倾倒给最终用户。

## 6. 状态设计

每个页面/组件必须定义：

- Initial loading：布局匹配的 Skeleton，避免跳动。
- Empty：说明原因和下一步；Factory 无分配不显示 Admin 操作。
- No results：保留筛选上下文并提供清除筛选。
- Validation error：字段旁错误 + 顶部摘要，焦点移动到首个错误。
- Server/network error：安全文案、request ID（如适用）、重试。
- Permission/not found：不泄露其他厂家资源。
- Saving/uploading：按钮 busy、避免重复提交；可取消时明确。
- Success：Toast + 页面数据一致更新，不以 toast 代替持久状态。

## 7. 图片体验

- 固定 aspect ratio 容器、object-fit、稳定 placeholder，避免 layout shift。
- 预览支持键盘关闭、上一张/下一张和清晰 alt。
- 上传前显示格式/大小要求；失败保留表单数据并允许重试。
- Product main 与 Factory private 使用清晰标签，Admin “设为主图”必须提示会创建公开给已分配厂家的主图副本。

## 8. 动效

CSS transition 优先。Motion 只用于：Drawer/Sheet 进入、列表布局切换、图片预览、状态切换和有限的成功反馈。持续时间短、位移小，不做全页炫技；reduced motion 下移除非必要移动。

## 9. UI 验证

至少检查 375×812、390×844、768×1024、1440×900；键盘导航、200% zoom、中文长文本、空数据、100+ 数据、慢网、上传失败、表单错误、iOS/Android 触控和三大浏览器。

## 10. Phase 03 实现规范

### Semantic colors

所有业务组件只引用语义 token，不直接引入随机颜色。当前浅色基线使用 OKLCH：

- `background`：暖中性页面底色；`surface`：主要容器；`surface-muted`：次级分区。
- `foreground` 与 `muted-foreground`：正文与辅助文字；辅助文字仍须满足正文 AA 对比度。
- `border` 与 `border-strong`：普通分隔与需要更明确轮廓的控件。
- `primary` / `primary-hover`：低饱和蓝绿色，仅用于主要操作、焦点和当前导航。
- `secondary`：暖灰次级动作；`accent`：轻量选中/身份区，不承担唯一语义。
- `success`、`warning`、`danger`、`info` 均配套浅色 surface；状态始终同时显示文字。
- `focus-ring` 由 `ring` token 统一；chart-1 至 chart-4 仅预留，不在 Phase 03 伪造业务图表。

### Typography

- 字体栈优先 Geist、PingFang SC、Microsoft YaHei 与系统 sans；SKU 使用 mono 栈。
- Display 30–36px、页面标题 28px、Section Title 20px、Body 14–16px、Small 12px、Caption 10–11px、Label 14px。
- 表格正文 14px、表头 11px uppercase tracking；中文标题使用轻微负字距但不压缩正文。
- `.numeric` 强制 tabular lining numerals，适用于价格、重量、尺寸、CBM、分页和日期。

### Spacing, radius and shadow

- 4px 基础刻度；常用 8/12/16/20/24/28/32/40/56。
- 页面 padding：手机 16px、平板 24px、桌面 32–40px；section gap 为 32–56px；卡片 padding 为 20–28px。
- 控件圆角 8px、卡片 12px、主要容器/弹层 16px；圆形只用于 avatar、badge 和 switch。
- 普通组件不使用阴影。`shadow-float` 只用于菜单等轻浮层，`shadow-overlay` 只用于 Dialog/Sheet。

### Motion

- fast 120ms、normal 180ms、slow 240ms，统一使用 standard easing。
- hover/focus 优先 CSS；Dialog、Sheet、Toast 只做短距离状态过渡。
- `prefers-reduced-motion: reduce` 将动画与 transition 压缩到接近 0，不保留装饰性位移。

## 11. Shell 与响应式行为

- Admin 桌面导航：概览、产品、厂家、报价、活动、用户、设置。Phase 03 只有概览可用，其余明确显示“后续”且禁用。
- Factory 桌面导航：概览、产品、账户资料；不复制 Admin 的复杂结构。
- 桌面从 `lg`（1024px）启用 248px 固定 Sidebar；页面内容最大宽度 1472px。
- 小于 1024px 使用 64px compact header 和左侧 Sheet 导航，触控目标至少 44px。
- 页面 Header 固定包含 eyebrow、唯一 H1、说明和可选主操作；内容区不嵌套无意义卡片。
- 数据表在 768px 以下隐藏并切换为 Product/Data Card；核心任务不依赖横向滚动或 hover。
- 手机复杂编辑预留全屏/底部 Sheet 和安全区操作栏；本阶段不实现业务提交。

## 12. Core component contracts

Phase 03 已建立 Button/Icon Button、Input/Textarea、Select、Checkbox、Switch、Badge、Card、Dialog、Sheet/Drawer、Tabs、Dropdown、Popover、Tooltip、Skeleton 和 State Panel 等基础组件。组件继续以 Radix/shadcn composition 为基础：

- Button 高度默认 44px，提供 primary、secondary、outline、ghost、danger 与 disabled。
- Input 高度 44px，明确 normal、hover、focus、readonly、disabled、invalid；单位放在同一输入容器的前后附加区。
- Dialog/Sheet 必须有可见或 screen-reader title，支持 Esc、焦点圈定与触发器焦点恢复。
- State Panel 覆盖 loading、empty、no results、error、forbidden；offline/success 视觉在 Showcase 中预留。
- 产品缩略图使用稳定 aspect ratio；没有真实图片时明确显示“待上传”，不得伪造业务图。
- 价格/Metric 采用 tabular numerals；未报价显示文字，不用 `¥0`。

## 13. Data display language

- 桌面 Table 行高约 60–68px，产品身份（图、名称）优先，SKU、分类、厂家、价格、重量、状态、更新时间按扫描顺序排列。
- hover 仅增强定位；selected、disabled、loading、empty、error 均有非 hover 表达。
- Product Card 是内部数据卡，不出现评分、购物车、促销、划线价或营销标签。
- Mock/fixture 只存在于开发 Showcase，必须显式标注，不接触 production data layer。

## 14. Development showcase

`/design-system` 只在 `NODE_ENV !== "production"` 时渲染；生产构建调用 `notFound()`。该页集中展示 token、组件、浮层、表单、表格/移动卡片、状态和响应式模式，作为后续 Phase 的视觉验收入口。

## 15. Phase 10A Admin Operational UI

- Admin 导航正式开放概览、产品、厂家、报价和设置；Activity 与 Users 继续显示“后续”并保持不可用。
- Dashboard 使用真实计数和最近记录，不提供无数据依据的图表。Product 支持 Table/Gallery、URL search/filter/sort/page；Factory 与 Quote 列表在 768px 以下使用卡片。
- Product Detail 将主图、基础资料、Assignment、报价比较、私图提升分区呈现；Factory Detail 将资料、账号只读摘要与产品报价并列；Quote Detail 明确只读和待报价状态。
- 创建/编辑表单只展示现有 schema 字段；危险启停与撤销使用明确文案，图片提升说明为独立副本。所有图片容器固定比例并使用受控同源 URL。

## 16. Phase 10B Factory Portal Operational UI

- Factory 导航正式开放概览、产品和账户；界面沿用 Phase 03 语义 token、浅色高密度 B2B 基线，不引入电商购物车、评分、促销或零售文案。
- 产品列表以固定比例主图卡片优先，手机端单列重排；搜索、报价状态、分类、材质和分页都有可见 label/状态，长中文与 SKU 必须安全换行且不产生横向滚动。
- 详情页把产品只读资料、主图大图、自有报价、价格历史和厂家私图分区。报价金额使用人民币元输入，包装字段提供移动端数字键盘提示，CBM 明确标注为只读自动计算。
- 首次提交与更新提交文案区分；无修改时按钮禁用，并发冲突提供“刷新最新数据”。字段错误聚合到对应控件且首个错误自动聚焦。
- 移动端提交操作固定在安全区上方；Dialog、图片预览、确认移除、loading/empty/error/unavailable 均有键盘可达且非颜色唯一的反馈。

## 17. Phase 10C Admin Operations UI

- Import 按“模板 → 上传预览 → 核对确认”三步组织；拖放区可键盘触发，动作/错误 badge 有文字，桌面表格在手机重排为逐行卡片，50 行分页避免长 DOM。
- Export 操作并列提供 CSV/XLSX，按钮前明确“当前筛选结果”与数量，loading/success/error 使用中文 live feedback，不打开 raw data 页面。
- Activity 采用可扫描时间线卡片；事件/实体使用集中中文标签，金额与单位差异直读，`details` 展开完整安全信息。
- Users 在桌面用表格、手机用卡片；账号状态与厂家状态分开展示。创建/改密/停用均使用 Dialog，密码有显示切换但提交后不回显。
- 新页面复用 Phase 03 token、AdminShell、Button/Badge/Dialog/Input，覆盖 375/390/768/1024/1280/1440，无水平溢出并通过 WCAG 2.2 AA axe。

## 18. Hard Delete UI boundary

Phase 1 不实现最终删除 UI。未来 UI 必须区分 Preview、显式确认、处理中、文件重试、完成与失败，使用不可误触的破坏性确认；匿名 provenance 统一显示“已永久删除用户”或项目批准的等价文案。不得仅靠隐藏按钮实现 Admin/disabled Factory User 约束，数据库与服务端授权仍是最终边界。

Phase 2 仍不实现最终删除页面、按钮或导航入口。后台安全 preview DTO 只保留 label、状态、影响计数、blocker/preservation、digest、version 与 expiry，为后续 UI 提供边界但不构成 UI 授权。
