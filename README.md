# pi-statusbar

[![npm](https://img.shields.io/npm/v/@qinggangli/pi-statusbar)](https://www.npmjs.com/package/@qinggangli/pi-statusbar)

[pi](https://github.com/badlogic/pi-mono) 自定义状态栏扩展：展示 git 分支、token 用量、实时花费、首 token 耗时、输出吞吐、上下文占用与订阅额度。

> npm 包名是 **`@qinggangli/pi-statusbar`**（带 scope）。裸名 `pi-statusbar` 被 npm 以“Package name too similar to existing package `pi-status-bar`”拒绝——那个是 pi 官方发的同类扩展，不是本仓库。在 npm 搜 `pi-statusbar` 也能搜到本包。

```text
main │ ↑12.3k ↓45.6k ⚡100k·85% $0.123 ⏱980ms 128 tok/s │ ▰▰▰▱▱▱▱▱▱▱ 23% │ GLM 5h 12%(3h56m)·1周 34%(6d10h) │ glm-5.3·high │ LSP Active
```

四种布局（`layout`）可选：

- **底部单行 footer**（`bottom`，上面的示例）
- **右侧浮层**（`right`）：类 opencode 的悬浮信息面板，浮在聊天上、遮右缘
- **右侧分栏**（`split`）：占一列、聊天按剩余宽度重新换行，完全不遮挡，仅 fullscreen 模式可用
- **自动**（`auto`，默认）：按终端宽度在浮层与底部单行之间切换

## 功能

- **替换内置 footer**：`git 分支 │ ↑输入 ↓输出 ⚡缓存·命中率 $花费 ⏱首token 输出tok/s │ 上下文% │ 订阅额度 │ 模型 │ 其他扩展状态`
- **实时单价**：从 [models.dev](https://models.dev) 拉取官方单价计算花费（本地缓存 24h），失败回落 models.json 的 cost 字段；`/statusbar prices` 强制刷新并显示单价来源
- **上下文告警**：占用 ≥75% 变黄，≥90% 变红
- **订阅额度自动发现**：按 provider baseUrl 匹配，只显示当前模型所属 provider 的额度

  | 供应商（匹配的 baseUrl） | 展示内容 |
  | --- | --- |
  | GLM Coding Plan（bigmodel.cn / z.ai） | 5h / 周 token 窗口已用 % + 恢复倒计时 |
  | Kimi（api.kimi.com） | 短窗口 / 周配额已用 % + 恢复倒计时 |
  | OpenCode Go（opencode.ai/zen/go） | 5h / 周 / 月三窗口已用 % + 恢复倒计时 |
  | MiniMax Coding Plan（minimaxi.com / minimax.io） | 5h / 周窗口已用 % + 恢复倒计时 |
  | DeepSeek · OpenRouter · Moonshot 开放平台 · SiliconFlow · StepFun · Novita AI | 按量账户余额（按量计费，无重置概念） |

  每个窗口用量后括注恢复倒计时（`45s` / `13m` / `2h13m` / `6d4h`：不足 24h 按 `xhyym`，超 24h 按 `xdyyh`，渲染时按重置时刻实时换算，时刻缺失则不显示）；底部单行各窗口用 `·` 连接，右侧面板逐窗口分行。`/statusbar quota` 强制刷新并显示详情（含各窗口「重置于 2026-09-15 15:45（3h56m）」）
- **终端标题**：会话名写入终端标题（`pi · 会话名`），不占 footer 宽度（VSCode/Cursor 内置终端看不到时见「排障」）
- **窄终端自适应**：按 扩展状态 → 额度/token → 模型 的顺序逐段收起，仍放不下时整段换行成多行（分支与上下文永不丢弃）
- **布局可选（layout）**：`bottom` / `right` / `auto`（默认）/ `split` 右侧分栏，详见「布局」一节
- **Agent 面板入栏**：`split` 分栏时把 pi-subagents 的异步 agent 面板搬进右栏（状态卡片下方），点击折叠等交互保留；默认开，`/statusbar dock on|off` 或交互菜单切换
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
 // 布局："bottom" 底部单行 / "right" 右侧浮层（浮在聊天上）/ "auto" 按宽度自动（默认）
 //       / "split" 右侧分栏（占一列、聊天按剩余宽度重新换行、完全不遮挡，仅 fullscreen 可用）
 //       split 时扩展会自动把 pi 的 tuiMode 设为 fullscreen（切回其他布局时还原）
 "layout": "auto",
 // 右侧面板宽度（列），默认 32，范围 [20, 60]
 "rightWidth": 32,
 // 面板边框字符集："auto"（默认，只跟随 PI_STATUSBAR_BORDER 环境变量）/ "unicode"（┌─┐│└┘）/ "ascii"（+ - |）。
 // 注：曾按 TERM_PROGRAM=vscode 自动猜 ascii，实测那类「边框错位」残影来自终端渲染器本身、
 // 与方框字形无关（ascii 并不能修），已去掉猜测，只留手动切换；也可用 /statusbar border 切换
 "panelBorder": "auto",
 // 分栏面板是否把边框铺满整屏高度：true（默认）/ false（高度贴内容）。
 // 只对 layout=split 有意义（浮层本来就贴合内容）；也可用 /statusbar fill on|off
 "panelFill": true,
 // split 分栏时把 pi「编辑器上方」的 widget 容器（pi-subagents 的 agent 面板）搬进右栏：
 // 状态面板在上、agent 面板在下，点击折叠等交互保留（默认 true）。
 // 入栏期间 panelFill 自动让位（状态面板贴内容）；也可用 /statusbar dock on|off
 "dockWidgetsInSplit": true,
 // 隐藏的指标（可选：branch/ctx/model/effort/usage/ttft/speed/quota/ext），默认 []（全部显示）；
 // 也可用 /statusbar metrics 交互式配置（会写回此字段）。示例：["ttft"]
 "hiddenMetrics": [],
 // 配置面板显示语言："zh" / "en"（默认 zh），/statusbar 菜单语言行 ←→ 切换
 "language": "zh"
}
```

**单价自动匹配规则**（未配置 priceMap 时，按顺序取第一个命中）：

1. `priceMap` 中 `"provider:model"` 精确映射
2. `priceMap` 中裸 `"model"` 映射
3. models.dev 中同名 provider + 同名模型直接匹配
4. models.dev 全量中按模型 id 匹配（忽略大小写，多候选取输入+输出单价最低者）

本地中转站/网关的模型名与官方名不一致时（如 `kimi-for-coding` 实为 `kimi-k2.7-code`）才需要显式 `priceMap`。

## 布局

`auto` 模式下终端 ≥120 列时状态收进右侧竖卡（Branch / Ctx / Model / In / Out / Cache / Cost / TTFT / Speed / Quota 每行一项，带边框），底部 footer 让位；<120 列时回到单行 footer。右侧竖卡有两种实现：

- **右侧浮层（`layout: "right"` / `auto`）**：非捕获 overlay，不抢键盘焦点，但会**遮住聊天内容右缘**（regular 模式没有布局树，pi 扩展 API 无法分栏）。
- **右侧分栏（`layout: "split"`）**：把 pi 的核心布局根（transcript + 底部 dock）包进 `HStack`，右侧挂状态卡片——**与 opencode 的 `flexDirection="row"` 同构**：聊天按剩余宽度重新换行，整屏高卡片，不遮挡任何内容。它是显式选择，所以**不再套 `auto` 的 120 列阈值**：只要宽度 ≥ `rightWidth + 24` 就分栏（避免把聊天压成一条），更窄才退回底部单行。

右侧分栏的前提是 **fullscreen 模式**（alt-screen，只有它有布局树）。这个前提**不用你手动配**：布局切到 `split` 时扩展会自己把 pi settings.json 的 `tuiMode` 写成 `"fullscreen"`（改前的值存到 `statusbar.json` 的 `tuiModeBackup`，切回其他布局时还原），所以**只配一个字段就够了**。

（旧配置里单独的 `"split": true` 会在读取时自动迁移为 `"layout": "split"`，无需手改。）

只需注意生效时机：TUI mode 是启动时读取的，所以：

```text
/statusbar layout split   →  提示「已自动把 TUI mode 设为 fullscreen：重启 pi 后生效」
重启 pi                    →  右侧直接变成右侧分栏
```

（也可以 `/settings` → TUI mode 当场切，效果一样。）外部写入不会被 pi 覆盖：pi 保存 settings.json 时只合并「本次修改的字段」，其他字段原样保留。

regular 模式下选 `split` 不会报错，而是退回底部单行、且**不再创建浮层**——因为浮层会让 pi 拒绝切换 TUI mode（`Close active overlays before changing TUI mode`）。

### Agent 面板入栏（dockWidgetsInSplit，默认开）

`split` 分栏时，把 pi「编辑器上方」的 widget 容器（pi-subagents 的异步 agent 面板就在这里）整体搬进右栏：

- 状态面板在上、agent 面板在下，底部只剩编辑器 + footer
- 鼠标点击折叠等交互按布局位置命中，搬动后照常可用
- 入栏期间 `panelFill` 自动让位：状态面板贴内容，agent 面板占剩余高度
- `/statusbar dock on|off` 或交互菜单切换，立即重排
- 仅 `split` 生效：其余布局（底部单行/浮层）不动布局树，agent 面板仍在底部

## 命令

| 命令 | 说明 |
| --- | --- |
| `/statusbar` | 无参数打开交互式菜单：布局（auto/bottom/right/split）/ 面板边框 / 面板填充 / Agent 面板入栏 / 语言（光标在对应行时 ←→ 调值，即时生效并写回配置）/ 指标显隐（↑↓ 选择、Space 切换、Enter 保存、Esc 取消）/ 启用停用；Enter 确认、Esc 退出 |
| `/statusbar on\|off` | 启用 / 停用自定义状态栏（停用后恢复内置 footer） |
| `/statusbar layout [right\|bottom\|auto\|split]` | 切换布局并写回配置，不带参数时按 自动 → 底部 → 右侧 → 右侧分栏 循环；选 `split` 会自动把 pi 的 `tuiMode` 设为 `fullscreen`（切走时还原） |
| `/statusbar split [on\|off]` | `layout split` 的快捷别名：`on` = 右侧分栏，`off` = 回到默认布局；不带参数时取反 |
| `/statusbar border [auto\|unicode\|ascii]` | 面板边框字符集（写回 `panelBorder` 并立即重绘），不带参数时按 auto → unicode → ascii 循环 |
| `/statusbar fill [on\|off]` | 分栏面板是否铺满整屏高度（写回 `panelFill` 并立即重绘），不带参数时取反；只对 `layout: split` 生效 |
| `/statusbar dock [on\|off]` | split 分栏时把 agent 面板（pi-subagents 的异步任务 widget）搬进右栏（写回 `dockWidgetsInSplit` 并立即重排），不带参数时取反 |
| `/statusbar metrics` | 直接进入指标显隐交互式配置 |
| `/statusbar quota` | 强制刷新订阅额度并显示详情 |
| `/statusbar prices` | 强制刷新实时单价并显示当前模型单价来源 |
| `/exit` | 退出 pi（`/quit` 的别名） |

## 兼容性

- pi 核心包（`@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui`）由 pi 内置提供，声明为 **optional** peerDependencies：安装时不会重复拉一份 pi 本体（实测首装 ~0.1MB；若声明成必需 peer 会被 npm 连带装 249MB），扩展本身也没有第三方运行时依赖
- `layout: "split"` 与「Agent 面板入栏」依赖较新 pi-tui 的 `HStack` / `VStack` 布局组件；旧版 pi 会静默退回底部单行——看不到分栏时请先升级 pi
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
