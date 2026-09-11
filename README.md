# pi-statusbar

[pi](https://github.com/badlogic/pi-mono) 自定义状态栏扩展：展示 git 分支、token 用量、实时花费、首 token 耗时、输出吞吐、上下文占用与订阅额度。支持两种布局：**底部单行 footer** 与类 opencode 的**右侧悬浮信息面板**，可固定其一或按终端宽度自动切换（auto，默认）。

```text
main │ ↑12.3k ↓45.6k ⚡100k·85% $0.123 ⏱980ms 128 tok/s │ ▰▰▰▱▱▱▱▱▱▱ 23% │ GLM 5h 12%·周 34% │ glm-5.3·high │ LSP Active
```

## 功能

- **替换内置 footer**：`git 分支 │ ↑输入 ↓输出 ⚡缓存·命中率 $花费 ⏱首token 输出tok/s │ 上下文% │ 订阅额度 │ 模型 │ 其他扩展状态`
- **实时单价**：从 [models.dev](https://models.dev) 拉取官方单价计算花费（本地缓存 24h），失败回落 models.json 的 cost 字段；`/prices` 强制刷新并显示单价来源
- **上下文告警**：占用 ≥75% 变黄，≥90% 变红
- **订阅额度自动发现**：按 provider baseUrl 匹配，只显示当前模型所属 provider 的额度：
  - GLM Coding Plan（bigmodel.cn / z.ai）→ 5h/周 token 窗口百分比
  - Kimi（api.kimi.com）→ 周配额与短窗口用量
  - DeepSeek（deepseek.com）→ 按量账户余额
  - OpenRouter（openrouter.ai）→ 剩余 credits
  - `/quota` 强制刷新并显示详情
- **终端标题**：会话名写入终端标题（`pi · 会话名`），不占 footer 宽度
- **窄终端自适应**：按 扩展状态 → 额度/token → 模型 的顺序逐段收起，仍放不下时整段换行成多行（分支与上下文永不丢弃）
- **布局可选（layout）**：`bottom` 底部单行 / `right` 右侧悬浮竖卡面板（Model 与 Effort 分行显示，超长自动换行不截断）/ `auto`（默认）按终端宽度自动选择（≥120 列用右侧面板），拖拽 resize 实时切换；`/statusbar-layout` 运行时切换
- `/statusbar` 随时切换回内置 footer，新会话默认恢复自定义样式

## 安装

```bash
# 从 GitHub 安装（推荐，可跟随更新）
pi install git:github.com/Lqg97/pi-statusbar

# 更新
pi update --extensions

# 临时试用（不落盘）
pi -e git:github.com/Lqg97/pi-statusbar
```

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
 // 布局："bottom" 底部单行 / "right" 右侧面板 / "auto" 按宽度自动（默认）
 "layout": "auto",
 // 右侧面板宽度（列），默认 32，范围 [20, 60]
 "rightWidth": 32
}
```

**布局说明**：`auto` 模式下终端 ≥120 列时状态收进右侧悬浮竖卡（Branch / Ctx / Model / In / Out / Cache / Cost / TTFT / Speed / Quota 每行一项，带边框），底部 footer 让位；<120 列时回到单行 footer。右侧面板是**非捕获浮层**：不抢键盘焦点，但会遮住聊天内容右缘（pi 扩展 API 不支持真正的布局分栏）。

**单价自动匹配规则**（未配置 priceMap 时，按顺序取第一个命中）：

1. `priceMap` 中 `"provider:model"` 精确映射
2. `priceMap` 中裸 `"model"` 映射
3. models.dev 中同名 provider + 同名模型直接匹配
4. models.dev 全量中按模型 id 匹配（忽略大小写，多候选取输入+输出单价最低者）

本地中转站/网关的模型名与官方名不一致时（如 `kimi-for-coding` 实为 `kimi-k2.7-code`）才需要显式 `priceMap`。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/statusbar` | 切换自定义状态栏 / 内置 footer |
| `/statusbar-layout [right\|bottom\|auto]` | 切换布局，不带参数时循环切换，即时生效（不写回配置文件） |
| `/quota` | 强制刷新订阅额度并显示详情 |
| `/prices` | 强制刷新实时单价并显示当前模型单价来源 |

## 兼容性

- pi 核心包（`@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui`）以 peerDependencies 声明，由 pi 内置提供，无第三方运行时依赖
- 花费计算含阶梯定价，逻辑与 pi-ai 的 `calculateCost` 一致
- 生成中的 tok/s 按字符估算（英文 ~4 字符/token，CJK ~1.5 字符/token），带 `~` 前缀；响应结束后显示精确值

## 安全提示

pi 扩展以完整系统权限运行。安装前请审阅 [extensions/statusbar.ts](extensions/statusbar.ts) 源码（仅有的网络请求：models.dev 单价接口与各 provider 官方额度接口）。

## License

[MIT](LICENSE)
