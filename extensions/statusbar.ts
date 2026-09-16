/**
 * 自定义状态栏（footer）扩展
 *
 * 用 ctx.ui.setFooter() 替换内置 footer，单行显示：
 *   git 分支 │ ↑输入 ↓输出 ⚡缓存·命中率 $花费 ⏱首token 输出tok/s（生成中按字符估算，带 ~ 前缀） │ ▰▰▰▱▱ 上下文% │ 订阅额度 │ 模型 │ 其他扩展状态
 *
 * 会话名不占 footer 宽度，只写入终端标题（会话名 · 目录名 · 模型）
 *
 * - 花费按实时单价计算：session 启动时从 models.dev/api.json 拉取各家官方单价（本地缓存 24h），
 *   失败时回落 models.json 的 cost 字段；/statusbar prices 强制刷新并显示当前模型单价来源
 * - 上下文占用 ≥75% 变黄，≥90% 变红
 * - 订阅额度自动发现（按 provider baseUrl 匹配，只显示当前模型所属 provider 的额度）：
 *     GLM Coding Plan（bigmodel.cn / z.ai）      → 5h/周 token 窗口百分比 + 恢复倒计时
 *     Kimi（api.kimi.com）                       → 短窗口/周配额百分比 + 恢复倒计时
 *     DeepSeek 余额（deepseek.com）              → 按量账户余额（无重置概念）
 *     OpenRouter 额度（openrouter.ai）           → 剩余 credits（无重置概念）
 *   每个窗口用量后括注 (恢复倒计时)（45s/13m/2h13m/6d4h；不足 24h 按 xhyym，超 24h 按 xdyyh，渲染时按重置时刻实时换算）；
 *   底部单行各窗口用 · 连接，右侧面板逐窗口分行；带 TTL 缓存，失败静默；/statusbar quota 强制刷新并显示详情
 * - /exit 为 /quit 的别名，优雅退出 pi
 * - 窄终端先按 扩展状态 → 额度/token → 模型 的顺序收起，仍放不下则整段换行成多行（分支与上下文永不丢弃）
 * - 布局可配置（layout）：bottom 底部单行 / right 右侧浮层（浮在聊天上）/ auto（默认）/ split 右侧分栏
 *   auto 按终端宽度自动选择：≥120 列用右侧浮层，否则底部单行，resize 实时切换；
 *   浮层为非捕获 overlay（不抢键盘焦点），宽度由 rightWidth 配置（默认 32 列）；
 *   注意：浮层浮在聊天内容之上，会遮住右缘内容（regular 模式没有布局树，pi 扩展 API 无法真分栏）；
 *   split = 右侧分栏（类 opencode：把核心布局根包进 HStack，聊天按剩余宽度重新换行，完全不遮挡），
 *   只要宽度 ≥ rightWidth+24 就用分栏（不套 auto 的 120 列阈值）；
 *   右侧分栏只在 fullscreen 模式（alt-screen）下成立，regular 模式/极窄终端自动退回底部单行，
 *   且不再创建浮层（浮层会挡住 /settings 切换 TUI mode）；
 *   /statusbar 无参数打开交互式菜单（布局 ◀▶ 调值 / 面板边框 / 指标显隐 / 启停；Enter 确认，Esc 退出），
 *   或子命令快捷方式：/statusbar [on|off] | layout [right|bottom|auto|split] | split [on|off] | metrics
 * - 新会话默认恢复自定义样式
 * - 用户配置 ~/.pi/agent/statusbar.json（环境变量 PI_STATUSBAR_CONFIG 可覆盖路径）：
 *     priceMap         本地模型 → models.dev 单价映射，key 为 "provider:model" 或裸 "model"
 *     hideExtStatuses  按文本包含隐藏的其他扩展状态（默认 ["LSP Inactive"]）
 *     layout           "bottom" | "right" | "auto" | "split"（默认 "auto"）；split = 右侧分栏，
 *                      旧配置的 split: true 会自动迁移为 layout: "split"
 *     rightWidth       右侧面板宽度，默认 32，范围 [20, 60]
 *     panelBorder      面板边框字符集 "auto"（默认，只跟随 PI_STATUSBAR_BORDER 环境变量）
 *                      | "unicode"（┌─┐│└┘）| "ascii"（+ - |）；也可用 /statusbar border [auto|unicode|ascii] 切换
 *     panelFill        分栏面板是否把边框铺满整屏高度（默认 true）；false = 高度贴内容。
 *                      只对 layout=split 有意义（浮层本来就贴合内容）；也可用 /statusbar fill on|off
 *     hiddenMetrics    隐藏的指标 key 数组，可选：branch/ctx/model/effort/usage/ttft/speed/quota/ext；
 *                      也可用 /statusbar metrics 交互式配置（会写回此字段）
 *     language         配置面板显示语言 "zh" | "en"（默认 "zh"）；/statusbar 菜单语言行 ←→ 切换并即时写回
 *   未配置 priceMap 时按模型 id 在 models.dev 全量中自动匹配（同名取最便宜），零配置可用；
 *   配置在新会话时重读，改完开新会话即生效
 */
import type { AssistantMessage, ModelCost } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
// 同上：getSettingsPath 用于「开右侧分栏时自动把 pi 的 TUI mode 设为 fullscreen」，
// 命名空间导入避免旧版没有该导出时在链接期抛错
import * as piAgentRuntime from "@earendil-works/pi-coding-agent";
// 命名空间导入：HStack 在旧版 pi-tui 中不存在，命名导入会在链接期直接抛错，
// 命名空间导入只是取到 undefined，便于「有就用右侧分栏，没有就静默降级」
import * as piTuiRuntime from "@earendil-works/pi-tui";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** 会话累计用量 */
interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** 渲染段：pri 越大，窄终端下越先被丢弃；label 仅在右侧面板竖排展示时使用；key 用于指标显隐配置 */
interface Segment {
	label: string;
	text: string;
	pri: number;
	color?: string;
	key?: MetricKey;
}

/** 额度源单个窗口的渲染文本（面板逐窗口分行，底部用 · 连接成一行） */
interface QuotaRow {
	text: string;
	percent?: number;
}

/** 额度源渲染出的短文本与最大占用百分比（决定颜色）；rows 有值时右侧面板逐窗口分行展示 */
interface QuotaSeg {
	text: string;
	rows?: QuotaRow[];
	maxPercent?: number;
}

/** 订阅额度源：按 provider baseUrl 匹配，从 provider origin 拉取 */
interface QuotaSource {
	id: string;
	match: RegExp;
	ttlMs: number;
	fetch(
		origin: string,
		apiKey: string,
	): Promise<{ seg: QuotaSeg | null; detail: string }>;
}

// ---------- 用户配置（~/.pi/agent/statusbar.json，环境变量 PI_STATUSBAR_CONFIG 可覆盖路径） ----------

/** 状态栏布局：
 *  bottom      底部单行 footer
 *  right       右侧浮层（overlay，始终）
 *  auto        终端列数 ≥ AUTO_MIN_WIDTH 时用右侧浮层，否则底部单行（默认）
 *  split       右侧分栏（fullscreen 布局分栏，聊天按剩余宽度重新换行、完全不遮挡）；
 *              宽度 ≥ rightWidth + 24 时生效，否则回退底部单行；regular 模式/缺 HStack 同样回退
 */
type LayoutMode = "bottom" | "right" | "auto" | "split";

interface StatusbarConfig {
	/** 本地模型 → models.dev 单价映射：key 为本地 "provider:model" 或裸 "model"，value 为 [models.dev provider, 模型 id] */
	priceMap: Record<string, [string, string]>;
	/** 需要隐藏的其他扩展状态（文本包含即隐藏）。
	 *  默认隐藏 pi-lens 的 "LSP Inactive"（未编辑代码时的被动状态），保留 LSP Active / Failed 等有信息量的状态。
	 */
	hideExtStatuses: string[];
	/** 布局模式，默认 auto（终端 ≥120 列时右侧浮层，否则底部单行）；见 LayoutMode */
	layout: LayoutMode;
	/** 右侧面板宽度（列），默认 32，读取时 clamp 到 [20, 60] */
	rightWidth: number;
	/** 开启 layout=split 时自动改写 pi settings.json 的 tuiMode，这里记录改前的值以便切回时还原。
	 *  缺省 = 从未改过；"none" = 原本没有该字段（切回时删除）；"regular"/"fullscreen" = 原值 */
	tuiModeBackup?: string;
	/** 面板边框字符集，默认 auto（只跟随 PI_STATUSBAR_BORDER）；见 PanelBorder */
	panelBorder: PanelBorder;
	/** 分栏面板是否把边框铺满整屏高度（默认 true）；false = 高度贴内容。
	 *  只对 layout=split 有效（浮层本来就贴合内容），/statusbar fill on|off 同效 */
	panelFill: boolean;
	/** 隐藏的指标 key 列表（默认全部显示），/statusbar metrics 交互式配置 */
	hiddenMetrics: MetricKey[];
	/** 配置面板显示语言，默认 zh；/statusbar 菜单语言行 ←→ 切换（即时写回配置文件） */
	language: Lang;
}

/** 配置面板语言 */
type Lang = "zh" | "en";

/** 面板边框字符集：
 *  auto（默认）= 不主动改字形，只跟随 PI_STATUSBAR_BORDER 环境变量；
 *  unicode = ┌─┐│└┘；ascii = + - | 。
 *  为什么留 ascii：个别终端对 U+2500 段方框字符的处理确实会出问题，作为可手动切的后路。
 *  注意：实测 ascii 并不能修复「行内排版漂移」那类残影（错位来自终端渲染器本身，
 *  与方框字形无关），所以不再按 TERM_PROGRAM 自动猜。 */
type PanelBorder = "auto" | "unicode" | "ascii";

/** 可配置显隐的指标 */
type MetricKey =
	| "branch"
	| "ctx"
	| "model"
	| "effort"
	| "usage"
	| "ttft"
	| "speed"
	| "quota"
	| "ext";

const METRICS: { key: MetricKey; zh: string; en: string }[] = [
	{ key: "branch", zh: "分支 / 目录", en: "Branch / Dir" },
	{ key: "ctx", zh: "上下文占用", en: "Context usage" },
	{ key: "model", zh: "模型名", en: "Model" },
	{
		key: "effort",
		zh: "思考强度 effort（仅右侧面板）",
		en: "Effort (right panel only)",
	},
	{ key: "usage", zh: "token 用量 / 缓存 / 花费", en: "Tokens / cache / cost" },
	{ key: "ttft", zh: "首 token 耗时 TTFT", en: "TTFT" },
	{ key: "speed", zh: "输出吞吐 tok/s", en: "Speed tok/s" },
	{ key: "quota", zh: "订阅额度", en: "Quota" },
	{ key: "ext", zh: "其他扩展状态", en: "Extension statuses" },
];

const LAYOUT_ORDER: LayoutMode[] = ["auto", "bottom", "right", "split"];
const LAYOUT_LABELS: Record<Lang, Record<LayoutMode, string>> = {
	zh: { auto: "自动", bottom: "底部单行", right: "右侧浮层", split: "右侧分栏" },
	en: { auto: "Auto", bottom: "Bottom", right: "Right overlay", split: "Right column" },
};
const LANG_LABELS: Record<Lang, string> = { zh: "中文", en: "English" };

