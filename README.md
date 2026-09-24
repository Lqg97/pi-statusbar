# pi-statusbar

[![npm](https://img.shields.io/npm/v/@qinggangli/pi-statusbar)](https://www.npmjs.com/package/@qinggangli/pi-statusbar)

[pi](https://github.com/badlogic/pi-mono) 自定义状态栏扩展：展示 git 分支、token 用量、实时花费、首 token 耗时、输出吞吐、上下文占用与订阅额度。

> npm 包名是 **`@qinggangli/pi-statusbar`**（带 scope）。裸名 `pi-statusbar` 被 npm 以“Package name too similar to existing package `pi-status-bar`”拒绝——那个是 pi 官方发的同类扩展，不是本仓库。在 npm 搜 `pi-statusbar` 也能搜到本包。

```text
main │ ↑12.3k ↓45.6k ⚡100k·85% $0.123 ⏱980ms 128 tok/s │ ▰▰▰▱▱▱▱▱▱▱ 23% │ GLM 5h 12%(3h56m)·1周 34%(6d10h) │ glm-5.3·high │ LSP Active
```

五种布局（`layout`）可选：

- **底部单行 footer**（`bottom`，上面的示例）
- **右侧浮层**（`right`）：类 opencode 的悬浮信息面板，浮在聊天上、遮右缘
- **右侧分栏**（`split`）：占一列、聊天按剩余宽度重新换行，完全不遮挡，仅 fullscreen 模式可用
- **自动右侧浮层**（`auto`，默认）：按终端宽度在浮层与底部单行之间切换
- **自动右侧分栏**（`auto-split`）：按终端宽度在分栏与底部单行之间切换（宽度阈值 `autoMinWidth`，默认 120）

## 功能

- **替换内置 footer**：`git 分支 │ ↑输入 ↓输出 ⚡缓存·命中率 $花费 ⏱首token 输出tok/s │ 上下文% │ 订阅额度 │ 模型 │ 其他扩展状态`
- **实时单价**：从 [models.dev](https://models.dev) 拉取官方单价计算花费（本地缓存 24h），失败回落 models.json 的 cost 字段；自动匹配会跳过 0 价的订阅/免费端点，`/statusbar prices` 强制刷新并显示单价来源与匹配方式（命中 0 价/多候选时给出 priceMap 建议）
- **上下文告警**：占用 ≥75% 变黄，≥90% 变红
- **订阅额度自动发现**：按 provider baseUrl 匹配，只显示当前模型所属 provider 的额度

  | 供应商（匹配的 baseUrl） | 展示内容 |
  | --- | --- |
  | GLM Coding Plan（bigmodel.cn / z.ai） | 5h / 周 token 窗口已用 % + 恢复倒计时 |
  | Kimi（api.kimi.com） | 短窗口 / 周配额已用 % + 恢复倒计时 |
  | OpenCode Go（opencode.ai/zen/go） | 5h / 周 / 月三窗口已用 % + 恢复倒计时 |
  | MiniMax Coding Plan（minimaxi.com / minimax.io） | 5h / 周窗口已用 % + 恢复倒计时 |
  | Command Code（commandcode.ai） | 5h / 周窗口已用 %（credits 口径）+ 恢复倒计时 + 剩余积分余额 |
  | DeepSeek · OpenRouter · Moonshot 开放平台 · SiliconFlow · StepFun · Novita AI | 按量账户余额（按量计费，无重置概念） |

  每个窗口用量后括注恢复倒计时（`45s` / `13m` / `2h13m` / `6d4h`：不足 24h 按 `xhyym`，超 24h 按 `xdyyh`，渲染时按重置时刻实时换算，时刻缺失则不显示）；底部单行各窗口用 `·` 连接，右侧面板逐窗口分行。`/statusbar quota` 强制刷新并显示详情（含各窗口「重置于 2026-09-15 15:45（3h56m）」）
- **订阅用量统计（`/statusbar subs`）**：**可交互浮层**，按订阅列出各周期消耗的 **token 数与 API 等价费用**，并带 **7×24 热力图**。

  - **数据源**：只扫 pi 自己的会话日志目录 `~/.pi/agent/sessions`（递归所有 `.jsonl`），**不依赖 ai-sub-dashboard 在跑**。只统计 `type=message` 的 assistant 行，按消息 id 跨文件去重（pi 的 `/tree` fork 会把历史消息整段复制进新 session，实测不先去重会多算约 10%）。同目录下 `subagent-artifacts/` 的 `recordType` 结构天然被排除，不会重复计数
  - **零配置可用（订阅列表自动发现）**：面板的行 = `subscriptions[]` 里配的（优先，用你的名字/套餐/账期）+ **扫到但没被任何条目命中的 provider 自动成行**（行名就是 provider id，如 `commandcode`，按 token 量从大到小排）+ 最后一行「未归属」。所以换个新 provider 不用改配置，用量直接看得见；想让自动行改名/带上套餐或额度窗口，再补一条 `subscriptions[]` 即可。`"autoDiscoverSubs": false` 可关掉自动成行（未命中的一律进「未归属」）
  - **费用口径**：与 footer 实时花费**同源**（`priceTable` + 阶梯定价 + 1h 缓存写规则），因此面板数与 footer 数一致；查不到单价时回落 pi 自己算的 `usage.cost.total`（实测约 97% 的消息能命中单价表）
  - **周期**：固定四档 `today` / `24h` / `7d` / `30d`，外加**额度窗口**——GLM / Kimi / OpenCode Go / MiniMax / Command Code 的实时额度接口会带回窗口长度与重置时刻，面板用 `resetAt - spanMs` 反推窗口起点，因此「5h 窗口已用 token」与官方百分比是同一个窗口（明细表里带 `⟲` 标记）；没有额度接口的订阅可用 `subscriptions[].quotaWindows` 手工声明
  - **形态：pi-subagents fleet inspector 同款的交互浮层**（`ctx.ui.custom` + `overlay: true`，居中 95% 宽、最多 85% 高、带边框）。**键盘可交互**（custom 会把焦点交给浮层组件）：`↑↓`/`jk` 切订阅 · `←→` 切热力图周期 · `h` 切 tokens/费用 · `r` 强制重扫 · `Esc`/`q` 关闭。边框外露出的是底层正常 UI（聊天 / 右侧分栏），关闭后焦点自动回编辑器
  - **为什么不做成贴编辑器的 widget**：widget 参与布局不遮聊天，但实测它**收不到键盘**（按 `↓`/`j`/`Esc` 后组件 `handleInput` 调用次数始终为 0，焦点在编辑器）；订阅统计这种「打开 → 翻看 → 关掉」的临时界面，可交互性优先于不遮挡，所以选浮层
  - **高度与降级**：正文 = 终端高度 85% - 4，行数恒定不抖动；**热力图优先占位**（面板的 hero），订阅列表上限 16 行（十来个订阅一屏列完），明细只在真有余量时出现；订阅列表是**视窗**——选中行始终可见，`↑↓` 走遍所有订阅
  - **性能**：扫描结果按文件 `mtime`+`size` 增量缓存到 `~/.pi/agent/.statusbar-subs-cache.json`；热启动约 10ms，首次全量约 0.5s（实测 133MB / 137 文件 / 约 1.2 万条唯一消息），期间每 8 个文件让出一次事件循环，不卡 TUI
- **终端标题**：会话名写入终端标题（`pi · 会话名`），不占 footer 宽度（VSCode/Cursor 内置终端看不到时见「排障」）
- **窄终端自适应**：按 扩展状态 → 额度/token → 模型 的顺序逐段收起，仍放不下时整段换行成多行（分支与上下文永不丢弃）
- **布局可选（layout）**：`bottom` / `right` / `auto` 自动浮层（默认）/ `auto-split` 自动分栏 / `split` 始终分栏，详见「布局」一节
- **Agent 面板入栏**：分栏布局（`split` / `auto-split`）下把 pi-subagents 的异步 agent 面板搬进右栏（状态卡片下方），点击折叠等交互保留；默认开，`/statusbar dock on|off` 或交互菜单切换
- **指标显隐可配置**：交互式勾选要展示的指标（分支 / 上下文 / 模型 / effort / 用量 / TTFT / 吞吐 / 额度 / 扩展状态），即时预览，保存写回配置文件 `hiddenMetrics` 字段
- **配置面板中英双语**：`language` 配置项或菜单内 ←→ 实时切换，菜单/指标选择器/提示文案跟随语言
- **单一命令 `/statusbar`**：无参数打开交互式菜单，集中管理布局、边框、填充、Agent 入栏、语言、指标显隐与启停；也支持子命令快捷方式。新会话默认恢复自定义样式

## 安装

```bash
# 从 npm 安装（推荐，不需要 GitHub 访问权限）
pi install npm:@qinggangli/pi-statusbar

# 更新（未固定版本时跟随 latest）
pi update --extensions

# 固定版本（固定后 pi update --extensions 会跳过它）
pi install npm:@qinggangli/pi-statusbar@1.0.0

# 临时试用（不落盘）
pi -e npm:@qinggangli/pi-statusbar

# 卸载（配置文件 ~/.pi/agent/statusbar.json 会残留，不需要可一并删除）
pi remove npm:@qinggangli/pi-statusbar
```

跟着主线代码跑（开发／尝鲜）可以走 git 源：

```bash
pi install git:github.com/Lqg97/pi-statusbar
pi remove git:github.com/Lqg97/pi-statusbar
```

> 两个源**别同时装**：pi 的去重分别按 npm 包名和 git 仓库 URL 计算，两个源会被当成两个包各自加载一份扩展（先 `pi remove` 掉旧的那条）。

## 配置（可选）

配置文件：`~/.pi/agent/statusbar.json`（可用环境变量 `PI_STATUSBAR_CONFIG` 覆盖路径）。新会话时重读，改完开新会话即生效。

```jsonc
{
 // 本地模型 → models.dev 单价映射（一般不需要，见下方自动匹配）
 // key 为本地 "provider:model" 或裸 "model"，value 为 [models.dev provider, models.dev 模型 id]
 "priceMap": {
  "my-relay:glm-5.3": ["zhipuai", "glm-5.3"],
  "deepseek-v4.1-flash": ["deepseek", "deepseek-v4-flash"]
 },
 // 按文本包含隐藏其他扩展的 footer 状态（默认 ["LSP Inactive"]）
 "hideExtStatuses": ["LSP Inactive"],
 // 布局："bottom" 底部单行 / "right" 右侧浮层（浮在聊天上）
 //       / "auto" 自动右侧浮层（默认）/ "auto-split" 自动右侧分栏
 //       / "split" 右侧分栏（占一列、聊天按剩余宽度重新换行、完全不遮挡，仅 fullscreen 可用）
 //       split / auto-split 时扩展会自动把 pi 的 tuiMode 设为 fullscreen（切回其他布局时还原）
 "layout": "auto",
 // 右侧面板宽度（列），默认 32，范围 [20, 60]
 "rightWidth": 32,
 // 两种 auto 模式的宽度阈值（列），默认 120，范围 [40, 400]：
 // 终端 ≥ 该值时切到右侧（auto 用浮层 / auto-split 用分栏），否则底部单行
 "autoMinWidth": 120,
 // 面板边框字符集："auto"（默认，只跟随 PI_STATUSBAR_BORDER 环境变量）/ "unicode"（┌─┐│└┘）/ "ascii"（+ - |）。
 // 注：曾按 TERM_PROGRAM=vscode 自动猜 ascii，实测那类「边框错位」残影来自终端渲染器本身、
 // 与方框字形无关（ascii 并不能修），已去掉猜测，只留手动切换；也可用 /statusbar border 切换
 "panelBorder": "auto",
 // 分栏面板是否把边框铺满整屏高度：true（默认）/ false（高度贴内容）。
 // 只对分栏布局（split / auto-split）有意义（浮层本来就贴合内容）；也可用 /statusbar fill on|off
 "panelFill": true,
 // split 分栏时把 pi「编辑器上方」的 widget 容器（pi-subagents 的 agent 面板）搬进右栏：
 // 状态面板在上、agent 面板在下，点击折叠等交互保留（默认 true）。
 // 入栏期间 panelFill 自动让位（状态面板贴内容）；也可用 /statusbar dock on|off
 "dockWidgetsInSplit": true,
 // 隐藏的指标（可选：branch/ctx/model/effort/usage/ttft/speed/quota/ext），默认 []（全部显示）；
 // 也可用 /statusbar metrics 交互式配置（会写回此字段）。示例：["ttft"]
 "hiddenMetrics": [],
 // 配置面板显示语言："zh" / "en"（默认 zh），/statusbar 菜单语言行 ←→ 切换
 "language": "zh",
 // 未被 subscriptions[] 命中的 provider 是否自动成行（默认 true）：行名就是 provider id，
 // 按 token 量降序排在配置行之后；false = 未命中的用量一律进「未归属」
 "autoDiscoverSubs": true,
 // 订阅列表：配了就用你的名字/套餐/账期/额度窗口；没配的 provider 会自动成行
 // 归属：providerFilter 全局优先于 modelFilter，同层按配置顺序先到先得；两者都缺省的条目永不自动归属
 "subscriptions": [
  // providerFilter 匹配 provider id（精确或子串，大小写不敏感）
  { "id": "sub-glm", "name": "Zhipu GLM", "plan": "pro", "priceMonthly": 23,
    "startDate": "2026-07-01", "expireAt": "2026-09-30", "autoRenew": true,
    "providerFilter": ["cc-switch-zhipu-glm"] },
  // modelFilter 匹配模型名（子串，大小写不敏感；写成 "/re/" 则按正则）
  { "id": "sub-or", "name": "OpenRouter", "billingType": "prepaid",
    "modelFilter": ["deepseek", "/^qwen/"] },
  // 没有额度接口、又想要额外窗口时，用 quotaWindows 手工声明（key = 展示标签，spanMs = 窗口长度）
  { "id": "sub-x", "name": "自建中转", "modelFilter": ["my-relay"],
    "quotaWindows": [{ "key": "5h", "spanMs": 18000000 }, { "key": "周", "spanMs": 604800000 }] }
 ]
}
```

**单价匹配规则**（按顺序取第一个命中）：

1. `priceMap` 中 `"provider:model"` 精确映射
2. `priceMap` 中裸 `"model"` 映射
3. models.dev 中同名 provider + 同名模型直接匹配
4. 模型注册表单价（models.json 手写的 `cost` / pi 内置目录，非零才采用）
5. models.dev 全量中按模型 id 自动匹配（忽略大小写；**官方 provider 优先**，**排除 0 价的订阅/免费端点**，其余取输入+输出单价最低者；若同名条目全部 0 价则取其一并标记）

自动匹配到 0 价条目（典型：订阅制端点，花费会显示 $0）或存在多个同名候选时，`/statusbar prices` 会给出警告并建议配置 `priceMap` 固定来源。

本地中转站/网关的模型名与官方名不一致时（如 `kimi-for-coding` 实为 `kimi-k2.7-code`）才需要显式 `priceMap`。

### 订阅用量统计（`subscriptions`）

`/statusbar subs` 打开的交互浮层（居中、带边框、不占用布局），按订阅展示各周期 token 与 API 等价费用 + 7×24 热力图。

**零配置可用**：面板的行 = `subscriptions[]` 里配的（优先）+ **扫到但没被任何条目命中的 provider 自动成行**（行名 = provider id，按 token 量降序）+ 最后一行「未归属」。所以换个新 provider 不用改配置，用量直接看得见。`subscriptions[]` 只在你想**改名、补套餐/账期、归并多个 provider、或声明额度窗口**时才需要写（见上面的配置示例）：

| 字段 | 说明 |
| --- | --- |
| `id` / `name` | 面板里的标识与显示名（`name` 必填；`id` 缺省自动生成） |
| `providerFilter` | 匹配 **provider id**（如 `cc-switch-zhipu-glm`），精确或子串，大小写不敏感；优先级高于 `modelFilter` |
| `modelFilter` | 匹配**模型名**，子串或 `/正则/`（如 `["glm"]` 一次覆盖 `glm-5.3` 与 `glm-5.3-flash`） |
| `quotaWindows` | `[{ "key": "5h", "spanMs": 18000000 }]`，手工声明额度窗口；有实时额度接口时不必配 |
| `priceMonthly` / `plan` / `startDate` / `expireAt` / `autoRenew` / `status` / `billingType` | 订阅元信息，面板展示用 |

几条口径说明：

- **先配置、后自动**：先按 `subscriptions[]` 归属（命中就用你的行名与元信息），剩下的才按 provider 自动成行——所以自动行不会跟配置行重复计数。自动行的额度窗口也能自动认出来（该 provider 命中已知额度接口时），无需 `providerFilter`
- **未归属单独成行**：`provider` 为空的事件（无法命名，多为早期日志）会归入「未归属」，避免配漏一条订阅时用量凭空消失。**两个过滤器都不填的条目永不自动归属**，防止一个空过滤器吃掉全部用量；这类条目在自动发现下也不会“抢”走任何 provider（先按配置归属，剩下才自动成行）
- **多条订阅同时命中时按配置顺序先到先得**；但 `providerFilter` 是全局优先层，所以把一条宽松的 `modelFilter` 写在前面，也不会抢走 `providerFilter` 能明确归属的用量
- **额度窗口对齐**：会话日志里只有 token、没有窗口边界，所以 5h/周/月 这类窗口由 provider 的重置时刻反推起点（`resetAt - spanMs`）。明细表里 `used` 列的 `⟲` 表示该窗口已对齐（此时「已用 token」与官方百分比同窗口，可直接对照，不会出现「显示 12% 但本地按 now-5h 算出的用量偏高/偏低」）
- **与 ai-sub-dashboard 的数字可能不同**：dashboard 只按**模型名归一化**查单价，本扩展按 **`provider:model` 精确键**查（即 footer 的同一套 `priceTable`），两者在某些模型上会选到不同的 models.dev 条目（例如订阅制端点 dashboard 会取到 0 价条目）。本扩展的选择与 pi 自己写的 `usage.cost.total` 逐条一致，想要固定来源可用 `priceMap` 覆盖

## 布局

两种自动模式（`auto` / `auto-split`）都按终端宽度自动切换（阈值 `autoMinWidth`，默认 120，范围 `[40, 400]`，可配），resize 实时生效、无需重启会话：

| `layout` | ≥ `autoMinWidth` | < `autoMinWidth` |
| --- | --- | --- |
| `auto`（默认） | 右侧浮层 | 底部单行 |
| `auto-split` | 右侧分栏 | 底部单行 |

进入右侧时状态收进竖卡（Branch / Ctx / Model / In / Out / Cache / Cost / TTFT / Speed / Quota 每行一项，带边框），底部 footer 让位。竖卡有两种实现：

- **右侧浮层（`auto` / `right`）**：非捕获 overlay，不抢键盘焦点，但会**遮住聊天内容右缘**（regular 模式没有布局树，pi 扩展 API 无法分栏）。
- **右侧分栏（`auto-split` / `split`）**：把 pi 的核心布局根（transcript + 底部 dock）包进 `HStack`，右侧挂状态卡片——**与 opencode 的 `flexDirection="row"` 同构**：聊天按剩余宽度重新换行，整屏高卡片，不遮挡任何内容。`split` 是显式选择，所以**不再套 `autoMinWidth` 阈值**：只要宽度 ≥ `rightWidth + 24` 就分栏（避免把聊天压成一条），更窄才退回底部单行；`auto-split` 则同时要求 ≥ `autoMinWidth` 与 ≥ `rightWidth + 24`。

想调宽度阈值只改一个字段（两种自动模式共用）：

```json
{ "layout": "auto-split", "autoMinWidth": 100, "rightWidth": 28 }
```

右侧分栏的前提是 **fullscreen 模式**（alt-screen，只有它有布局树）。这个前提**不用你手动配**：布局切到 `split` / `auto-split` 时扩展会自己把 pi settings.json 的 `tuiMode` 写成 `"fullscreen"`（改前的值存到 `statusbar.json` 的 `tuiModeBackup`，切回其他布局时还原），所以**只配一个字段就够了**。

（旧配置里单独的 `"split": true` 会在读取时自动迁移为 `"layout": "split"`，无需手改。）

只需注意生效时机：TUI mode 是启动时读取的，所以：

```text
/statusbar layout split        →  提示「已自动把 TUI mode 设为 fullscreen：重启 pi 后生效」
/statusbar layout auto-split   →  同上（分栏要等重启后才能用，本次会话先走底部单行）
重启 pi                        →  右侧直接变成右侧分栏（auto-split 下宽够才分栏）
```

（也可以 `/settings` → TUI mode 当场切，效果一样。）外部写入不会被 pi 覆盖：pi 保存 settings.json 时只合并「本次修改的字段」，其他字段原样保留。

regular 模式下选 `split` / `auto-split` 不会报错，而是退回底部单行、且**不再创建浮层**——因为浮层会让 pi 拒绝切换 TUI mode（`Close active overlays before changing TUI mode`）。`auto-split` 在这时还会顺手把 pi 的 `tuiMode` 补成 `fullscreen`（同样提示重启），下次启动就真能分栏。

### Agent 面板入栏（dockWidgetsInSplit，默认开）

`split` 分栏时，把 pi「编辑器上方」的 widget 容器（pi-subagents 的异步 agent 面板就在这里）整体搬进右栏：

- 状态面板在上、agent 面板在下，底部只剩编辑器 + footer
- 鼠标点击折叠等交互按布局位置命中，搬动后照常可用
- 入栏期间 `panelFill` 自动让位：状态面板贴内容，agent 面板占剩余高度
- `/statusbar dock on|off` 或交互菜单切换，立即重排
- 仅分栏布局（`split` / `auto-split`）生效：其余布局（底部单行/浮层）不动布局树，agent 面板仍在底部

## 命令

| 命令 | 说明 |
| --- | --- |
| `/statusbar` | 无参数打开交互式菜单：布局（auto/auto-split/bottom/right/split）/ 面板边框 / 面板填充 / Agent 面板入栏 / 语言（光标在对应行时 ←→ 调值，即时生效并写回配置）/ 指标显隐（↑↓ 选择、Space 切换、Enter 保存、Esc 取消）/ 订阅统计 / 启用停用；Enter 确认、Esc 退出 |
| `/statusbar on\|off` | 启用 / 停用自定义状态栏（停用后恢复内置 footer） |
| `/statusbar layout [right\|bottom\|auto\|auto-split\|split]` | 切换布局并写回配置，不带参数时按 自动浮层 → 自动分栏 → 底部 → 右侧浮层 → 右侧分栏 循环；选 `split` / `auto-split` 会自动把 pi 的 `tuiMode` 设为 `fullscreen`（切走时还原） |
| `/statusbar split [on\|off]` | `layout split` 的快捷别名：`on` = 右侧分栏（`layout split`），`off` = 回到默认布局（`auto`）；不带参数时取反（已是 `split` / `auto-split` 则关掉） |
| `/statusbar border [auto\|unicode\|ascii]` | 面板边框字符集（写回 `panelBorder` 并立即重绘），不带参数时按 auto → unicode → ascii 循环 |
| `/statusbar fill [on\|off]` | 分栏面板是否铺满整屏高度（写回 `panelFill` 并立即重绘），不带参数时取反；只对分栏布局（`split` / `auto-split`）生效 |
| `/statusbar dock [on\|off]` | 分栏布局（`split` / `auto-split`）下把 agent 面板（pi-subagents 的异步任务 widget）搬进右栏（写回 `dockWidgetsInSplit` 并立即重排），不带参数时取反 |
| `/statusbar metrics` | 直接进入指标显隐交互式配置 |
| `/statusbar subs` | 打开订阅用量统计**交互浮层**（各周期 token / API 等价费用 + 7×24 热力图）；`↑↓`/`jk` 切订阅 · `←→` 切周期 · `h` 切指标 · `r` 重扫 · `Esc`/`q` 关闭 |
| `/statusbar quota` | 强制刷新订阅额度并显示详情 |
| `/statusbar prices` | 强制刷新实时单价并显示当前模型单价来源 |
| `/exit` | 退出 pi（`/quit` 的别名） |

## 兼容性

- pi 核心包（`@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui`）由 pi 内置提供，声明为 **optional** peerDependencies：安装时不会重复拉一份 pi 本体（实测首装 ~0.1MB；若声明成必需 peer 会被 npm 连带装 249MB），扩展本身也没有第三方运行时依赖
- `layout: "split"` / `"auto-split"` 与「Agent 面板入栏」依赖较新 pi-tui 的 `HStack` / `VStack` 布局组件；旧版 pi 会静默退回底部单行——看不到分栏时请先升级 pi
- 花费计算含阶梯定价，逻辑与 pi-ai 的 `calculateCost` 一致
- 生成中的 tok/s 按字符估算（英文 ~4 字符/token，CJK ~1.5 字符/token），带 `~` 前缀；响应结束后显示精确值

## 排障

### 右侧面板边框在不同行「错位」（半格左右的偏移，不是整格）

这是终端渲染器的问题，与扩展无关，但有一条已验证的修法：

- 触发条件：VSCode / Cursor 内置终端把 `terminal.integrated.gpuAcceleration` 设为 `"off"` 时用的是 **DOM 渲染器**，它逐行按文本排版，会对字体回退字形（emoji、`▰▱` 这类符号）做 letter-spacing 补偿 —— 行内地基偏一点，整行后面所有格子跟着偏。`split`（右侧分栏）下边框和聊天内容在同一行字符串里，于是边框跟着偏；浮层布局下看不明显。
- 修法：把 `"terminal.integrated.gpuAcceleration"` 改回 **`"auto"`**（或 `"on"`）用 WebGL 渲染器；`Cmd+Q` 完全退出、新开终端后生效。
- 验证：`/statusbar layout split` 下聊几轮（让聊天区出现 emoji/特殊符号），边框应全程笔直。

### 终端标题不显示（VSCode / Cursor 内置终端）

会话名写在终端标题里（`pi · 会话名`）。VSCode / Cursor 内置终端默认 `terminal.integrated.tabs.title: "${process}"`，只显示进程名，看不到扩展设置的标题；把它改成 `"${sequence}"` 后新开终端即可显示。

## 安全提示

pi 扩展以完整系统权限运行。安装前请审阅 [extensions/statusbar.ts](extensions/statusbar.ts) 源码（仅有的网络请求：models.dev 单价接口与各 provider 官方额度接口）。

## License

[MIT](LICENSE)
