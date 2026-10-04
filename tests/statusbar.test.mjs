import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as tui from "@earendil-works/pi-tui";
import { quotaCases } from "./fixtures/quota.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const outputDir = mkdtempSync(join(tmpdir(), "pi-statusbar-test-"));
let compiled;
try {
	// TypeScript 7 no longer exposes the old transpileModule API.
	execFileSync(process.execPath, [
		join(dirname(require.resolve("typescript/package.json")), "bin/tsc"),
		"--project", join(root, "tsconfig.json"),
		"--noEmit", "false", "--module", "NodeNext", "--moduleResolution", "NodeNext",
		"--rootDir", join(root, "extensions"), "--outDir", outputDir,
	], { cwd: root, timeout: 30_000, stdio: "inherit" });
	compiled = readFileSync(join(outputDir, "statusbar.js"), "utf8");
} finally {
	rmSync(outputDir, { recursive: true, force: true });
}

function load(language = "zh", options = {}) {
	const commands = new Map();
	const reads = [];
	const exports = {};
	// Expose private quota helpers only in the compiled test sandbox.
	const marker = "const quotaStates = new Map();";
	assert.equal(compiled.split(marker).length, 2);
	const instrumented = compiled.replace(marker, `${marker}
		pi.testQuota = { bindings, quotaStates, resolveQuotaBindings, refreshQuota, buildSegments, enable,
			createPanel: (theme) => new StatusPanel(theme) };
	`);
	runInNewContext(`${instrumented}\nexports.quotaSources = QUOTA_SOURCES;`, {
		exports,
		process: { env: {} },
		require(id) {
			if (id === "@earendil-works/pi-tui") return tui;
			if (id === "@earendil-works/pi-coding-agent") return {
				readStoredCredential: (provider) => options.credentials?.[provider],
			};
			if (id === "node:fs") return {
				readFileSync(path) {
					reads.push(path);
					// Legacy dashboard settings must not affect the remaining UI.
					return JSON.stringify({ language, layout: "bottom", subscriptions: [{ name: "legacy" }], autoDiscoverSubs: false, ...options.config });
				},
				writeFileSync() {},
			};
			return require(id);
		},
		fetch: options.fetch ?? (async () => ({
			ok: true,
			json: async () => ({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42 }] } }),
		})),
		AbortSignal,
		URL,
		Buffer,
	});
	const pi = { registerCommand: (name, command) => commands.set(name, command), on() {}, getThinkingLevel: () => "off" };
	exports.default(pi);
	return { commands, reads, quotaSources: exports.quotaSources, quota: pi.testQuota };
}

for (const alias of ["subs", "sub", "subscriptions"]) {
	test(`removed command ${alias} is rejected without opening UI or reading sessions`, async () => {
		const { commands, reads } = load();
		const notices = [];
		const command = commands.get("statusbar");
		assert.doesNotMatch(command.description, /\bsubs\b/);
		await command.handler(alias, {
			mode: "tui",
			ui: { notify: (...args) => notices.push(args), custom: () => assert.fail("unexpected panel") },
		});
		assert.match(notices[0][0], new RegExp(`未知子命令: ${alias}。`));
		assert.equal(notices[0][1], "warning");
		assert.equal(reads.length, 1); // Only the statusbar config is read.
	});
}

for (const language of ["zh", "en"]) {
	test(`${language} menu has seven rows and last row still disables the footer`, async () => {
		const { commands } = load(language);
		let resets = 0;
		await commands.get("statusbar").handler("", {
			mode: "tui",
			hasUI: true,
			ui: {
				notify() {},
				setFooter(value) { assert.equal(value, undefined); resets++; },
				custom(factory) {
					let result;
					const component = factory({}, { fg: (_color, text) => text }, {}, (value) => { result = value; });
					const rows = component.render(120).filter((line) => /^  [ ❯] /.test(line));
					assert.equal(rows.length, 7);
					assert.doesNotMatch(rows.join("\n"), /订阅统计|Subscriptions/);
					component.handleInput("\x1b[A"); // Wrap from the first row to the last.
					assert.match(component.render(120).join("\n"), language === "zh" ? /❯ 停用自定义状态栏/ : /❯ Disable custom statusbar/);
					component.handleInput("\r");
					assert.equal(result, "toggle");
					return Promise.resolve(result);
				},
			},
		});
		assert.equal(resets, 1);
	});
}

test("live quota source still renders window percentages", async () => {
	const { quotaSources } = load();
	const glm = quotaSources.find((source) => source.id === "GLM");
	const { seg, detail } = await glm.fetch("https://example.invalid", "test-key");
	assert.equal(seg.text, "GLM 5h 42%");
	assert.equal(seg.rows[0].text, "5h 42%");
	assert.equal(seg.rows[0].percent, 42);
	assert.equal(seg.maxPercent, 42);
	assert.match(detail, /token 5h 窗口: 42%/);
});