/** 配置面板（菜单/指标选择器）双语文案 */
const UI_TEXT = {
	zh: {
		menuTitle: "状态栏设置",
		rowLayout: "布局",
		rowBorder: "面板边框",
		rowFill: "面板填充",
		rowLang: "语言",
		rowMetrics: "指标显隐",
		rowDisable: "停用自定义状态栏",
		rowEnable: "启用自定义状态栏",
		fillOn: "铺满高度",
		fillOff: "贴内容",
		metricsCount: (n: number, total: number) => `${n}/${total} 显示`,
		menuHint: "↑↓ 选择 · ←→ 调整 · Enter 确认 · Esc 退出",
		pickerTitle: "指标显隐",
		pickerHint: "↑↓ 选择 · Space 切换 · Enter 保存 · Esc 取消",
		savedAll: "已保存：显示全部指标",
		savedHidden: (keys: string) => `已保存：隐藏 ${keys}`,
		saveFailed: (e: unknown) => `写入配置文件失败: ${e}`,
		canceled: "已取消，配置未保存",
		noTui: "当前模式不支持交互式配置，请直接改配置文件",
		splitNeedFullscreen: "需重启生效",
		splitEnabled: "右侧分栏已开启",
		splitDisabled: "右侧分栏已关闭",
		splitNeedsRestart:
			"已自动把 pi 的 TUI mode 设为 fullscreen：重启 pi 后生效（当前会话仍是 regular，已退回底部单行）",
		splitRestored: "右侧分栏已关闭，pi 的 TUI mode 已还原",
		splitSetFailed:
			"自动写入 pi settings.json 失败，请手动在 /settings → TUI mode 里切到 fullscreen",
		splitUnavailable:
			"分栏需要 fullscreen 模式（/settings → TUI mode）与支持 HStack 的 pi-tui",
	},
	en: {
		menuTitle: "Statusbar Settings",
		rowLayout: "Layout",
		rowBorder: "Panel border",
		rowFill: "Panel fill",
		rowLang: "Language",
		rowMetrics: "Metrics",
		rowDisable: "Disable custom statusbar",
		rowEnable: "Enable custom statusbar",
		fillOn: "Full height",
		fillOff: "Fit content",
		metricsCount: (n: number, total: number) => `${n}/${total} shown`,
		menuHint: "↑↓ select · ←→ adjust · Enter confirm · Esc exit",
		pickerTitle: "Metrics",
		pickerHint: "↑↓ select · Space toggle · Enter save · Esc cancel",
		savedAll: "Saved: all metrics shown",
		savedHidden: (keys: string) => `Saved: hidden ${keys}`,
		saveFailed: (e: unknown) => `Failed to write config: ${e}`,
		canceled: "Cancelled, not saved",
		noTui: "Interactive config requires TUI mode; edit the config file instead",
		splitNeedFullscreen: "restart to apply",
		splitEnabled: "Right column enabled",
		splitDisabled: "Right column disabled",
		splitNeedsRestart:
			"Set pi TUI mode to fullscreen for you: restart pi to apply (this session stays regular, using the bottom line)",
		splitRestored: "Right column disabled; pi TUI mode restored",
		splitSetFailed:
			"Could not write pi settings.json; switch manually via /settings → TUI mode → fullscreen",
		splitUnavailable:
			"Right column needs fullscreen mode (/settings → TUI mode) and a pi-tui build that exports HStack",
	},
} as const;

/** 当前语言的配置面板文案 */
const t = (): (typeof UI_TEXT)["zh"] => UI_TEXT[config.language];
/** 指标名（跟随当前语言） */
const metricName = (m: (typeof METRICS)[number]): string => m[config.language];

function toMetricKeys(v: unknown): MetricKey[] {
	if (!Array.isArray(v)) return [];
	const valid = new Set(METRICS.map((m) => m.key as string));
	return v.filter((k): k is MetricKey => typeof k === "string" && valid.has(k));
}

const CONFIG_FILE =
	process.env.PI_STATUSBAR_CONFIG || join(homedir(), ".pi/agent/statusbar.json");
const DEFAULT_HIDE_EXT_STATUSES = ["LSP Inactive"];
const DEFAULT_LAYOUT: LayoutMode = "auto";
const DEFAULT_RIGHT_WIDTH = 32;
const DEFAULT_PANEL_BORDER: PanelBorder = "auto";
const DEFAULT_PANEL_FILL = true;
/** 面板边框字符表（h 横线 / v 竖线 / 四角）；auto 只是一种设定值，不参与查表 */
const BORDER_CHARS: Record<
	"unicode" | "ascii",
	{ h: string; v: string; tl: string; tr: string; bl: string; br: string }
> = {
	unicode: { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘" },
	ascii: { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+" },
};
/** auto 模式阈值：终端列数 ≥ 该值时使用右侧浮层 */
const AUTO_MIN_WIDTH = 120;

function toLayoutMode(v: unknown, legacySplit = false): LayoutMode {
	if (v === "bottom" || v === "right" || v === "auto" || v === "split") return v;
	// 旧配置的 split: true 迁移为 layout: "split"
	return legacySplit ? "split" : DEFAULT_LAYOUT;
}

function toRightWidth(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_RIGHT_WIDTH;
	return Math.min(60, Math.max(20, Math.round(v)));
}

function toLang(v: unknown): Lang {
	return v === "en" ? "en" : "zh";
}

function toPanelBorder(v: unknown): PanelBorder {
	if (v === "unicode" || v === "ascii") return v;
	return DEFAULT_PANEL_BORDER;
}

/**
 * 边框字符集解析：显式设置优先；auto 只看 PI_STATUSBAR_BORDER 环境变量，
 * 否则用 unicode。曾经按 TERM_PROGRAM=vscode 猜 ascii，但实测那类残影与方框字形无关
 * （是终端渲染器的逐行排版/重绘问题），猜错只会白让边框变丑，所以去掉了。
 */
function resolvePanelBorder(setting: PanelBorder): "unicode" | "ascii" {
	if (setting === "unicode" || setting === "ascii") return setting;
	return process.env.PI_STATUSBAR_BORDER === "ascii" ? "ascii" : "unicode";
}

const BORDER_ORDER: PanelBorder[] = ["auto", "unicode", "ascii"];

/** 循环切换：auto → unicode → ascii → auto */
function nextPanelBorder(cur: PanelBorder): PanelBorder {
	const i = BORDER_ORDER.indexOf(cur);
	return BORDER_ORDER[(i + 1) % BORDER_ORDER.length];
}

/** 菜单/提示用的边框值文案：auto 时同时给出实际生效的字形集 */
function panelBorderLabel(v: PanelBorder): string {
	const glyphs =
		resolvePanelBorder(v) === "ascii" ? "ASCII (+-+)" : "Unicode (┌─┐)";
	return v === "auto" ? `Auto · ${glyphs}` : glyphs;
}

/** 去除 jsonc 行注释（保留字符串内的 //，如 URL） */
function stripJsonComments(s: string): string {
	return s
		.split("\n")
		.map((line) => {
			let inStr = false;
			for (let i = 0; i < line.length; i++) {
				const c = line[i];
				if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
				if (!inStr && c === "/" && line[i + 1] === "/") return line.slice(0, i);
			}
			return line;
		})
		.join("\n");
}

/** 读取配置（支持 jsonc 行注释）；文件缺失或损坏时回落默认值（新会话时重读，改完配置开新会话即生效） */
function loadConfig(): StatusbarConfig {
	try {
		const raw = JSON.parse(stripJsonComments(readFileSync(CONFIG_FILE, "utf8")));
		// 旧版的独立 split 开关：内存里已并进 layout，session_start 时再写回文件把它删掉
		legacySplitKey = typeof raw?.split === "boolean";
		return {
			priceMap: raw?.priceMap ?? {},
			hideExtStatuses: Array.isArray(raw?.hideExtStatuses)
				? raw.hideExtStatuses
				: [...DEFAULT_HIDE_EXT_STATUSES],
			layout: toLayoutMode(raw?.layout, raw?.split === true),
			rightWidth: toRightWidth(raw?.rightWidth),
			panelBorder: toPanelBorder(raw?.panelBorder),
			panelFill: raw?.panelFill !== false,
			tuiModeBackup:
				typeof raw?.tuiModeBackup === "string" ? raw.tuiModeBackup : undefined,
			hiddenMetrics: toMetricKeys(raw?.hiddenMetrics),
			language: toLang(raw?.language),
		};
	} catch {
		return {
			priceMap: {},
			hideExtStatuses: [...DEFAULT_HIDE_EXT_STATUSES],
			layout: DEFAULT_LAYOUT,
			rightWidth: DEFAULT_RIGHT_WIDTH,
			panelBorder: DEFAULT_PANEL_BORDER,
			panelFill: DEFAULT_PANEL_FILL,
			tuiModeBackup: undefined,
			hiddenMetrics: [],
			language: "zh",
		};
	}
}

/** 将字段补丁写回配置文件（保留其他字段；会去除 jsonc 注释）。
 *  文件缺失或损坏时基于当前生效配置重建。调用方自行更新内存 config。 */
function saveConfigPatch(patch: Record<string, unknown>): void {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(stripJsonComments(readFileSync(CONFIG_FILE, "utf8")));
	} catch {
		raw = {
			priceMap: config.priceMap,
			hideExtStatuses: config.hideExtStatuses,
			layout: config.layout,
			rightWidth: config.rightWidth,
			panelBorder: config.panelBorder,
			panelFill: config.panelFill,
			tuiModeBackup: config.tuiModeBackup,
			hiddenMetrics: config.hiddenMetrics,
			language: config.language,
		};
	}
	Object.assign(raw, patch);
	writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, "\t") + "\n");
}

let config = loadConfig();

/** 配置文件里是否还有旧版的 split 字段（一次性迁移用，见 session_start） */
let legacySplitKey = false;

/** models.dev 模型单价 → 本地 ModelCost 结构 */
function toModelCost(c: any): ModelCost {
	const base = {
		input: c.input ?? 0,
		output: c.output ?? 0,
		cacheRead: c.cache_read ?? 0,
		cacheWrite: c.cache_write ?? 0,
	};
	const tiers = (c.tiers ?? []).map((t: any) => ({
		inputTokensAbove: t?.tier?.size ?? 0,
		input: t.input ?? 0,
		output: t.output ?? 0,
		cacheRead: t.cache_read ?? 0,
		cacheWrite: t.cache_write ?? 0,
	}));
	return tiers.length ? { ...base, tiers } : base;
}

const MODELS_DEV_URL = "https://models.dev/api.json";
const PRICE_TTL_MS = 24 * 60 * 60_000;
const PRICE_CACHE_FILE = join(homedir(), ".pi/agent/.models-dev-prices.json");

