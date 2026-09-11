/**
 * 自定义状态栏（footer）扩展
 *
 * 用 ctx.ui.setFooter() 替换内置 footer，单行显示：
 *   git 分支 │ ↑输入 ↓输出 ⚡缓存·命中率 $花费 ⏱首token 输出tok/s（生成中按字符估算，带 ~ 前缀） │ ▰▰▰▱▱ 上下文% │ 订阅额度 │ 模型 │ 其他扩展状态
 *
 * 会话名不占 footer 宽度，只写入终端标题（会话名 · 目录名 · 模型）
 *
 * - 花费按实时单价计算：session 启动时从 models.dev/api.json 拉取各家官方单价（本地缓存 24h），
 *   失败时回落 models.json 的 cost 字段；/prices 强制刷新并显示当前模型单价来源
 * - 上下文占用 ≥75% 变黄，≥90% 变红
 * - 订阅额度自动发现（按 provider baseUrl 匹配，只显示当前模型所属 provider 的额度）：
 *     GLM Coding Plan（bigmodel.cn / z.ai）      → 5h/周 token 窗口百分比
 *     DeepSeek 余额（deepseek.com）              → 按量账户余额
 *     OpenRouter 额度（openrouter.ai）           → 剩余 credits
 *   带 TTL 缓存，失败静默；/quota 强制刷新并显示详情
 * - 窄终端先按 扩展状态 → 额度/token → 模型 的顺序收起，仍放不下则整段换行成多行（分支与上下文永不丢弃）
 * - 布局可配置（layout）：bottom 底部单行 / right 右侧悬浮竖卡面板 / auto（默认）
 *   auto 按终端宽度自动选择：≥120 列用右侧面板，否则底部单行，resize 实时切换；
 *   右侧面板为非捕获浮层（不抢键盘焦点），宽度由 rightWidth 配置（默认 32 列）；
 *   注意：面板浮在聊天内容之上，会遮住右缘内容（pi 扩展 API 不支持真布局分栏）；
 *   /statusbar-layout [right|bottom|auto] 运行时切换，不带参数循环
 * - /statusbar 切换回内置 footer，新会话默认恢复自定义样式
 * - 用户配置 ~/.pi/agent/statusbar.json（环境变量 PI_STATUSBAR_CONFIG 可覆盖路径）：
 *     priceMap         本地模型 → models.dev 单价映射，key 为 "provider:model" 或裸 "model"
 *     hideExtStatuses  按文本包含隐藏的其他扩展状态（默认 ["LSP Inactive"]）
 *     layout           "bottom" | "right" | "auto"（默认 "auto"）
 *     rightWidth       右侧面板宽度，默认 32，范围 [20, 60]
 *     hiddenMetrics    隐藏的指标 key 数组，可选：branch/ctx/model/effort/usage/ttft/speed/quota/ext；
 *                      也可用 /statusbar-metrics 交互式配置（会写回此字段）
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
import {
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

/** 额度源渲染出的短文本与最大占用百分比（决定颜色） */
interface QuotaSeg {
	text: string;
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

/** 状态栏布局：bottom 底部单行 / right 右侧悬浮面板 / auto 按终端宽度自动选择 */
type LayoutMode = "bottom" | "right" | "auto";

interface StatusbarConfig {
	/** 本地模型 → models.dev 单价映射：key 为本地 "provider:model" 或裸 "model"，value 为 [models.dev provider, 模型 id] */
	priceMap: Record<string, [string, string]>;
	/** 需要隐藏的其他扩展状态（文本包含即隐藏）。
	 *  默认隐藏 pi-lens 的 "LSP Inactive"（未编辑代码时的被动状态），保留 LSP Active / Failed 等有信息量的状态。
	 */
	hideExtStatuses: string[];
	/** 布局模式，默认 auto：终端 ≥120 列时右侧面板，否则底部单行 */
	layout: LayoutMode;
	/** 右侧面板宽度（列），默认 32，读取时 clamp 到 [20, 60] */
	rightWidth: number;
	/** 隐藏的指标 key 列表（默认全部显示），/statusbar-metrics 交互式配置 */
	hiddenMetrics: MetricKey[];
}

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

const METRICS: { key: MetricKey; name: string }[] = [
	{ key: "branch", name: "分支 / 目录" },
	{ key: "ctx", name: "上下文占用" },
	{ key: "model", name: "模型名" },
	{ key: "effort", name: "思考强度 effort（仅右侧面板分行显示）" },
	{ key: "usage", name: "token 用量 / 缓存 / 花费" },
	{ key: "ttft", name: "首 token 耗时 TTFT" },
	{ key: "speed", name: "输出吞吐 tok/s" },
	{ key: "quota", name: "订阅额度" },
	{ key: "ext", name: "其他扩展状态" },
];

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
/** auto 模式阈值：终端列数 ≥ 该值时使用右侧面板 */
const AUTO_MIN_WIDTH = 120;

function toLayoutMode(v: unknown): LayoutMode {
	return v === "bottom" || v === "right" || v === "auto" ? v : DEFAULT_LAYOUT;
}

function toRightWidth(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_RIGHT_WIDTH;
	return Math.min(60, Math.max(20, Math.round(v)));
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
				if (!inStr && c === "/" && line[i + 1] === "/")
					return line.slice(0, i);
			}
			return line;
		})
		.join("\n");
}