const theme = { fg: (_color, text) => text };
const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };

function quotaContext(models, provider = models[0]?.provider, apiKey = "test-key") {
	return {
		cwd: "/test", hasUI: true, model: { id: "test-model", provider },
		modelRegistry: { getAvailable: () => models, getApiKeyForProvider: async () => apiKey },
		sessionManager: { getBranch: () => [], getSessionId: () => "test" },
		getContextUsage: () => undefined,
		ui: { setFooter(factory) {
			this.footer = factory({ terminal: { columns: 300 }, requestRender() {} }, theme, footerData);
		} },
	};
}

for (const scenario of quotaCases) {
	test(`${scenario.source}: discovery → fetch → footer and 32-column panel`, async () => {
		const requests = [];
		const { quota } = load("zh", {
			credentials: scenario.source === "xAI" ? { "custom-xAI": { type: "oauth" } } : undefined,
			fetch: async (url, init) => {
			const parsed = new URL(url);
			const json = scenario.responses?.[parsed.pathname] ?? scenario.response;
			assert.ok(json, `unexpected quota endpoint: ${parsed.pathname}`);
			assert.equal(parsed.origin, scenario.quotaOrigin ?? new URL(scenario.baseUrl).origin);
			assert.equal(init.headers.Authorization, scenario.source === "GLM" ? "test-key" : "Bearer test-key");
			if (["Codex", "Copilot", "Radius", "xAI"].includes(scenario.source)) assert.equal(init.redirect, "error");
			if (scenario.source === "xAI") {
				assert.equal(init.headers["X-XAI-Token-Auth"], "xai-grok-cli");
				assert.equal(init.headers["x-grok-client-identifier"], "pi-statusbar");
				assert.equal(init.headers["x-userid"], parsed.pathname === "/v1/user" ? undefined : "transient-test-user");
			}
			requests.push(parsed);
			return { ok: true, json: async () => json };
		} });
		const provider = `custom-${scenario.source}`;
		const ctx = quotaContext([{ provider, baseUrl: scenario.baseUrl }]);
		quota.enable(ctx);
		assert.equal(quota.bindings.length, 1);
		assert.equal(quota.bindings[0].source.id, scenario.source);
		await quota.refreshQuota(quota.bindings[0], ctx, true);
		assert.equal(requests[0].pathname, scenario.path);
		if (scenario.source === "CommandCode") {
			assert.equal(requests.length, 4);
			for (const request of requests.slice(1)) assert.equal(request.searchParams.get("orgId"), "test-org");
		}
		const footer = quota.buildSegments(ctx, theme, footerData, "footer").filter((s) => s.key === "quota");
		assert.equal(footer.length, 1);
		assert.equal(footer[0].text, scenario.footer);
		assert.ok(ctx.ui.footer.render(300).join("\n").includes(scenario.footer));
		const panel = quota.buildSegments(ctx, theme, footerData, "panel").filter((s) => s.key === "quota");
		assert.deepEqual(Array.from(panel, (s) => s.text), scenario.rows);
		const lines = quota.createPanel(theme).render(32);
		assert.ok(lines.length > 0);
		for (const row of scenario.rows) assert.ok(lines.join("\n").includes(row), `missing panel row: ${row}`);
		for (const line of lines) assert.ok(tui.visibleWidth(line) <= 32);
	});
}

test("every built-in quota source has a display fixture", () => {
	const { quotaSources } = load();
	assert.deepEqual(Array.from(quotaSources, (s) => s.id).sort(), quotaCases.map((s) => s.source).sort());
});

test("quota caches are isolated even when two providers share the same source", async () => {
	const { quota } = load("zh", { fetch: async (_url, init) => ({ ok: true, json: async () => ({
		data: { total_credits: 100, total_usage: init.headers.Authorization.endsWith("first") ? 10 : 80 },
	}) }) });
	const ctx = quotaContext(["first", "second"].map((provider) => ({ provider, baseUrl: "https://openrouter.ai/api/v1" })));
	ctx.modelRegistry.getApiKeyForProvider = async (provider) => provider;
	quota.resolveQuotaBindings(ctx);
	for (const binding of quota.bindings) await quota.refreshQuota(binding, ctx, true);
	for (const [provider, expected] of [["first", "OR $90.0"], ["second", "OR $20.0"]]) {
		ctx.model.provider = provider;
		const segments = quota.buildSegments(ctx, theme, footerData, "footer").filter((s) => s.key === "quota");
		assert.equal(segments.length, 1);
		assert.equal(segments[0].text, expected);
	}
});