/** 数字缩写：999 → 999，12.3k，1.23m */
function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}m`;
}

function fmtCost(n: number): string {
	return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

/** 首 token 耗时：980ms → 980ms，1.2s → 1.2s */
function fmtMs(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 输出吞吐（tok/s）：低速保留 1 位小数，高速取整 */
function fmtTps(n: number): string {
	return n < 100 ? n.toFixed(1) : `${Math.round(n)}`;
}

/**
 * 按字符粗略估算 token 数（流式过程中 provider 不下发 usage，只能估算）：
 * 英文/代码约 4 字符 1 token，CJK/全角约 1.5 字符 1 token。
 */
function estimateTokens(text: string): number {
	let ascii = 0;
	let cjk = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef))
			cjk++;
		else ascii++;
	}
	return ascii / 4 + cjk / 1.5;
}

/** 上下文占用条：▰▰▰▰▱▱▱▱▱▱ */
function contextBar(percent: number, cells = 10): string {
	const filled = Math.min(
		cells,
		Math.max(0, Math.round((percent / 100) * cells)),
	);
	return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

/**
 * 把接口返回的「重置时刻」统一成毫秒时间戳：
 * GLM 给毫秒数字（nextResetTime），Kimi 给 ISO 字符串（resetTime / reset_time）。
 */
function toResetAt(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
	if (typeof v === "string") {
		const t = Date.parse(v);
		if (!Number.isNaN(t)) return t;
	}
	return undefined;
}

/** 恢复倒计时：45s / 13m / 2h13m / 6d4h；时刻缺失或已过期时返回空串 */
function fmtCountdown(ms: number | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return "";
	const diff = ms - Date.now();
	if (diff <= 0) return "";
	if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s`;
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
	if (diff < 86_400_000)
		return `${Math.floor(diff / 3_600_000)}h${Math.floor((diff % 3_600_000) / 60_000)}m`;
	return `${Math.floor(diff / 86_400_000)}d${Math.floor((diff % 86_400_000) / 3_600_000)}h`;
}