/** 读取配置（支持 jsonc 行注释）；文件缺失或损坏时回落默认值（新会话时重读，改完配置开新会话即生效） */
function loadConfig(): StatusbarConfig {
	try {
		const raw = JSON.parse(stripJsonComments(readFileSync(CONFIG_FILE, "utf8")));
		return {
			priceMap: raw?.priceMap ?? {},
			hideExtStatuses: Array.isArray(raw?.hideExtStatuses)
				? raw.hideExtStatuses
				: [...DEFAULT_HIDE_EXT_STATUSES],
			layout: toLayoutMode(raw?.layout),
			rightWidth: toRightWidth(raw?.rightWidth),
			hiddenMetrics: toMetricKeys(raw?.hiddenMetrics),
		};
	} catch {
		return {
			priceMap: {},
			hideExtStatuses: [...DEFAULT_HIDE_EXT_STATUSES],
			layout: DEFAULT_LAYOUT,
			rightWidth: DEFAULT_RIGHT_WIDTH,
			hiddenMetrics: [],
		};
	}
}

/** 保存 hiddenMetrics 到配置文件（保留其他字段；会去除 jsonc 注释） */
function saveHiddenMetrics(keys: MetricKey[]): void {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(stripJsonComments(readFileSync(CONFIG_FILE, "utf8")));
	} catch {
		// 文件缺失或损坏：基于当前生效配置重建
		raw = {
			priceMap: config.priceMap,
			hideExtStatuses: config.hideExtStatuses,
			layout: config.layout,
			rightWidth: config.rightWidth,
		};
	}
	raw.hiddenMetrics = keys;
	writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, "\t") + "\n");
	config.hiddenMetrics = keys;
}