test("unsupported providers and OpenCode Zen do not masquerade as supported quota sources", () => {
	const { quota } = load();
	const bases = ["https://api.openai.com/v1", "https://api.x.ai.evil.example/v1",
		"https://dashscope.aliyuncs.com/compatible-mode/v1", "https://api.lkeap.cloud.tencent.com/plan/v3",
		"https://radius.example/v1", "https://relay.example/v1", "https://opencode.ai/zen/v1"];
	quota.resolveQuotaBindings(quotaContext(bases.map((baseUrl, i) => ({ provider: `unsupported-${i}`, baseUrl }))));
	assert.equal(quota.bindings.length, 0);
});

test("missing API key stays out of the UI and is explained by /statusbar quota", async () => {
	let requests = 0;
	const { quota, commands } = load("zh", { fetch: async () => { requests++; throw new Error("unexpected fetch"); } });
	const ctx = quotaContext([{ provider: "glm", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" }], "glm", undefined);
	ctx.modelRegistry.getApiKeyForProvider = async () => undefined;
	quota.resolveQuotaBindings(ctx);
	await quota.refreshQuota(quota.bindings[0], ctx, true);
	assert.equal(requests, 0);
	assert.equal(quota.buildSegments(ctx, theme, footerData, "footer").filter((s) => s.key === "quota").length, 0);
	let notice;
	ctx.ui.notify = (text) => { notice = text; };
	await commands.get("statusbar").handler("quota", ctx);
	assert.match(notice, /provider 未配置 API key/);
});

test("OpenCode Go without an active subscription returns no quota rather than fake zero usage", async () => {
	const { quotaSources } = load("zh", { fetch: async () => ({ ok: false, status: 403 }) });
	const result = await quotaSources.find((s) => s.id === "OpenCode Go").fetch("https://opencode.ai", "test-key");
	assert.equal(result.seg, null);
	assert.match(result.detail, /未订阅 OpenCode Go/);
});

test("Codex account header comes from the resolved OAuth JWT and zero usage is visible", async () => {
	const jwt = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
	const { quotaSources } = load("zh", { fetch: async (url, init) => {
		assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
		assert.equal(init.headers.Authorization, `Bearer ${jwt}`);
		assert.equal(init.headers["ChatGPT-Account-Id"], "test-account");
		return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 3600 } } }) };
	} });
	const result = await quotaSources.find((s) => s.id === "Codex").fetch("https://untrusted.example", jwt);
	assert.match(result.seg.text, /^Codex 周 0%\(/);
	assert.doesNotMatch(result.detail, /test-account|test\./);
});