/** 重置时刻的本地钟点：`2026-09-15 13:47`（/quota 详情用） */
function fmtResetClock(ms: number | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return "";
	const d = new Date(ms);
	const p = (n: number) => `${n}`.padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 给窗口文本追加恢复倒计时：`5h 86%` → `5h 86%(2h13m)` */
function withReset(text: string, resetAt: number | undefined): string {
	const cd = fmtCountdown(resetAt);
	return cd ? `${text}(${cd})` : text;
}

/** /quota 详情里的重置说明：`，重置于 2026-09-15 13:47（2h13m）` */
function resetDetail(at: number | undefined): string {
	const clock = fmtResetClock(at);
	if (!clock) return "";
	const cd = fmtCountdown(at);
	return `，重置于 ${clock}${cd ? `（${cd}）` : ""}`;
}

/** GLM 窗口标签：unit=3 小时 / 6 周 / 5 月 / 4 天，其余原样输出 */
function glmWindowLabel(unit: number, num: number): string {
	if (unit === 3) return `${num}h`;
	if (unit === 6) return `${num}周`;
	if (unit === 5) return `${num}月`;
	if (unit === 4) return `${num}天`;
	return `u${unit}:${num}`;
}

const FETCH_TIMEOUT_MS = 8000;

/** 内置额度源（各家认证方式实测确认） */
const QUOTA_SOURCES: QuotaSource[] = [
	{
		id: "Kimi",
		match: /api\.kimi\.com/,
		ttlMs: 5 * 60_000,
		async fetch(origin, apiKey) {
			// 官方 CLI 同款接口；缺 User-Agent 会 404
			const res = await fetch(`${origin}/coding/v1/usages`, {
				headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "KimiCLI/1.6" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json: any = await res.json();
			const usage = json?.usage ?? {};
			const parts: string[] = [];
			const rows: QuotaRow[] = [];
			let maxPercent: number | undefined;

			// 短窗口（如 5 小时）；detail 可能只有 remaining 没有 used
			const UNIT_SEC: Record<string, number> = {
				TIME_UNIT_MINUTE: 60,
				TIME_UNIT_HOUR: 3600,
				TIME_UNIT_DAY: 86400,
			};
			for (const lim of json?.limits ?? []) {
				const d = lim?.detail ?? {};
				const limit = parseFloat(d.limit);
				if (!(limit > 0)) continue;
				const used =
					d.used == null
						? limit - parseFloat(d.remaining ?? limit)
						: parseFloat(d.used);
				const hours =
					((lim.window?.duration ?? 0) * (UNIT_SEC[lim.window?.timeUnit] ?? 60)) /
					3600;
				const label =
					hours >= 1
						? `${Math.round(hours)}h`
						: `${Math.max(1, Math.round(hours * 60))}m`;
				const pct = (used / limit) * 100;
				const at = toResetAt(d.resetTime);
				const text = withReset(`${label} ${Math.round(pct)}%`, at);
				parts.push(text);
				rows.push({ text, percent: pct });
				maxPercent = Math.max(maxPercent ?? 0, pct);
			}
			// 周配额
			const weekLimit = parseFloat(usage.limit);
			if (weekLimit > 0) {
				const pct = (parseFloat(usage.used) / weekLimit) * 100;
				const at = toResetAt(usage.resetTime);
				const text = withReset(`周 ${Math.round(pct)}%`, at);
				parts.push(text);
				rows.push({ text, percent: pct });
				maxPercent = Math.max(maxPercent ?? 0, pct);
			}
			if (parts.length === 0) return { seg: null, detail: "响应中无用量数据" };

			const level = json?.user?.membership?.level;
			let detail = `Kimi${level ? `（${level}）` : ""}`;
			for (const lim of json?.limits ?? []) {
				const d = lim?.detail ?? {};
				if (d.limit)
					detail += `\n  窗口: 剩余 ${d.remaining}/${d.limit}${resetDetail(toResetAt(d.resetTime))}`;
			}
			if (weekLimit > 0)
				detail += `\n  周配额: ${usage.used}/${usage.limit}${resetDetail(toResetAt(usage.resetTime))}`;
			if (json?.limited) detail += "\n  ⚠ 当前限流中";
			return {
				seg: { text: `Kimi ${parts.join("·")}`, rows, maxPercent },
				detail,
			};
		},
	},
	{
		id: "GLM",
		match: /bigmodel\.cn|z\.ai/,
		ttlMs: 5 * 60_000,
		async fetch(origin, apiKey) {
			// 智谱监控接口认证为裸 Authorization（非 Bearer）
			const res = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
				headers: { Authorization: apiKey, "Content-Type": "application/json" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json: any = await res.json();
			const limits: any[] = json?.data?.limits ?? [];
			const windows = limits.filter(
				(l) => l.type === "TOKENS_LIMIT" && typeof l.percentage === "number",
			);
			if (windows.length === 0)
				return { seg: null, detail: "响应中无 token 窗口" };

			const parts: string[] = [];
			const rows: QuotaRow[] = [];
			for (const l of windows) {
				const text = withReset(
					`${glmWindowLabel(l.unit ?? 0, l.number ?? 1)} ${Math.round(l.percentage)}%`,
					toResetAt(l.nextResetTime),
				);
				parts.push(text);
				rows.push({ text, percent: l.percentage });
			}
			const maxPercent = Math.max(...windows.map((l) => l.percentage));

			let detail = `GLM${json?.data?.level ? `（${json.data.level}）` : ""}`;
			for (const l of windows)
				detail += `\n  token ${glmWindowLabel(l.unit ?? 0, l.number ?? 1)} 窗口: ${l.percentage}%${resetDetail(toResetAt(l.nextResetTime))}`;
			for (const l of limits) {
				if (l.type === "TIME_LIMIT")
					detail += `\n  MCP 调用: ${l.currentValue}/${l.usage}`;
			}
			return {
				seg: { text: `GLM ${parts.join("·")}`, rows, maxPercent },
				detail,
			};
		},
	},
	{
		id: "DeepSeek",
		match: /deepseek\.com/,
		ttlMs: 10 * 60_000,
		async fetch(origin, apiKey) {
			const res = await fetch(`${origin}/user/balance`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json: any = await res.json();
			const info = json?.balance_infos?.[0];
			if (!info) return { seg: null, detail: "响应中无余额信息" };
			const symbol =
				info.currency === "CNY"
					? "¥"
					: info.currency === "USD"
						? "$"
						: `${info.currency} `;
			const total = parseFloat(info.total_balance);
			let detail = `DeepSeek 余额 ${symbol}${info.total_balance}`;
			if (parseFloat(info.granted_balance) > 0)
				detail += `（赠送 ${symbol}${info.granted_balance}）`;
			return { seg: { text: `DS ${symbol}${total.toFixed(1)}` }, detail };
		},
	},
	{
		id: "OpenRouter",
		match: /openrouter\.ai/,
		ttlMs: 10 * 60_000,
		async fetch(origin, apiKey) {
			const res = await fetch(`${origin}/api/v1/credits`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json: any = await res.json();
			const total = json?.data?.total_credits;
			const used = json?.data?.total_usage;
			if (typeof total !== "number" || typeof used !== "number")
				return { seg: null, detail: "响应中无 credits 信息" };
			const remain = total - used;
			return {
				seg: {
					text: `OR $${remain.toFixed(1)}`,
					maxPercent: total > 0 ? (used / total) * 100 : undefined,
				},
				detail: `OpenRouter 已用 $${used.toFixed(2)} / $${total.toFixed(2)}`,
			};
		},
	},
];

export default function (pi: ExtensionAPI) {
	// 用户开关：/statusbar 切换；新会话按此恢复
	let userWants = true;
	// 当前布局模式：session_start 重读配置时重置，/statusbar layout 运行时切换
	let layoutMode: LayoutMode = config.layout;
	// 当前会话的扩展上下文，setFooter 的 render 闭包通过它读取会话数据
	let currentCtx: ExtensionContext | null = null;
	// 当前 footer 绑定的 TUI，异步数据到位后请求重绘
	let activeTui: TUI | null = null;
	// footer factory 提供的数据源与主题，右侧面板复用（仅 setFooter factory 可拿到 footerData）
	let activeFooterData: ReadonlyFooterDataProvider | null = null;
	// 用量缓存：仅在分支条目数、末条目或单价表变化时重算，避免流式输出期间每帧全量遍历
	let cacheKey = "";
	let cachedUsage: UsageStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	// 首 token 耗时（TTFT）：before_provider_request 到首个 assistant message_start
	let reqStartTs = 0;
	let lastTtftMs: number | undefined;
	// 输出吞吐（tok/s）：assistant 首 token 到 message_end 的输出 token 数 / 生成耗时
	let firstTokTs = 0;
	let lastTps: number | undefined;
	// 生成中按 delta 字符估算的实时吞吐；liveTs 为最近一次 delta 时刻，长时间无增量则不再显示
	let liveTokens = 0;
	let liveTs = 0;
	// 实时单价表（models.dev），key 为 "provider:modelId"
	let priceTable: Record<string, ModelCost> = {};
	let priceStamp = "init";
	let priceSource = "models.json";
	let priceInflight = false;

	// ---------- 订阅额度 ----------

	interface QuotaBinding {
		source: QuotaSource;
		providerId: string;
		origin: string;
	}
	interface QuotaState {
		seg: QuotaSeg | null;
		detail: string;
		fetchedAt: number;
		inflight: boolean;
	}
	const bindings: QuotaBinding[] = [];
	const quotaStates = new Map<string, QuotaState>();

	/** 从可用模型反查 provider baseUrl 匹配额度源（models.json 的自定义 provider 不在 getRegisteredProviderIds 里） */
	function resolveQuotaBindings(ctx: ExtensionContext): void {
		bindings.length = 0;
		quotaStates.clear();
		for (const model of ctx.modelRegistry.getAvailable()) {
			if (!model.baseUrl || bindings.some((b) => b.providerId === model.provider))
				continue;
			for (const source of QUOTA_SOURCES) {
				if (bindings.some((b) => b.source.id === source.id)) continue;
				if (source.match.test(model.baseUrl)) {
					// baseUrl 非法时 new URL 会抛 TypeError，跳过该 provider 的额度绑定
					try {
						bindings.push({
							source,
							providerId: model.provider,
							origin: new URL(model.baseUrl).origin,
						});
					} catch {
						// 忽略无法解析的 baseUrl
					}
					break;
				}
			}
		}
	}

	/** 带 TTL 与 inflight 去重的额度拉取；失败静默（保留旧值/空段） */
	async function refreshQuota(
		b: QuotaBinding,
		ctx: ExtensionContext,
		force: boolean,
	): Promise<void> {
		let state = quotaStates.get(b.source.id);
		if (!state) {
			// 首次拉取：fetchedAt=0 视为已过期，立即请求
			state = { seg: null, detail: "", fetchedAt: 0, inflight: false };
			quotaStates.set(b.source.id, state);
		}
		if (state.inflight) return;
		if (!force && Date.now() - state.fetchedAt < b.source.ttlMs) return;
		state.inflight = true;
		try {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(b.providerId);
			if (!apiKey) throw new Error("provider 未配置 API key");
			const r = await b.source.fetch(b.origin, apiKey);
			state.seg = r.seg;
			state.detail = r.detail;
			state.fetchedAt = Date.now();
		} catch (err) {
			// 拉取失败：保留旧 seg，1 分钟后允许重试
			state.detail = `查询失败: ${err instanceof Error ? err.message : String(err)}`;
			state.fetchedAt = Date.now() - b.source.ttlMs + 60_000;
		} finally {
			state.inflight = false;
			activeTui?.requestRender();
		}
	}

	// ---------- 实时单价（models.dev） ----------

	/** 读取磁盘缓存的价格表（24h 内有效） */
	function loadPriceCache(): {
		fetchedAt: number;
		prices: Record<string, ModelCost>;
	} | null {
		try {
			const raw = JSON.parse(readFileSync(PRICE_CACHE_FILE, "utf8"));
			if (raw?.fetchedAt && raw?.prices) return raw;
		} catch {
			// 首次使用或缓存损坏，忽略
		}
		return null;
	}

	/** 拉取 models.dev 全量单价并投影到本地 provider:模型 键；失败静默保留旧值 */
	async function refreshPrices(
		ctx: ExtensionContext,
		force: boolean,
	): Promise<void> {
		if (priceInflight) return;
		const cached = loadPriceCache();
		if (cached) {
			priceTable = cached.prices;
			priceStamp = `cache:${cached.fetchedAt}`;
			priceSource = "models.dev(缓存)";
		}
		if (!force && cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return;

		priceInflight = true;
		try {
			const res = await fetch(MODELS_DEV_URL, {
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json: any = await res.json();
			const providers = json?.providers ?? json;
			const next: Record<string, ModelCost> = {};
			// 1) 显式 priceMap 优先：key 为本地 "provider:model" 或裸 "model"
			for (const [key, [pname, mid]] of Object.entries(config.priceMap)) {
				const c = providers?.[pname]?.models?.[mid]?.cost;
				if (c) next[key] = toModelCost(c);
			}
			// 2) models.dev 全量按模型 id 建索引（同 id 可能有多家 provider 提供）
			const byId = new Map<string, any[]>();
			for (const p of Object.values<any>(providers ?? {})) {
				for (const [id, m] of Object.entries<any>(p?.models ?? {})) {
					if (!m?.cost) continue;
					const k = id.toLowerCase();
					const list = byId.get(k);
					if (list) list.push(m.cost);
					else byId.set(k, [m.cost]);
				}
			}
			// 3) 本地可用模型自动投影：显式映射 → provider/model 直配 → 跨 provider 同名 id 取最便宜
			for (const m of ctx.modelRegistry.getAvailable()) {
				if (!m?.provider || !m?.id) continue;
				const key = `${m.provider}:${m.id}`;
				if (next[key]) continue;
				const bare = config.priceMap[m.id];
				const c =
					(bare ? providers?.[bare[0]]?.models?.[bare[1]]?.cost : undefined) ??
					providers?.[m.provider]?.models?.[m.id]?.cost ??
					byId
						.get(m.id.toLowerCase())
						?.reduce((a: any, b: any) =>
							a.input + a.output <= b.input + b.output ? a : b,
						);
				if (c) next[key] = toModelCost(c);
			}
			if (Object.keys(next).length === 0) throw new Error("未匹配到任何模型单价");
			priceTable = next;
			priceStamp = `net:${Date.now()}`;
			priceSource = "models.dev(实时)";
			try {
				writeFileSync(
					PRICE_CACHE_FILE,
					JSON.stringify({ fetchedAt: Date.now(), prices: next }),
				);
			} catch {
				// 写缓存失败不影响使用
			}
		} catch {
			// 拉取失败：保留缓存/models.json 兜底
			if (!cached) priceSource = "models.json";
		} finally {
			priceInflight = false;
			activeTui?.requestRender();
		}
	}

	/** 当前模型生效单价：models.dev 实时优先，回落 models.json 的 cost 字段 */
	function ratesFor(ctx: ExtensionContext): ModelCost | undefined {
		const model = ctx.model;
		if (!model) return undefined;
		return priceTable[`${model.provider}:${model.id}`] ?? (model as any)?.cost;
	}

	/** 按单价计算花费（含阶梯定价，逻辑与 pi-ai 的 calculateCost 一致） */
	function calcCost(rates: ModelCost | undefined, u: UsageStats): number {
		if (!rates) return u.cost;
		let r: any = rates;
		const inputTokens = u.input + u.cacheRead + u.cacheWrite;
		let matched = -1;
		for (const t of (rates as any).tiers ?? []) {
			if (inputTokens > t.inputTokensAbove && t.inputTokensAbove > matched) {
				r = t;
				matched = t.inputTokensAbove;
			}
		}
		return (
			(r.input / 1_000_000) * u.input +
			(r.output / 1_000_000) * u.output +
			(r.cacheRead / 1_000_000) * u.cacheRead +
			(r.cacheWrite / 1_000_000) * u.cacheWrite
		);
	}

	// ---------- 会话用量 ----------

	/** 汇总当前分支上全部 assistant 消息的用量（含工具内部调用） */
	function computeUsage(ctx: ExtensionContext): UsageStats {
		const branch = ctx.sessionManager.getBranch();
		const key = `${ctx.sessionManager.getSessionId()}:${branch.length}:${branch.at(-1)?.id ?? ""}:${priceStamp}`;
		if (key === cacheKey) return cachedUsage;

		const stats: UsageStats = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		};
		for (const e of branch) {
			if (e.type === "message" && e.message.role === "assistant") {
				const usage = (e.message as AssistantMessage).usage;
				stats.input += usage?.input ?? 0;
				stats.output += usage?.output ?? 0;
				stats.cacheRead += usage?.cacheRead ?? 0;
				stats.cacheWrite += usage?.cacheWrite ?? 0;
				stats.cost += usage?.cost?.total ?? 0;
			}
		}
		// 有实时单价时按实时价重算花费，否则沿用 pi 基于 models.json 的结果
		const rates = ratesFor(ctx);
		const cost = calcCost(rates, stats);
		cacheKey = key;
		cachedUsage = { ...stats, cost };
		return cachedUsage;
	}

	/**
	 * 终端标题：pi · 会话名（未命名时只显示 pi），与 opencode 等其他 agent 区分
	 * Cursor/VS Code 默认 `terminal.integrated.tabs.title: "${process}"`，看不到这里设的标题；
	 * 已在该设置里改成 `"${sequence}"`，改后集成终端显示的就是这里的标题。
	 */
	function updateTitle(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const name = ctx.sessionManager.getSessionName();
		ctx.ui.setTitle(name ? `pi · ${name}` : "pi");
	}

	// ---------- 布局：底部单行 / 右侧悬浮面板 ----------

	/** 右侧面板生命周期：done 即关闭销毁（overlay 不可复用），alive 表示已创建/创建中 */
	let panelDone: (() => void) | null = null;
	let panelAlive = false;
	let panelPending = false;

	/** 当前宽度下是否应由右侧面板接管展示 */
	function panelActive(width: number): boolean {
		return (
			layoutMode === "right" || (layoutMode === "auto" && width >= AUTO_MIN_WIDTH)
		);
	}

	/**
	 * 构建 footer 与右侧面板共用的状态段（逻辑与原单行 footer 一致）。
	 * variant=footer：用量/花费合为一段，TTFT 带 ⏱ 前缀，ctx 未知时显示 "ctx —"；
	 * variant=panel：Usage 与 Cost 分行，label 由面板渲染器展示。
	 */
	function buildSegments(
		ctx: ExtensionContext,
		theme: Theme,
		footerData: ReadonlyFooterDataProvider,
		variant: "footer" | "panel",
	): Segment[] {
		const segs: Segment[] = [];

		// git 分支；非 git 目录（如多仓工作区根）时回退显示当前目录名
		const branch = footerData.getGitBranch();
		if (branch) {
			segs.push({
				label: "Branch",
				text: theme.fg("accent", branch),
				pri: 0,
				key: "branch",
			});
		} else {
			segs.push({
				label: "Dir",
				text: theme.fg("muted", basename(ctx.cwd) || ctx.cwd),
				pri: 0,
				key: "branch",
			});
		}

		// 上下文占用
		const cu = ctx.getContextUsage();
		if (cu) {
			if (cu.percent == null) {
				// 压缩后或下次响应前 tokens 未知
				segs.push({
					label: "Ctx",
					text: theme.fg("dim", variant === "footer" ? "ctx —" : "—"),
					pri: 0,
					key: "ctx",
				});
			} else {
				const color =
					cu.percent >= 90 ? "error" : cu.percent >= 75 ? "warning" : "success";
				segs.push({
					label: "Ctx",
					text: theme.fg(
						color,
						`${contextBar(cu.percent)} ${Math.round(cu.percent)}%`,
					),
					pri: 0,
					key: "ctx",
				});
			}
		}

		// 当前模型 + 思考强度（off 时不显示强度）
		if (ctx.model?.id) {
			const level = pi.getThinkingLevel();
			const showEffort =
				!!level && level !== "off" && !config.hiddenMetrics.includes("effort");
			if (variant === "panel") {
				// 面板竖排：模型与思考强度分行，避免长模型名被截断
				segs.push({
					label: "Model",
					text: theme.fg("muted", ctx.model.id),
					pri: 1,
					key: "model",
				});
				if (showEffort)
					segs.push({
						label: "Effort",
						text: theme.fg("muted", level!),
						pri: 1,
						key: "effort",
					});
			} else {
				const label = showEffort ? `${ctx.model.id}·${level}` : ctx.model.id;
				segs.push({
					label: "Model",
					text: theme.fg("muted", label),
					pri: 1,
					key: "model",
				});
			}
		}

		// token 用量、缓存命中率与花费
		const u = computeUsage(ctx);
		const inText = `↑${fmtTokens(u.input)}`;
		const outText = `↓${fmtTokens(u.output)}`;
		let cacheText = "";
		if (u.cacheRead > 0) {
			// 命中率 = 缓存读 / 总输入（未缓存输入 + 缓存读 + 缓存写）
			const totalIn = u.input + u.cacheRead + u.cacheWrite;
			const rate = totalIn > 0 ? Math.round((u.cacheRead / totalIn) * 100) : 0;
			cacheText = `⚡${fmtTokens(u.cacheRead)}·${rate}%`;
		}
		const costText = fmtCost(u.cost);
		if (variant === "panel") {
			// 竖排值列较窄，输入/输出/缓存各占一行，避免长值被截断
			segs.push({
				label: "In",
				text: theme.fg("muted", inText),
				pri: 2,
				key: "usage",
			});
			segs.push({
				label: "Out",
				text: theme.fg("muted", outText),
				pri: 2,
				key: "usage",
			});
			if (cacheText)
				segs.push({
					label: "Cache",
					text: theme.fg("muted", cacheText),
					pri: 2,
					key: "usage",
				});
			segs.push({
				label: "Cost",
				text: theme.fg("muted", costText),
				pri: 2,
				key: "usage",
			});
		} else {
			const parts = [inText, outText];
			if (cacheText) parts.push(cacheText);
			parts.push(costText);
			segs.push({
				label: "Usage",
				text: theme.fg("muted", parts.join(" ")),
				pri: 2,
				key: "usage",
			});
		}

		// 首 token 耗时（最近一次请求，未完成时不显示）
		if (lastTtftMs != null)
			segs.push({
				label: "TTFT",
				text: theme.fg(
					"muted",
					variant === "footer" ? `⏱${fmtMs(lastTtftMs)}` : fmtMs(lastTtftMs),
				),
				pri: 2,
				key: "ttft",
			});

		// 输出吞吐：生成中显示按字符估算的实时值（~ 前缀），否则显示最近一次响应的精确值
		const liveSecs = firstTokTs ? (Date.now() - firstTokTs) / 1000 : 0;
		if (
			firstTokTs &&
			liveTokens > 0 &&
			liveSecs >= 0.3 &&
			Date.now() - liveTs < 5000
		) {
			segs.push({
				label: "Speed",
				text: theme.fg("muted", `~${fmtTps(liveTokens / liveSecs)} tok/s`),
				pri: 2,
				key: "speed",
			});
		} else if (lastTps != null) {
			segs.push({
				label: "Speed",
				text: theme.fg("muted", `${fmtTps(lastTps)} tok/s`),
				pri: 2,
				key: "speed",
			});
		}

		// 订阅额度：只显示当前模型所属 provider 的源，切模型即切换；无缓存或过期则异步刷新
		const curProvider = ctx.model?.provider;
		const active =
			curProvider == null
				? undefined
				: bindings.find((b) => b.providerId === curProvider);
		if (active) {
			const state = quotaStates.get(active.source.id);
			if (!state || Date.now() - state.fetchedAt >= active.source.ttlMs)
				void refreshQuota(active, ctx, false);
			if (state?.seg) {
				const colorOf = (p: number | undefined) => {
					if (p == null) return "muted";
					return p >= 85 ? "error" : p >= 60 ? "warning" : "success";
				};
				// 面板值列窄：逐窗口分行（每行自带恢复倒计时），底部单行各窗口用 · 连接
				if (variant === "panel" && state.seg.rows?.length) {
					for (const r of state.seg.rows)
						segs.push({
							label: "Quota",
							text: theme.fg(colorOf(r.percent), r.text),
							pri: 2,
							key: "quota",
						});
				} else {
					segs.push({
						label: "Quota",
						text: theme.fg(colorOf(state.seg.maxPercent), state.seg.text),
						pri: 2,
						key: "quota",
					});
				}
			}
		}

		// 保留其他扩展通过 setStatus 输出的状态，命中隐藏规则的除外
		for (const s of footerData.getExtensionStatuses().values()) {
			if (!s) continue;
			if (config.hideExtStatuses.some((h) => s.includes(h))) continue;
			segs.push({ label: "", text: s, pri: 3, key: "ext" });
		}
		// 应用指标显隐配置（/statusbar metrics）
		return segs.filter((s) => !s.key || !config.hiddenMetrics.includes(s.key));
	}

	/** 右侧信息面板：竖排 label/value 行 + 边框。
	 *  overlay 模式下（无 heightOf）高度贴合内容；
	 *  右侧分栏模式下传入 heightOf，把卡片铺满整个视口高度，避免右侧留下一条空白列。 */
	const PANEL_LABEL_W = 7;
	class StatusPanel implements Component {
		constructor(
			private theme: Theme,
			private heightOf?: () => number,
		) {}
		invalidate(): void {}
		render(width: number): string[] {
			// 渲染期异常绝不允许冒泡：pi 会把它当 uncaughtException 直接退出进程。
			// 旧实例的组件在 /reload 后可能仍挂在布局树上（currentCtx 已失效）。
			try {
				return this.renderPanel(width);
			} catch {
				return [];
			}
		}
		private renderPanel(width: number): string[] {
			const ctx = currentCtx;
			const fd = activeFooterData;
			if (!ctx || !fd) return [];
			const th = this.theme;
			const innerW = Math.max(PANEL_LABEL_W + 4, width - 2);
			const g = BORDER_CHARS[resolvePanelBorder(config.panelBorder)];
			const border = (l: string, r: string) =>
				th.fg("dim", l + g.h.repeat(innerW) + r);
			const body: string[] = [];
			const row = (content: string) => {
				const padded =
					content + " ".repeat(Math.max(0, innerW - visibleWidth(content)));
				body.push(th.fg("dim", g.v) + padded + th.fg("dim", g.v));
			};
			for (const s of buildSegments(ctx, th, fd, "panel")) {
				if (s.label) {
					const valueW = Math.max(1, innerW - 2 - PANEL_LABEL_W - 1);
					const valueLines = wrapTextWithAnsi(s.text, valueW);
					valueLines.forEach((line, i) => {
						const labelCol =
							i === 0
								? th.fg("dim", s.label.padEnd(PANEL_LABEL_W))
								: " ".repeat(PANEL_LABEL_W);
						row(" " + labelCol + " " + line);
					});
				} else {
					for (const line of wrapTextWithAnsi(s.text, innerW - 2)) {
						row(" " + line);
					}
				}
			}
			// 分栏模式：panelFill 时补满到视口高度（上下边框各占 1 行），超出部分由布局层裁切
			const target =
				this.heightOf && config.panelFill ? Math.max(1, this.heightOf() - 2) : 0;
			while (target > 0 && body.length < target) row("");
			return [border(g.tl, g.tr), ...body, border(g.bl, g.br)];
		}
	}

	/** 创建右侧面板 overlay（微任务延迟，避免在 render 周期内同步变更 overlay 栈） */
	function ensurePanel(ctx: ExtensionContext): void {
		if (panelAlive || panelPending || !ctx.hasUI || !activeFooterData) return;
		panelPending = true;
		queueMicrotask(() => {
			panelPending = false;
			if (panelAlive || !userWants) return;
			panelAlive = true;
			const reset = () => {
				panelAlive = false;
				panelDone = null;
			};
			try {
				void ctx.ui
					.custom<void>(
						(tui, theme, _kb, done) => {
							panelDone = done;
							if (!activeTui) activeTui = tui;
							return new StatusPanel(theme);
						},
						{
							overlay: true,
							// 函数形式：每次渲染重读配置/布局，resize 时自动重判可见性
							overlayOptions: () => ({
								anchor: "right-center",
								width: config.rightWidth,
								maxHeight: "80%",
								// right:0：与右侧分栏面板同一列。浮层是 right:1（面板左移一格），
								// 切换 split 开关时面板会左右跳一格，终端只会重绘变化过的行，
								// 于是留下半旧半新的错位残影（用户反馈的“不对齐”）
								margin: { right: 0 },
								nonCapturing: true,
							visible: (w: number) =>
								userWants &&
								panelAlive &&
								// 进分栏的过渡帧：分栏还没装好就先把浮层顶住，避免面板闪掉一帧；
								// 装好了（或本来就未在切分栏）就按普通规则：只在该显示浮层时可见
								(layoutMode === "split"
									? !(activeTui && splitInstalled(activeTui))
									: panelActive(w)),
							}),
						},
					)
					.then(reset)
					.catch(reset);
			} catch {
				// custom() 同步抛错（如 UI 已销毁）时复位，下一帧 footer 兜底继续渲染
				reset();
			}
		});
	}

	/** 关闭并销毁面板（overlay 销毁后不可复用，再次启用时由 ensurePanel 重建） */
	function closePanel(): void {
		const done = panelDone;
		panelDone = null;
		panelAlive = false;
		panelPending = false;
		try {
			done?.();
		} catch {
			// 已关闭时重复调用 done 可能报错，忽略
		}
	}

	// ---------- 右侧分栏（split）：仅 fullscreen/alt-screen 模式具备布局树 ----------

	/** 我们安装的 HStack（幂等判据 + 卸载依据）；splitCore 是它包住的核心布局根（transcript + dock） */
	let splitWrapper: Component | null = null;
	let splitCore: Component | null = null;
	let splitBasis = 0;
	let splitPending = false;
	let splitPanel: StatusPanel | null = null;
	let splitPanelTheme: Theme | null = null;
	/** visible 回调每帧记录整个视口宽度：分栏下 footer 收到的宽度已扣掉侧栏，不能再当归属判据 */
	let splitViewportW = 0;

	/**
	 * 访问 pi-tui alt-screen renderer 的布局根。
	 * SAFETY: pi-tui 只公开了 `ViewportTUI.setLayoutRoot()`，真正的读写目标是 TS 里标为 private 的
	 * `layoutRoot` 字段；调用方必须先过 splitCapable()（已确认 mode==="fullscreen" 且 setLayoutRoot 可调用）。
	 * 另外扩展拿到的 `tui` 是 pi 的 live proxy，每次读属性都会转发到当前 renderer，切模式后依然有效。
	 */
	interface LayoutRootHost {
		layoutRoot?: Component;
		setLayoutRoot(root: Component | undefined): void;
	}
	function asLayoutRootHost(tui: TUI): LayoutRootHost {
		// SAFETY: 仅当 splitCapable() 通过（mode==="fullscreen" 且 setLayoutRoot 可调用）时才会调用本函数；
		// 断言的对象是 pi 的 live TUI proxy，属性读取会转发到当前 alt-screen renderer。
		return tui as unknown as LayoutRootHost;
	}

	/** pi-tui 是否提供 HStack（旧版本没有；命名导入会在链接期直接抛错，所以用命名空间导入 + 一次性特性检测） */
	const HAS_PI_TUI_HSTACK = typeof piTuiRuntime.HStack === "function";

	/** 当前 TUI 是否具备右侧分栏能力：fullscreen 布局树 + pi-tui 提供 HStack */
	function splitCapable(tui: TUI | null): boolean {
		if (!tui || tui.mode !== "fullscreen") return false;
		if (!HAS_PI_TUI_HSTACK) return false;
		const t = asLayoutRootHost(tui);
		return typeof t.setLayoutRoot === "function" && "layoutRoot" in tui;
	}

	/** 分栏可用宽度下限：内容区至少留 24 列（layout=right 在极窄终端下不把聊天压成一条） */
	function splitWidthOk(width: number): boolean {
		return width >= config.rightWidth + 24;
	}

	/** 分栏是否已装在当前 renderer 上（核心切模式时会重设 layoutRoot，需要重包） */
	function splitInstalled(tui: TUI): boolean {
		if (!splitWrapper) return false;
		return asLayoutRootHost(tui).layoutRoot === splitWrapper;
	}

	/**
	 * 安装右侧分栏：把核心布局根（transcript + dock 的 VStack）包进 HStack，右侧挂状态面板。
	 * 聊天按剩余宽度重新换行，不遮挡任何内容 —— 与 opencode 的 flexDirection="row" 同构。
	 * 幂等；微任务延迟，不在 render 周期内同步改写布局树。
	 */
	function ensureSplit(tui: TUI, theme: Theme): void {
		if (layoutMode !== "split" || splitPending || !splitCapable(tui)) return;
		const t = asLayoutRootHost(tui);
		const cur = t.layoutRoot;
		if (!cur) return;
		if (splitInstalled(tui) && splitBasis === config.rightWidth) return; // 已就绪
		splitPending = true;
		queueMicrotask(() => {
			splitPending = false;
			if (layoutMode !== "split" || !userWants || !splitCapable(tui)) return;
			const root = t.layoutRoot;
			if (!root) return;
			const basis = config.rightWidth;
			if (root === splitWrapper && splitBasis === basis) return;
			// 核心重设过 layoutRoot 时 root 就是新的核心根，否则 root 是我们的 wrapper
			const core = root === splitWrapper && splitCore ? splitCore : root;
			try {
				if (!splitPanel || splitPanelTheme !== theme) {
					splitPanel = new StatusPanel(theme, () => tui.terminal.rows);
					splitPanelTheme = theme;
				}
				const panel = splitPanel;
				const wrapper = new piTuiRuntime.HStack(
					[
						// basis: 0 + grow: 1 与核心自身的 transcript 写法一致：
						// 避免布局引擎为测量固有宽度而多渲染一遍整个核心布局（每帧一次全量重排）
						{ component: core, basis: 0, grow: 1, shrink: 1, minSize: 24 },
						{
							component: panel,
							basis,
							grow: 0,
							shrink: 0,
							visible: (vp: { width: number; height: number }) => {
								splitViewportW = vp.width;
								return userWants && splitWidthOk(vp.width);
							},
						},
					],
					{ gap: 1 },
				);
				splitWrapper = wrapper;
				splitCore = core;
				splitBasis = basis;
				t.setLayoutRoot(wrapper);
				// 分栏已装好，这时才关浇浮层：切换过程中面板不会“消失一帧”
				closePanel();
				// 普通重绘即可（布局变了，受影响的行字符串都变了）；
				// 不要用 requestRender(true) 整屏清屏，那会闪一下，切换很不丝滑
				tui.requestRender();
			} catch {
				// 布局根不可用（pi 升级改了结构 / 缺 HStack）：静默回退浮层或底部单行
				splitWrapper = null;
				splitCore = null;
				splitBasis = 0;
			}
		});
	}

	/** 卸载右侧分栏，把核心布局根还回去 */
	function closeSplit(): void {
		const wrapper = splitWrapper;
		const core = splitCore;
		splitWrapper = null;
		splitCore = null;
		splitBasis = 0;
		splitViewportW = 0;
		if (!wrapper) return;
		// 只判 mode：这里不需要 HStack（卸载不依赖它），也不能用 splitCapable
		// 提前返回，否则 wrapper 会永久留在布局树上（reload 后渲染陈旧 ctx → pi 退出）
		const tui = activeTui;
		if (!tui || tui.mode !== "fullscreen") return;
		const t = asLayoutRootHost(tui);
		try {
			if (t.layoutRoot === wrapper) {
				t.setLayoutRoot(core ?? undefined);
				// 同理：普通重绘即可，不做整屏清屏（避免切换时闪一下）
				queueMicrotask(() => {
					try {
						tui.requestRender();
					} catch {
						// TUI 已销毁，忽略
					}
				});
			}
		} catch {
			// TUI 已销毁或核心已接管布局根，忽略
		}
	}

	// ---------- footer ----------

	function enable(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		currentCtx = ctx;
		userWants = true;
		cacheKey = "";
		resolveQuotaBindings(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			activeFooterData = footerData;
			// 分支切换（含 worktree 切换）时请求重绘
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const ctx = currentCtx;
					if (!ctx) return [];
					// 分栏 / 浮层 / 底部单行 三态切换：尽量保证每一帧都有面板，且不做整屏清屏（会闪）
					// 分栏下 footer 收到的宽度已被侧栏扣掉，归属判定用整个视口宽度
					const fullW = splitViewportW || tui.terminal.columns;
					if (layoutMode === "split") {
						// layout=split 是显式选择：只要装得下（≥ rightWidth+24）就分栏，不再叠一层 auto 的 120 列阈值
						if (splitWidthOk(fullW)) {
							ensureSplit(tui, theme);
							// 本帧就会装上（pending）或已装好：让位。
							// 只有“确实装不上”（非 pending）时才回退渲染底部单行
							if (splitPending || splitInstalled(tui)) return [];
						} else if (splitWrapper) {
							closeSplit(); // 极窄终端：拆掉退回底部单行
						}
					} else if (panelActive(fullW)) {
						// 该显示浮层：先把浮层起起来，就绪后再拆分栏，避免中间出现无面板的帧
						ensurePanel(ctx);
						if (panelAlive || panelPending) {
							if (splitWrapper) closeSplit();
							return [];
						}
					} else if (splitWrapper) {
						closeSplit(); // 目标是底部单行：直接拆
					}
					const sep = theme.fg("dim", " │ ");
					const segs = buildSegments(ctx, theme, footerData, "footer");

					// 超宽时先按 pri 从大到小丢弃可牺牲段（保留 pri=0 的分支/上下文），
					// 仍放不下则换行成多行，段保持完整不拆
					const join = (list: Segment[]) => list.map((s) => s.text).join(sep);
					const dropOrder = segs
						.map((_, i) => i)
						.sort((a, b) => segs[b].pri - segs[a].pri);
					let out = segs;
					let di = 0;
					while (
						di < dropOrder.length &&
						segs[dropOrder[di]].pri > 0 &&
						visibleWidth(truncateToWidth(join(out), width)) > width
					) {
						const victim = segs[dropOrder[di++]];
						out = out.filter((s) => s !== victim);
					}
					const rows: string[] = [];
					let rowSegs: Segment[] = [];
					for (const s of out) {
						const cand = rowSegs.length ? [...rowSegs, s] : [s];
						const line = join(cand);
						if (rowSegs.length && visibleWidth(line) > width) {
							rows.push(truncateToWidth(join(rowSegs), width));
							rowSegs = [s];
						} else {
							rowSegs = cand;
						}
					}
					if (rowSegs.length) rows.push(truncateToWidth(join(rowSegs), width));
					return rows;
				},
			};
		});
	}

	function disable(ctx: ExtensionContext): void {
		userWants = false;
		closePanel();
		closeSplit();
		if (!ctx.hasUI) return;
		ctx.ui.setFooter(undefined);
	}

	// ---------- 命令与事件 ----------

	type MenuAction = "metrics" | "toggle";

	/** 将一块输入拆分为独立按键序列（终端快速按键可能合并为单个 data 块送达） */
	function splitKeySeqs(data: string): string[] {
		return (
			data.match(
				/\x1b\[[0-9;]*[a-zA-Z]|\x1bO[A-Za-z]|\x1b[A-Za-z]|\x1b|\r|\n|[\s\S]/g,
			) ?? [data]
		);
	}

	/** 菜单头部：─── 标题 ───… */
	function menuHeader(theme: Theme, title: string, width: number): string {
		const bar = theme.fg("borderMuted", "─");
		const tt = ` ${theme.fg("accent", title)} `;
		const rest = bar.repeat(Math.max(0, width - 6 - visibleWidth(tt)));
		return truncateToWidth(`  ${bar.repeat(3)}${tt}${rest}`, width);
	}

	/** 菜单行：光标 + 标签（固定列宽，值紧跟其后） + 值 */
	function menuRow(
		theme: Theme,
		sel: boolean,
		left: string,
		right: string,
		labelCol: number,
		width: number,
	): string {
		const mark = sel ? theme.fg("accent", "❯") : " ";
		const l = sel ? theme.fg("text", left) : theme.fg("muted", left);
		const pad = Math.max(2, labelCol - visibleWidth(left));
		return truncateToWidth(`  ${mark} ${l}${" ".repeat(pad)}${right}`, width);
	}

	/** /statusbar 交互式菜单：↑↓ 选择，布局/语言行 ←→ 调值，Enter 确认，Esc 退出 */
	class StatusbarMenuComponent {
		private sel = 0;
		private cachedW?: number;
		private cachedLines?: string[];
		private static readonly ROWS = 6;

		constructor(
			private theme: Theme,
			private close: (action: MenuAction | null) => void,
			private notify: (msg: string, type: "info" | "warning") => void = () => {},
		) {}

		private cycleLayout(dir: 1 | -1): void {
			const i = LAYOUT_ORDER.indexOf(layoutMode);
			setLayout(
				LAYOUT_ORDER[(i + dir + LAYOUT_ORDER.length) % LAYOUT_ORDER.length],
				this.notify,
			);
			this.invalidate();
		}

		/** 切换中英文（即时写回配置文件，菜单文案实时切换） */
		private cycleLang(): void {
			config.language = config.language === "zh" ? "en" : "zh";
			try {
				saveConfigPatch({ language: config.language });
			} catch {
				// 写入失败不影响本次会话内的显示
			}
			this.invalidate();
		}

		/** 切换面板边框字符集：auto → unicode → ascii 循环（与 /statusbar border 共用） */
		private cycleBorder(): void {
			setPanelBorder(nextPanelBorder(config.panelBorder));
			this.invalidate();
		}

		/** 切换面板是否铺满高度（写回配置，与 /statusbar fill 共用） */
		private toggleFill(): void {
			setPanelFill(!config.panelFill);
			this.invalidate();
		}

		handleInput(data: string): void {
			for (const seq of splitKeySeqs(data)) this.handleKey(seq);
		}

		private handleKey(data: string): void {
			const N = StatusbarMenuComponent.ROWS;
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
				return this.close(null);
			if (matchesKey(data, "up")) {
				this.sel = (this.sel + N - 1) % N;
				this.invalidate();
				return;
			}
			if (matchesKey(data, "down")) {
				this.sel = (this.sel + 1) % N;
				this.invalidate();
				return;
			}
			if (matchesKey(data, "left")) {
				if (this.sel === 0) return this.cycleLayout(-1);
				if (this.sel === 1) return this.cycleBorder();
				if (this.sel === 2) return this.toggleFill();
				if (this.sel === 3) return this.cycleLang();
			}
			if (matchesKey(data, "right")) {
				if (this.sel === 0) return this.cycleLayout(1);
				if (this.sel === 1) return this.cycleBorder();
				if (this.sel === 2) return this.toggleFill();
				if (this.sel === 3) return this.cycleLang();
			}
			if (matchesKey(data, "return")) {
				if (this.sel === 4) return this.close("metrics");
				if (this.sel === 5) return this.close("toggle");
				return this.close(null); // 布局/边框/填充/语言行：已实时生效，Enter 即完成退出
			}
		}

		render(width: number): string[] {
			if (this.cachedLines && this.cachedW === width) return this.cachedLines;
			const th = this.theme;
			const T = t();
			const lines: string[] = ["", menuHeader(th, T.menuTitle, width), ""];
			const labels = [
				T.rowLayout,
				T.rowBorder,
				T.rowFill,
				T.rowLang,
				T.rowMetrics,
				userWants ? T.rowDisable : T.rowEnable,
			];
			// 值列紧跟标签：固定列宽 = 最长标签 + 3，不再贴右边缘
			const labelCol = Math.max(...labels.map((l) => visibleWidth(l))) + 3;
			// 可调值：两侧 ◀ ▶，选中行高亮
			const adjustable = (on: boolean, text: string) =>
				on
					? `${th.fg("accent", "◀")} ${th.fg("accent", text)} ${th.fg("accent", "▶")}`
					: `${th.fg("dim", "◀")} ${th.fg("muted", text)} ${th.fg("dim", "▶")}`;
			// 行 0：布局（auto / bottom / right / split；进出 split 会同步 pi 的 tuiMode 并写回配置）
			const layoutValue =
				layoutMode === "split" && !splitCapable(activeTui)
					? `${LAYOUT_LABELS[config.language].split} · ${T.splitNeedFullscreen}`
					: LAYOUT_LABELS[config.language][layoutMode];
			lines.push(
				menuRow(
					th,
					this.sel === 0,
					labels[0],
					adjustable(this.sel === 0, layoutValue),
					labelCol,
					width,
				),
			);
			// 行 1：面板边框字符集（值显示实际生效的字形集）
			lines.push(
				menuRow(
					th,
					this.sel === 1,
					labels[1],
					adjustable(this.sel === 1, panelBorderLabel(config.panelBorder)),
					labelCol,
					width,
				),
			);
			// 行 2：面板填充（只影响 layout=split；浮层本来就贴合内容）
			lines.push(
				menuRow(
					th,
					this.sel === 2,
					labels[2],
					adjustable(this.sel === 2, config.panelFill ? T.fillOn : T.fillOff),
					labelCol,
					width,
				),
			);
			// 行 3：语言
			lines.push(
				menuRow(
					th,
					this.sel === 3,
					labels[3],
					adjustable(this.sel === 3, LANG_LABELS[config.language]),
					labelCol,
					width,
				),
			);
			// 行 4：指标显隐（显示计数）
			const hiddenCount = config.hiddenMetrics.length;
			lines.push(
				menuRow(
					th,
					this.sel === 4,
					labels[4],
					th.fg(
						hiddenCount ? "warning" : "muted",
						T.metricsCount(METRICS.length - hiddenCount, METRICS.length),
					),
					labelCol,
					width,
				),
			);
			// 行 5：启用/停用
			lines.push(menuRow(th, this.sel === 5, labels[5], "", labelCol, width));
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", T.menuHint)}`, width));
			lines.push("");
			this.cachedW = width;
			this.cachedLines = lines;
			return lines;
		}

		invalidate(): void {
			this.cachedW = undefined;
			this.cachedLines = undefined;
		}
	}

	/** 指标显隐选择器：↑↓ 选择、Space 切换、Enter 保存、Esc 取消 */
	class MetricsPickerComponent {
		private sel = 0;
		private hidden: Set<MetricKey>;
		private cachedW?: number;
		private cachedLines?: string[];

		constructor(
			private theme: Theme,
			initHidden: MetricKey[],
			private onPreview: (keys: MetricKey[]) => void,
			private close: (saved: boolean) => void,
		) {
			this.hidden = new Set(initHidden);
		}

		private keys(): MetricKey[] {
			return METRICS.filter((m) => this.hidden.has(m.key)).map((m) => m.key);
		}

		handleInput(data: string): void {
			for (const seq of splitKeySeqs(data)) this.handleKey(seq);
		}

		private handleKey(data: string): void {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
				return this.close(false);
			if (matchesKey(data, "up")) {
				this.sel = (this.sel + METRICS.length - 1) % METRICS.length;
				this.invalidate();
				return;
			}
			if (matchesKey(data, "down")) {
				this.sel = (this.sel + 1) % METRICS.length;
				this.invalidate();
				return;
			}
			if (matchesKey(data, "space")) {
				const k = METRICS[this.sel].key;
				if (this.hidden.has(k)) this.hidden.delete(k);
				else this.hidden.add(k);
				this.onPreview(this.keys()); // 即时预览，Esc 可回退
				this.invalidate();
				return;
			}
			if (matchesKey(data, "return")) return this.close(true);
		}

		render(width: number): string[] {
			if (this.cachedLines && this.cachedW === width) return this.cachedLines;
			const th = this.theme;
			const T = t();
			const lines: string[] = ["", menuHeader(th, T.pickerTitle, width), ""];
			METRICS.forEach((m, i) => {
				const cur = i === this.sel;
				const shown = !this.hidden.has(m.key);
				const name = metricName(m);
				const mark = cur ? th.fg("accent", "❯") : " ";
				const icon = shown ? th.fg("success", "●") : th.fg("dim", "○");
				const text = shown
					? cur
						? th.fg("text", name)
						: th.fg("muted", name)
					: th.fg("dim", name);
				lines.push(truncateToWidth(`  ${mark} ${icon} ${text}`, width));
			});
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", T.pickerHint)}`, width));
			lines.push("");
			this.cachedW = width;
			this.cachedLines = lines;
			return lines;
		}

		invalidate(): void {
			this.cachedW = undefined;
			this.cachedLines = undefined;
		}
	}

	/** /statusbar layout 子命令入口：省略 mode 时按 LAYOUT_ORDER 循环 */
	function applyLayout(ctx: ExtensionContext, mode?: LayoutMode): void {
		const notify = (msg: string, type: "info" | "warning") =>
			ctx.ui.notify(msg, type);
		if (mode) {
			setLayout(mode, notify);
			return;
		}
		const i = LAYOUT_ORDER.indexOf(layoutMode);
		setLayout(LAYOUT_ORDER[(i + 1) % LAYOUT_ORDER.length], notify);
	}

	/**
	 * 开关右侧分栏并提示（写回配置文件，与 language 一样持久化）。
	 * 需 fullscreen 模式才真正生效；regular 模式/缺 HStack 时退回底部单行（不建浮层）。
	 */
	/** pi 全局设置文件路径（split 自动同步 TUI mode 用；尊重 PI_CODING_AGENT_DIR） */
	function piSettingsPath(): string {
		const fn = (piAgentRuntime as { getSettingsPath?: () => string })
			.getSettingsPath;
		if (typeof fn === "function") return fn.call(piAgentRuntime);
		const envDir = process.env.PI_CODING_AGENT_DIR;
		const dir = envDir
			? envDir.replace(/^~(?=\/|$)/, homedir())
			: join(homedir(), ".pi", "agent");
		return join(dir, "settings.json");
	}

	interface TuiModeSync {
		/** 是否真的写入了 pi settings.json */
		wrote: boolean;
		/** 当前会话仍不是 fullscreen，需要重启 pi 才生效 */
		needsRestart: boolean;
		failed: boolean;
	}

	/**
	 * 开启右侧分栏时自动把 pi 的 tuiMode 设为 fullscreen（避免用户要改两处配置），关闭时还原。
	 * 安全性：pi 自己的 settings 保存只合并「已修改字段」（settings-manager.persistScopedSettings
	 * 先读文件再合并），所以这里的外部写入不会被 pi 后续保存抹掉。
	 */
	function syncPiTuiMode(on: boolean): TuiModeSync {
		const none: TuiModeSync = {
			wrote: false,
			needsRestart: false,
			failed: false,
		};
		try {
			const file = piSettingsPath();
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return { ...none, failed: true };
			const settings = parsed as Record<string, unknown>;
			const current = typeof settings.tuiMode === "string" ? settings.tuiMode : "";

			if (on) {
				if (current === "fullscreen") return none;
				if (config.tuiModeBackup === undefined) {
					config.tuiModeBackup = current === "" ? "none" : current;
					saveConfigPatch({ tuiModeBackup: config.tuiModeBackup });
				}
				settings.tuiMode = "fullscreen";
				writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
				return {
					wrote: true,
					needsRestart: !splitCapable(activeTui),
					failed: false,
				};
			}

			// 关闭：只有确实由我们改过（有备份）才还原
			if (config.tuiModeBackup === undefined) return none;
			if (config.tuiModeBackup === "none") delete settings.tuiMode;
			else settings.tuiMode = config.tuiModeBackup;
			config.tuiModeBackup = undefined;
			saveConfigPatch({ tuiModeBackup: config.tuiModeBackup });
			writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
			return { wrote: true, needsRestart: false, failed: false };
		} catch {
			return { ...none, failed: true };
		}
	}

	/**
	 * 统一的 split 开关：写 statusbar.json + 自动同步 pi 的 TUI mode + 报结果。
	 * /statusbar split 子命令与交互式菜单共用，保证两条路径行为一致。
	 */
	function setLayout(
		next: LayoutMode,
		notify?: (msg: string, type: "info" | "warning") => void,
	): void {
		const T = t();
		const prev = layoutMode;
		if (prev === next) return;
		layoutMode = next;
		config.layout = next;
		try {
			// split 是旧的独立开关：写回时顺手置 undefined 删掉，避免两份配置打架
			saveConfigPatch({ layout: next, split: undefined });
		} catch {
			// 写入失败不影响本次会话内的显示
		}
		// 进分栏：不在这里关浮层 —— 浮层的 visible 会一直顶到分栏装好（见 overlayOptions）
		// 出分栏：也不在这里拆 —— 等浮层就绪后由 footer 下一帧拆（见 render 里的分支），
		// 这样两个方向都不会出现“既没有分栏也没有浮层”的中间帧
		if (!userWants) closeSplit();
		// 面板位置/高度变了：普通重绘即可，不做整屏清屏（否则切换时会闪一下）
		if (userWants) activeTui?.requestRender();

		if (next !== "split" && prev !== "split") {
			if (!notify) return;
			notify(
				next === "auto"
					? `状态栏布局: auto（终端 ≥${AUTO_MIN_WIDTH} 列时右侧浮层，否则底部单行）`
					: `状态栏布局: ${LAYOUT_LABELS[config.language][next]}`,
				"info",
			);
			return;
		}

		const sync = syncPiTuiMode(next === "split");
		if (next !== "split") {
			notify?.(
				sync.failed
					? T.splitSetFailed
					: sync.wrote
						? T.splitRestored
						: T.splitDisabled,
				sync.failed ? "warning" : "info",
			);
			return;
		}
		if (!HAS_PI_TUI_HSTACK) {
			notify?.(T.splitUnavailable, "warning");
			return;
		}
		if (splitCapable(activeTui)) {
			notify?.(T.splitEnabled, "info");
			return;
		}
		// 当前会话不是 fullscreen：配置已写好，重启 pi 后生效
		notify?.(
			sync.failed ? T.splitSetFailed : T.splitNeedsRestart,
			sync.failed ? "warning" : "info",
		);
	}

	/** /statusbar split on|off 兼容别名：on = layout split，off = 回到默认布局 */
	function applySplit(ctx: ExtensionContext, on: boolean): void {
		setLayout(on ? "split" : DEFAULT_LAYOUT, (msg, type) =>
			ctx.ui.notify(msg, type),
		);
	}

	/**
	 * 切换面板边框字符集（写回配置文件，立即生效）。
	 * 换字符会改掉整块边框：强制整屏重绘，避开个别终端对旧方框字符的残影。
	 */
	function setPanelBorder(
		next: PanelBorder,
		notify?: (msg: string, type: "info" | "warning") => void,
	): void {
		if (config.panelBorder === next) {
			notify?.(`面板边框已是 ${panelBorderLabel(next)}`, "info");
			return;
		}
		config.panelBorder = next;
		try {
			saveConfigPatch({ panelBorder: next });
		} catch {
			// 写入失败不影响本次会话内的显示
		}
		activeTui?.requestRender();
		notify?.(
			`面板边框: ${panelBorderLabel(next)}` +
				(resolvePanelBorder(next) === "ascii"
					? "（与文字同层，可绕开方框字符残影）"
					: ""),
			"info",
		);
	}

	/** /statusbar border 子命令入口（无参数 = 按 auto → unicode → ascii 循环） */
	function applyPanelBorder(
		ctx: ExtensionContext,
		arg: string | undefined,
	): void {
		let next: PanelBorder;
		if (arg === "auto" || arg === "unicode" || arg === "ascii") next = arg;
		else next = nextPanelBorder(config.panelBorder);
		setPanelBorder(next, (msg, type) => ctx.ui.notify(msg, type));
	}

	/**
	 * 切换分栏面板是否铺满整屏高度（写回配置 + 整屏重绘，边框长度会变）。
	 * 只对 layout=split 有效；浮层本来就贴合内容。
	 */
	function setPanelFill(
		on: boolean,
		notify?: (msg: string, type: "info" | "warning") => void,
	): void {
		const T = t();
		if (config.panelFill === on) {
			notify?.(`面板填充已是 ${on ? T.fillOn : T.fillOff}`, "info");
			return;
		}
		config.panelFill = on;
		try {
			saveConfigPatch({ panelFill: on });
		} catch {
			// 写入失败不影响本次会话内的显示
		}
		activeTui?.requestRender();
		notify?.(
			`面板填充: ${on ? T.fillOn : T.fillOff}` +
				(layoutMode === "split" ? "" : "（仅 layout=split 生效）"),
			"info",
		);
	}

	/** /statusbar fill 子命令入口（无参数 = 取反） */
	function applyPanelFill(ctx: ExtensionContext, arg: string | undefined): void {
		const on = arg ? arg === "on" : !config.panelFill;
		setPanelFill(on, (msg, type) => ctx.ui.notify(msg, type));
	}

	/** 切换自定义状态栏 / 内置 footer */
	function toggleStatusbar(ctx: ExtensionContext): void {
		if (userWants) {
			disable(ctx);
			ctx.ui.notify("已恢复内置 footer", "info");
		} else {
			enable(ctx);
			ctx.ui.notify("已启用自定义状态栏", "info");
		}
	}

	/** 交互式指标显隐选择器；保存返回 true，取消返回 false */
	async function runMetricsPicker(ctx: ExtensionContext): Promise<boolean> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(t().noTui, "warning");
			return false;
		}
		const orig = config.hiddenMetrics;
		const saved = await ctx.ui.custom<boolean>(
			(_tui, theme, _kb, done) =>
				new MetricsPickerComponent(
					theme,
					orig,
					(keys) => {
						config.hiddenMetrics = keys; // 即时预览
						if (userWants) activeTui?.requestRender();
					},
					done,
				),
		);
		if (!saved) {
			// 取消：回退未保存的预览改动
			config.hiddenMetrics = orig;
			if (userWants) activeTui?.requestRender();
			ctx.ui.notify(t().canceled, "info");
			return false;
		}
		const keys = config.hiddenMetrics;
		try {
			saveConfigPatch({ hiddenMetrics: keys });
			const T = t();
			ctx.ui.notify(
				keys.length === 0
					? T.savedAll
					: T.savedHidden(keys.join(config.language === "zh" ? "、" : ", ")),
				"info",
			);
		} catch (e) {
			ctx.ui.notify(t().saveFailed(e), "error");
			return false;
		}
		if (userWants) activeTui?.requestRender();
		return true;
	}

	/** 强制刷新订阅额度并显示详情（/statusbar quota 子命令） */
	async function refreshQuotaNow(ctx: ExtensionContext): Promise<void> {
		if (bindings.length === 0) {
			ctx.ui.notify("未发现可查询额度的订阅 provider", "warning");
			return;
		}
		await Promise.all(bindings.map((b) => refreshQuota(b, ctx, true)));
		const line = bindings
			.map((b) => `${b.source.id}: ${quotaStates.get(b.source.id)?.detail ?? "—"}`)
			.join("；")
			.replace(/\n/g, " ");
		ctx.ui.notify(line, "info");
	}

	pi.registerCommand("statusbar", {
		description:
			"状态栏设置：无参数打开交互菜单；子命令 on/off | layout [right|bottom|auto|split] | split [on|off] | border [auto|unicode|ascii] | fill [on|off] | metrics | quota | prices",
		handler: async (args, ctx) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const sub = parts[0];

			// 子命令快捷方式（脚本/RPC 友好，跳过交互菜单）
			if (sub === "on" || sub === "off") {
				if ((sub === "on") === userWants)
					ctx.ui.notify(
						sub === "on" ? "自定义状态栏已启用" : "已是内置 footer",
						"info",
					);
				else toggleStatusbar(ctx);
				return;
			}
			if (sub === "layout") {
				const a = parts[1];
				if (a && a !== "right" && a !== "bottom" && a !== "auto" && a !== "split") {
					ctx.ui.notify(
						`无效布局: ${a}（可选 right / bottom / auto / split）`,
						"warning",
					);
					return;
				}
				applyLayout(ctx, a as LayoutMode | undefined);
				return;
			}
			if (sub === "split") {
				const a = parts[1];
				if (a && a !== "on" && a !== "off") {
					ctx.ui.notify(`无效参数: ${a}（可选 on / off）`, "warning");
					return;
				}
				applySplit(ctx, a ? a === "on" : layoutMode !== "split");
				return;
			}
			if (sub === "border") {
				const a = parts[1];
				if (a && a !== "auto" && a !== "unicode" && a !== "ascii") {
					ctx.ui.notify(`无效参数: ${a}（可选 auto / unicode / ascii）`, "warning");
					return;
				}
				applyPanelBorder(ctx, a);
				return;
			}
			if (sub === "fill") {
				const a = parts[1];
				if (a && a !== "on" && a !== "off") {
					ctx.ui.notify(`无效参数: ${a}（可选 on / off）`, "warning");
					return;
				}
				applyPanelFill(ctx, a);
				return;
			}
			if (sub === "metrics") {
				await runMetricsPicker(ctx);
				return;
			}
			if (sub === "quota") {
				await refreshQuotaNow(ctx);
				return;
			}
			if (sub === "prices") {
				await refreshPricesNow(ctx);
				return;
			}
			if (sub) {
				ctx.ui.notify(
					`未知子命令: ${sub}。用法: /statusbar [on|off|layout [right|bottom|auto|split]|split [on|off]|border [auto|unicode|ascii]|fill [on|off]|metrics|quota|prices]，或无参数打开交互菜单`,
					"warning",
				);
				return;
			}

			// 无参数：非 TUI 环境保持旧行为（切换开关），TUI 打开交互式菜单
			if (ctx.mode !== "tui") {
				toggleStatusbar(ctx);
				return;
			}
			for (;;) {
				const action = await ctx.ui.custom<MenuAction | null>(
					(_tui, theme, _kb, done) =>
						new StatusbarMenuComponent(theme, done, (msg, type) =>
							ctx.ui.notify(msg, type),
						),
				);
				if (action == null) return;
				if (action === "metrics") {
					await runMetricsPicker(ctx);
					continue; // 回到菜单可继续操作
				}
				toggleStatusbar(ctx);
				return;
			}
		},
	});

	/** 刷新 models.dev 实时单价并显示当前模型单价来源（/statusbar prices 子命令） */
	async function refreshPricesNow(ctx: ExtensionContext): Promise<void> {
		await refreshPrices(ctx, true);
		const model = ctx.model;
		const r = ratesFor(ctx);
		const line = r
			? `${model?.id ?? "?"}: $${r.input}/$${r.output} 每百万（缓存读 $${r.cacheRead ?? 0}）来源 ${priceSource}`
			: `${model?.id ?? "?"}: 无可用单价（来源 ${priceSource}）`;
		ctx.ui.notify(line, "info");
	}

	pi.registerCommand("exit", {
		description: "退出 pi（/quit 的别名）",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	// 会话被替换/重载/退出前：卸掉右侧分栏并清空缓存引用。
	// 关键：右侧分栏挂在 pi 的布局树上，不随 reload 一起销毁；旧实例的 StatusPanel
	// 若留着，reload 后仍会渲染并读陈旧 ctx —— pi 的陈旧 ctx 守卫会抛错，
	// 而布局渲染异常 = uncaughtException，pi 直接退出。
	pi.on("session_shutdown", async () => {
		closeSplit();
		closePanel();
		currentCtx = null;
		activeFooterData = null;
		activeTui = null;
	});

	// 新会话/续接时按用户偏好恢复，并后台刷新一次实时单价
	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(); // 新会话重读配置，改配置文件无需重启
		layoutMode = config.layout;
		// 旧配置一次性迁移：split: true 已并进 layout，顺手把过时字段从文件里删掉
		if (legacySplitKey) {
			try {
				saveConfigPatch({ layout: config.layout, split: undefined });
				legacySplitKey = false;
			} catch {
				// 写失败不影响使用，下次会话再试
			}
		}
		// 右侧分栏需要 fullscreen：自动补齐 pi 的 TUI mode，用户只需配 layout 一处；写成功才提示（避免每次 /new 都刷）
		if (layoutMode === "split" && HAS_PI_TUI_HSTACK && !splitCapable(activeTui)) {
			const sync = syncPiTuiMode(true);
			if (sync.wrote) ctx.ui.notify(t().splitNeedsRestart, "info");
			else if (sync.failed) ctx.ui.notify(t().splitSetFailed, "warning");
		}
		if (userWants) enable(ctx);
		updateTitle(ctx);
		void refreshPrices(ctx, false);
	});
	// 切换模型后重绘：触发新 provider 额度段显示与首次拉取，并按新模型单价重算花费
	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
		cacheKey = "";
		updateTitle(ctx);
		if (userWants) activeTui?.requestRender();
	});

	// 会话名变更（/name、自动命名等）时刷新终端标题
	pi.on("session_info_changed", async (_event, ctx) => {
		updateTitle(ctx);
	});

	// 思考强度变化后重绘（footer 里的 模型·强度 段）
	pi.on("thinking_level_select", async (_event, ctx) => {
		currentCtx = ctx;
		if (userWants) activeTui?.requestRender();
	});
	// turn 结束后触发一次重绘刷新数值
	pi.on("turn_end", async (_event, ctx) => {
		currentCtx = ctx;
		updateTitle(ctx);
		if (userWants) activeTui?.requestRender();
	});

	// 首 token 耗时：请求发出前记起点，首个 assistant 消息开始时记终点
	pi.on("before_provider_request", async () => {
		reqStartTs = Date.now();
	});
	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		if (reqStartTs) {
			lastTtftMs = Date.now() - reqStartTs;
			reqStartTs = 0;
		}
		firstTokTs = Date.now();
		liveTokens = 0;
		liveTs = 0;
		if (userWants) activeTui?.requestRender();
	});
	// 实时吞吐估算：累计每个 delta 的估算 token 数（含思考与工具调用参数）
	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant" || !firstTokTs) return;
		const delta = (event.assistantMessageEvent as { delta?: unknown }).delta;
		if (typeof delta !== "string" || !delta) return;
		liveTokens += estimateTokens(delta);
		liveTs = Date.now();
	});
	// 输出吞吐：assistant 消息结束时用输出 token 数除以生成耗时（不含首 token 等待）
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const output = (event.message as AssistantMessage).usage?.output ?? 0;
		const secs = firstTokTs ? (Date.now() - firstTokTs) / 1000 : 0;
		firstTokTs = 0;
		liveTokens = 0;
		liveTs = 0;
		if (output > 0 && secs > 0) lastTps = output / secs;
		if (userWants) activeTui?.requestRender();
	});
}