let config = loadConfig();

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
			let maxPercent: number | undefined;

			// 周配额
			const weekLimit = parseFloat(usage.limit);
			if (weekLimit > 0) {
				const pct = (parseFloat(usage.used) / weekLimit) * 100;
				parts.push(`周${Math.round(pct)}%`);
				maxPercent = pct;
			}
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
				parts.push(`${label}${Math.round(pct)}%`);
				maxPercent = Math.max(maxPercent ?? 0, pct);
			}
			if (parts.length === 0) return { seg: null, detail: "响应中无用量数据" };

			const level = json?.user?.membership?.level;
			let detail = `Kimi${level ? `（${level}）` : ""}`;
			if (weekLimit > 0)
				detail += `\n  周配额: ${usage.used}/${usage.limit}${usage.resetTime ? `，重置于 ${usage.resetTime}` : ""}`;
			for (const lim of json?.limits ?? []) {
				const d = lim?.detail ?? {};
				if (d.limit) detail += `\n  窗口: 剩余 ${d.remaining}/${d.limit}`;
			}
			if (json?.limited) detail += "\n  ⚠ 当前限流中";
			return { seg: { text: `Kimi ${parts.join("·")}`, maxPercent }, detail };
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

			const parts = windows.map(
				(l) =>
					`${glmWindowLabel(l.unit ?? 0, l.number ?? 1)} ${Math.round(l.percentage)}%`,
			);
			const maxPercent = Math.max(...windows.map((l) => l.percentage));

			let detail = `GLM${json?.data?.level ? `（${json.data.level}）` : ""}`;
			for (const l of windows)
				detail += `\n  token ${glmWindowLabel(l.unit ?? 0, l.number ?? 1)} 窗口: ${l.percentage}%`;
			for (const l of limits) {
				if (l.type === "TIME_LIMIT")
					detail += `\n  MCP 调用: ${l.currentValue}/${l.usage}`;
			}
			return { seg: { text: `GLM ${parts.join("·")}`, maxPercent }, detail };
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
	// 当前布局模式：session_start 重读配置时重置，/statusbar-layout 运行时切换
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
			segs.push({ label: "Branch", text: theme.fg("accent", branch), pri: 0, key: "branch" });
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
				segs.push({ label: "Model", text: theme.fg("muted", label), pri: 1, key: "model" });
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
			segs.push({ label: "In", text: theme.fg("muted", inText), pri: 2, key: "usage" });
			segs.push({ label: "Out", text: theme.fg("muted", outText), pri: 2, key: "usage" });
			if (cacheText)
				segs.push({ label: "Cache", text: theme.fg("muted", cacheText), pri: 2, key: "usage" });
			segs.push({ label: "Cost", text: theme.fg("muted", costText), pri: 2, key: "usage" });
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
				const p = state.seg.maxPercent;
				const color =
					p == null ? "muted" : p >= 85 ? "error" : p >= 60 ? "warning" : "success";
				segs.push({
					label: "Quota",
					text: theme.fg(color, state.seg.text),
					pri: 2,
					key: "quota",
				});
			}
		}

		// 保留其他扩展通过 setStatus 输出的状态，命中隐藏规则的除外
		for (const s of footerData.getExtensionStatuses().values()) {
			if (!s) continue;
			if (config.hideExtStatuses.some((h) => s.includes(h))) continue;
			segs.push({ label: "", text: s, pri: 3, key: "ext" });
		}
		// 应用指标显隐配置（/statusbar-metrics）
		return segs.filter(
			(s) => !s.key || !config.hiddenMetrics.includes(s.key),
		);
	}

	/** 右侧悬浮信息面板：非捕获浮层，纯展示，竖排 label/value 行 + 边框 */
	const PANEL_LABEL_W = 7;
	class StatusPanel implements Component {
		constructor(private theme: Theme) {}
		invalidate(): void {}
		render(width: number): string[] {
			const ctx = currentCtx;
			const fd = activeFooterData;
			if (!ctx || !fd) return [];
			const th = this.theme;
			const innerW = Math.max(PANEL_LABEL_W + 4, width - 2);
			const border = (l: string, r: string) =>
				th.fg("dim", l + "─".repeat(innerW) + r);
			const lines: string[] = [border("┌", "┐")];
			const row = (content: string) => {
				const padded =
					content + " ".repeat(Math.max(0, innerW - visibleWidth(content)));
				return th.fg("dim", "│") + padded + th.fg("dim", "│");
			};
			for (const s of buildSegments(ctx, th, fd, "panel")) {
				if (s.label) {
					const valueW = Math.max(1, innerW - 2 - PANEL_LABEL_W - 1);
					const valueLines = wrapTextWithAnsi(s.text, valueW);
					valueLines.forEach((line, i) => {
						const labelCol =
							i === 0 ? th.fg("dim", s.label.padEnd(PANEL_LABEL_W)) : " ".repeat(PANEL_LABEL_W);
						lines.push(row(" " + labelCol + " " + line));
					});
				} else {
					for (const line of wrapTextWithAnsi(s.text, innerW - 2)) {
						lines.push(row(" " + line));
					}
				}
			}
			lines.push(border("└", "┘"));
			return lines;
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
								margin: { right: 1 },
								nonCapturing: true,
								visible: (w: number) => userWants && panelAlive && panelActive(w),
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
					// 宽终端（或强制 right）时由右侧面板接管，底部让位；面板未就绪时仍渲染底部兜底
					if (panelActive(width)) {
						ensurePanel(ctx);
						if (panelAlive || panelPending) return [];
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
					if (rowSegs.length)
						rows.push(truncateToWidth(join(rowSegs), width));
					return rows;
				},
			};
		});
	}

	function disable(ctx: ExtensionContext): void {
		userWants = false;
		closePanel();
		if (!ctx.hasUI) return;
		ctx.ui.setFooter(undefined);
	}

	// ---------- 命令与事件 ----------

	pi.registerCommand("statusbar", {
		description: "切换自定义状态栏 / 内置 footer",
		handler: async (_args, ctx) => {
			if (userWants) {
				disable(ctx);
				ctx.ui.notify("已恢复内置 footer", "info");
			} else {
				enable(ctx);
				ctx.ui.notify("已启用自定义状态栏", "info");
			}
		},
	});

	pi.registerCommand("statusbar-layout", {
		description: "切换状态栏布局：right / bottom / auto（不带参数循环切换）",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a) {
				if (a !== "right" && a !== "bottom" && a !== "auto") {
					ctx.ui.notify(`无效布局: ${a}（可选 right / bottom / auto）`, "warning");
					return;
				}
				layoutMode = a;
			} else {
				// 循环切换：bottom → right → auto → bottom
				const NEXT: Record<LayoutMode, LayoutMode> = {
					bottom: "right",
					right: "auto",
					auto: "bottom",
				};
				layoutMode = NEXT[layoutMode];
			}
			// 切到 bottom 时面板由 visible 回调自动隐藏；切到 right/auto 时若面板未创建由 footer 下一帧触发
			if (userWants) activeTui?.requestRender();
			ctx.ui.notify(
				layoutMode === "auto"
					? `状态栏布局: auto（终端 ≥${AUTO_MIN_WIDTH} 列时右侧面板，否则底部单行）`
					: `状态栏布局: ${layoutMode}`,
				"info",
			);
		},
	});

	pi.registerCommand("statusbar-metrics", {
		description: "交互式配置状态栏指标显隐（选择切换 ☑/☐，✔ 完成保存）",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("当前模式不支持交互式配置，请直接改配置文件的 hiddenMetrics", "warning");
				return;
			}
			const orig = config.hiddenMetrics;
			const hidden = new Set<MetricKey>(orig);
			const DONE = "✔ 完成（保存到配置文件）";
			for (;;) {
				const options = [
					...METRICS.map((m) => `${hidden.has(m.key) ? "☐" : "☑"} ${m.name}`),
					DONE,
				];
				const choice = await ctx.ui.select(
					"状态栏指标配置（选择切换 ☑显示/☐隐藏，Esc 取消不保存）",
					options,
				);
				if (choice == null) {
					// 取消：回退未保存的预览改动
					config.hiddenMetrics = orig;
					if (userWants) activeTui?.requestRender();
					ctx.ui.notify("已取消，配置未保存", "info");
					return;
				}
				if (choice === DONE) break;
				const m = METRICS.find((_, i) => options[i] === choice);
				if (!m) continue;
				if (hidden.has(m.key)) hidden.delete(m.key);
				else hidden.add(m.key);
				// 即时预览（未保存，Esc 可回退）
				config.hiddenMetrics = [...hidden];
				if (userWants) activeTui?.requestRender();
			}
			const keys = METRICS.filter((m) => hidden.has(m.key)).map((m) => m.key);
			try {
				saveHiddenMetrics(keys);
				ctx.ui.notify(
					keys.length === 0
						? "已保存：显示全部指标"
						: `已保存：隐藏 ${keys.join("、")}（注意：配置文件中的注释会被去除）`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(`写入配置文件失败: ${e}`, "error");
			}
			if (userWants) activeTui?.requestRender();
		},
	});

	pi.registerCommand("quota", {
		description: "强制刷新订阅额度并显示详情",
		handler: async (_args, ctx) => {
			if (bindings.length === 0) {
				ctx.ui.notify("未发现可查询额度的订阅 provider", "warning");
				return;
			}
			await Promise.all(bindings.map((b) => refreshQuota(b, ctx, true)));
			const line = bindings
				.map(
					(b) => `${b.source.id}: ${quotaStates.get(b.source.id)?.detail ?? "—"}`,
				)
				.join("；")
				.replace(/\n/g, " ");
			ctx.ui.notify(line, "info");
		},
	});

	pi.registerCommand("prices", {
		description: "刷新 models.dev 实时单价并显示当前模型单价来源",
		handler: async (_args, ctx) => {
			await refreshPrices(ctx, true);
			const model = ctx.model;
			const r = ratesFor(ctx);
			const line = r
				? `${model?.id ?? "?"}: $${r.input}/$${r.output} 每百万（缓存读 $${r.cacheRead ?? 0}）来源 ${priceSource}`
				: `${model?.id ?? "?"}: 无可用单价（来源 ${priceSource}）`;
			ctx.ui.notify(line, "info");
		},
	});

	// 新会话/续接时按用户偏好恢复，并后台刷新一次实时单价
	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(); // 新会话重读配置，改配置文件无需重启
		layoutMode = config.layout;
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