test("Copilot quota uses the stored GitHub OAuth token, never its inference proxy token", async () => {
	let requests = 0;
	const { quota } = load("zh", {
		credentials: { "github-copilot": { type: "oauth", refresh: "github-access-token" } },
		fetch: async (_url, init) => {
			requests++;
			assert.equal(init.headers.Authorization, "Bearer github-access-token");
			return { ok: true, json: async () => ({ quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 150 } } }) };
		},
	});
	const ctx = quotaContext([{ provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com" }], "github-copilot", "tid=secret;proxy-ep=proxy.individual.githubcopilot.com");
	quota.resolveQuotaBindings(ctx);
	await quota.refreshQuota(quota.bindings[0], ctx, true);
	assert.equal(requests, 1);
	assert.equal(quota.quotaStates.get("github-copilot").seg.text, "Copilot 高级 50%");
});

for (const credential of [undefined, { type: "oauth", refresh: "enterprise-token", enterpriseUrl: "company.ghe.com" }]) {
	test(`Copilot missing/enterprise GitHub credentials do not leak a token to the public endpoint: ${credential ? "enterprise" : "missing"}`, async () => {
		const { quota } = load("zh", {
			credentials: credential ? { "github-copilot": credential } : {},
			fetch: async () => assert.fail("quota fetch must not be called"),
		});
		const ctx = quotaContext([{ provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com" }], "github-copilot", "proxy-ep=proxy.individual.githubcopilot.com;");
		quota.resolveQuotaBindings(ctx);
		await quota.refreshQuota(quota.bindings[0], ctx, true);
		assert.equal(quota.quotaStates.get("github-copilot").seg, null);
		assert.doesNotMatch(quota.quotaStates.get("github-copilot").detail, /enterprise-token|proxy-ep=/);
	});
}

for (const sourceId of ["Codex", "Copilot", "Radius"]) {
	test(`${sourceId} unknown responses and forbidden billing requests do not produce fake quota`, async () => {
		const { quotaSources } = load("zh", { fetch: async () => ({ ok: true, json: async () => ({}) }) });
		assert.equal((await quotaSources.find((s) => s.id === sourceId).fetch("https://example.invalid", "test-key")).seg, null);
		const forbidden = load("zh", { fetch: async () => ({ ok: false, status: 403, json: async () => ({ token: "must-not-appear" }) }) });
		await assert.rejects(forbidden.quotaSources.find((s) => s.id === sourceId).fetch("https://example.invalid", "test-key"), { message: "HTTP 403" });
	});
}

test("new sources do not match provider domains smuggled into a hostname or path", () => {
	const { quota } = load();
	const bases = ["https://chatgpt.com.evil.example/backend-api", "https://api.individual.githubcopilot.com.evil.example",
		"https://radius.pi.dev.evil.example/v1", "https://relay.example/chatgpt.com/backend-api", "https://api.x.ai.evil.example/v1"];
	quota.resolveQuotaBindings(quotaContext(bases.map((baseUrl, i) => ({ provider: `not-supported-${i}`, baseUrl }))));
	assert.equal(quota.bindings.length, 0);
});

for (const [label, config, expected] of [
	["legacy included usage", { monthlyLimit: { val: 20000 }, used: { val: 10000 } }, "xAI 额度 50%"],
	["zero balance without a subscription window", { onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 } }, "xAI 按量 $0.0·余$0.0"],
	["zero subscription usage", { creditUsagePercent: 0 }, "xAI 额度 0%"],
	["unwrapped cents", { monthlyLimit: 20000, used: 5000, prepaidBalance: 1000 }, "xAI 额度 25%·余$10.0"],
	["unknown billing structure", {}, undefined],
	["null protobuf values", { monthlyLimit: { val: null }, used: null, prepaidBalance: { val: null } }, undefined],
]) {
	test(`xAI parses observed billing cents safely: ${label}`, async () => {
		const { quotaSources } = load("zh", { fetch: async (url) => ({ ok: true,
			json: async () => url.endsWith("/user") ? { userId: "ephemeral-id" } : { config },
		}) });
		const result = await quotaSources.find((s) => s.id === "xAI").fetch("https://untrusted.example", "test-key");
		assert.equal(result.seg?.text, expected);
		assert.doesNotMatch(result.detail, /ephemeral-id|test-key/);
	});
}

test("xAI identity must be verified before billing; forged or missing IDs stop the request", async () => {
	for (const userId of [undefined, "", "bad\r\nheader", "x".repeat(257)]) {
		let requests = 0;
		const { quotaSources } = load("zh", { fetch: async (url) => {
			requests++;
			assert.ok(url.endsWith("/user"));
			return { ok: true, json: async () => ({ userId }) };
		} });
		await assert.rejects(quotaSources.find((s) => s.id === "xAI").fetch("https://api.x.ai", "test-key"), { message: "无法确认 xAI 账户身份，未查询账单" });
		assert.equal(requests, 1);
	}
});

test("xAI never sends an API-key override to OAuth subscription endpoints", async () => {
	const { quota } = load("zh", {
		credentials: { xai: { type: "oauth" } },
		fetch: async () => assert.fail("API key must not be sent to OAuth billing"),
	});
	const ctx = quotaContext([{ provider: "xai", baseUrl: "https://api.x.ai/v1" }]);
	ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: "overridden-api-key" }, source: "XAI_API_KEY" });
	quota.resolveQuotaBindings(ctx);
	await quota.refreshQuota(quota.bindings[0], ctx, true);
	const state = quota.quotaStates.get("xai");
	assert.equal(state.seg, null);
	assert.match(state.detail, /需要 Pi OAuth 登录/);
	assert.doesNotMatch(state.detail, /overridden-api-key/);
});

test("xAI modern OAuth resolver supports in-memory credentials without reading default auth.json", async () => {
	const { quota } = load("zh", { fetch: async (url, init) => {
		assert.equal(init.headers.Authorization, "Bearer in-memory-oauth");
		return { ok: true, json: async () => url.endsWith("/user") ? { userId: "temporary-id" } : { config: { prepaidBalance: { val: 1000 } } } };
	} });
	const ctx = quotaContext([{ provider: "xai", baseUrl: "https://api.x.ai/v1" }]);
	ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: "in-memory-oauth" }, source: "OAuth" });
	quota.resolveQuotaBindings(ctx);
	await quota.refreshQuota(quota.bindings[0], ctx, true);
	assert.equal(quota.quotaStates.get("xai").seg.text, "xAI 余$10.0");
});
