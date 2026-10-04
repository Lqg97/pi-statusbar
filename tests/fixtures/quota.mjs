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
];
