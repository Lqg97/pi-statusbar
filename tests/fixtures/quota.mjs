// Synthetic API responses; no credentials or live account data.
export const quotaCases = [
	{
		source: "Kimi", baseUrl: "https://api.kimi.com/coding/v1", path: "/coding/v1/usages",
		response: {
			limits: [{ window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "100", remaining: "75" } }],
			usage: { limit: "200", used: "100" },
			usages: { limit_month_total: { used_ratio: 0.1 }, limit_month_code: { used_ratio: 0.2 } },
		},
		footer: "Kimi 5h 25%·周 50%·月 10%·月编程 20%", rows: ["5h 25%", "周 50%", "月 10%", "月编程 20%"],
	},
	{
		source: "GLM", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", path: "/api/monitor/usage/quota/limit",
		response: { data: { limits: [
			{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42 },
			{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 60 },
		] } },
		footer: "GLM 5h 42%·1周 60%", rows: ["5h 42%", "1周 60%"],
	},
	{
		source: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", path: "/user/balance",
		response: { balance_infos: [{ currency: "CNY", total_balance: "12.34", granted_balance: "2" }] },
		footer: "DS ¥12.3", rows: ["DS ¥12.3"],
	},
	{
		source: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", path: "/api/v1/credits",
		response: { data: { total_credits: 100, total_usage: 25 } },
		footer: "OR $75.0", rows: ["OR $75.0"],
	},
	{
		source: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", path: "/zen/go/v1/usage",
		response: { usage: { rolling: { percent: 25 }, weekly: { percent: 50 }, monthly: { percent: 75 } } },
		footer: "OC 5h 25%·周 50%·月 75%", rows: ["5h 25%", "周 50%", "月 75%"],
	},
	{
		source: "MiniMax", baseUrl: "https://api.minimaxi.com/v1", path: "/v1/token_plan/remains",
		response: { base_resp: { status_code: 0 }, model_remains: [{
			model_name: "general", current_interval_remaining_percent: 75,
			current_weekly_status: 1, current_weekly_remaining_percent: 50,
		}] },
		footer: "MM 5h 25%·周 50%", rows: ["5h 25%", "周 50%"],
	},
	{
		source: "Moonshot", baseUrl: "https://api.moonshot.cn/v1", path: "/v1/users/me/balance",
		response: { data: { available_balance: "12.34", voucher_balance: "2" } },
		footer: "MS ¥12.3", rows: ["MS ¥12.3"],
	},
	{
		source: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", path: "/v1/user/info",
		response: { data: { totalBalance: "12.34", balance: "2" } },
		footer: "SF ¥12.3", rows: ["SF ¥12.3"],
	},
	{
		source: "StepFun", baseUrl: "https://api.stepfun.com/v1", path: "/v1/accounts",
		response: { balance: "12.34", total_voucher_balance: "2" },
		footer: "Step ¥12.3", rows: ["Step ¥12.3"],
	},
	{
		source: "Novita", baseUrl: "https://api.novita.ai/v3/openai", path: "/v3/user/balance",
		response: { availableBalance: "123400" },
		footer: "NV $12.3", rows: ["NV $12.3"],
	},
	{
		source: "CommandCode", baseUrl: "https://api.commandcode.ai/v1", path: "/alpha/whoami",
		responses: {
			"/alpha/whoami": { org: { id: "test-org", login: "test" } },
			"/alpha/billing/credits": {
				windowLimits: { fiveHour: { used: 3, cap: 12 }, weekly: { used: 15, cap: 30 } },
				credits: { monthlyCredits: 10, purchasedCredits: 2, freeCredits: 1 },
			},
			"/alpha/billing/subscriptions": { data: { planId: "pro", status: "active" } },
			"/alpha/usage/summary": { totalCost: 5, totalCount: 7 },
		},
		footer: "CC 5h 25%·周 50%·余$13.0", rows: ["5h 25%", "周 50%", "余$13.0"],
	},
	{
		source: "Codex", baseUrl: "https://chatgpt.com/backend-api", path: "/backend-api/wham/usage",
		response: { rate_limit: {
			primary_window: { used_percent: 25, limit_window_seconds: 18000 },
			secondary_window: { used_percent: 50, limit_window_seconds: 604800 },
		} },
		footer: "Codex 5h 25%·周 50%", rows: ["5h 25%", "周 50%"],
	},
	{
		source: "Copilot", baseUrl: "https://api.individual.githubcopilot.com", path: "/copilot_internal/user",
		quotaOrigin: "https://api.github.com",
		response: { quota_snapshots: {
			premium_interactions: { entitlement: 300, remaining: 225, percent_remaining: 75 },
			chat: { unlimited: true }, completions: { unlimited: true },
		} },
		footer: "Copilot 高级 25%·聊天 ∞·补全 ∞", rows: ["高级 25%", "聊天 ∞", "补全 ∞"],
	},
	{
		source: "xAI", baseUrl: "https://api.x.ai/v1", path: "/v1/user",
		quotaOrigin: "https://cli-chat-proxy.grok.com",
		responses: {
			"/v1/user": { userId: "transient-test-user" },
			"/v1/billing": { config: { creditUsagePercent: 25, currentPeriod: { type: "WEEKLY" },
				onDemandCap: { val: 10000 }, onDemandUsed: { val: 5000 }, prepaidBalance: { val: 1234 } } },
		},
		footer: "xAI 周 25%·按量 50%·余$12.3", rows: ["周 25%", "按量 50%", "余$12.3"],
	},
	{
		source: "Radius", baseUrl: "https://radius.pi.dev/v1", path: "/v1/billing",
		response: { ok: true, currency: "USD", balance: { credit_balance: 20, reserved: 7.66, available: 12.34 }, current_period: { actual_charged: 5 } },
		footer: "Radius $12.3", rows: ["Radius $12.3"],
	},
	{
		// 本机 magpie 网关：先 /api/hello 认身份，再读额度；route 说本会话这轮走的是 kimi-code-cn/k3，
		// 所以 footer 跟 route 走（而不是 magpie 全局 last 的 opencode-go）
		source: "Magpie", baseUrl: "http://127.0.0.1:3425/v1", path: "/api/hello",
		responses: {
			"/api/hello": { name: "magpie", version: "0.1.1203" },
			"/v1/magpie/route": { route: { asked: "kimi-code-cn/k3", model: "kimi-code-cn/k3" }, seq: 7, session: "test" },
			"/v1/magpie/quotas": { object: "list", data: [
				{ provider: "opencode-go", name: "OpenCode Go", kind: "plan", last: true,
					lastServedAt: "2026-10-12T06:53:38Z",
					windows: [{ name: "5 hours", used: 6, remaining: 94 }, { name: "7 days", used: 2, remaining: 98 }, { name: "Month", used: 15, remaining: 85 }] },
				{ provider: "kimi-code-cn", name: "Kimi For Coding", kind: "plan",
					lastServedAt: "2026-10-12T03:03:03Z",
					windows: [{ name: "5 hours", used: 0, remaining: 100 }, { name: "7 days", used: 16, remaining: 84 }] },
				{ provider: "claude", name: "Claude Code", kind: "subscription", plan: "pro", user: "ada@example.com",
					readAt: "2026-10-12T14:32:30+08:00",
					windows: [{ name: "5 hours", used: 42, remaining: 58 }, { name: "7 days", remaining: 41 }] },
				{ provider: "deepseek", name: "deepseek", kind: "balance", balance: "¥116.18", windows: [] },
			] },
		},
		footer: "Kimi For Coding 5h 0%·周 16%", rows: ["5h 0%", "周 16%"],
	},
];
