import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Stub the two git calls probeGit makes: `repos` maps an existing directory to
 * `{ root, branch?, sha? }`. A missing `branch` models detached HEAD (falls back to `sha`),
 * a missing `sha` models an unborn branch, and an unknown directory models "not a repo".
 * The callback is deferred so the extension's async probing path is really exercised.
 */
function stubExecFile(repos = {}) {
	return (file, args, opts, callback) => {
		const done = typeof opts === "function" ? opts : callback;
		const dir = args[1];
		const sub = args[2];
		const entry = repos[dir];
		setImmediate(() => {
			if (file !== "git") return done(new Error(`unexpected executable: ${file}`), "", "");
			if (!entry) return done(new Error("not a git repository"), "", "fatal: not a git repository");
			if (sub === "rev-parse" && args.includes("--show-toplevel")) return done(null, `${entry.root}\n`, "");
			// symbolic-ref：普通与未出生分支都给分支名，detached HEAD 时空输出且退出码非 0
			if (sub === "symbolic-ref") {
				if (!entry.branch) return done(new Error("ref HEAD is not a symbolic ref"), "", "");
				return done(null, `${entry.branch}\n`, "");
			}
			if (sub === "rev-parse" && args.includes("--short")) {
				if (!entry.sha) return done(new Error("Needed a single revision"), "", "");
				return done(null, `${entry.sha}\n`, "");
			}
			return done(new Error(`unexpected git args: ${args.join(" ")}`), "", "");
		});
	};
}

function load(language = "zh", options = {}) {
	const commands = new Map();
	const reads = [];
	const handlers = new Map();
	const tools = new Map();
	const entries = [];
	const exports = {};
	// Expose private quota helpers only in the compiled test sandbox.
	const marker = "const quotaStates = new Map();";
	assert.equal(compiled.split(marker).length, 2);
	// Expose the split/dock layout surgery: it rewrites pi's component tree, so it needs a test too.
	const dockMarker = "let splitPanelTheme = null;";
	assert.equal(compiled.split(dockMarker).length, 2);
	// Expose the work-focus helpers: git probing is stubbed, so the state machine is testable alone.
	const focusMarker = "const gitCache = new Map();";
	assert.equal(compiled.split(focusMarker).length, 2);
	const instrumented = compiled.replace(marker, `${marker}
		pi.testQuota = { bindings, quotaStates, resolveQuotaBindings, refreshQuota, buildSegments, enable,
			createPanel: (theme) => new StatusPanel(theme) };
	`).replace(dockMarker, `${dockMarker}
		pi.testDock = { ensureSplit, undockWidgets, findDockableWidgets, docked: () => dockedWidgets,
			setLayout: (mode) => { layoutMode = mode; }, setActiveTui: (value) => { activeTui = value; } };
	`).replace(focusMarker, `${focusMarker}
		pi.testFocus = { probeGit, noteTouchedPath, refreshFocus, refreshFocusNow, focusDetail, buildSegments, seededTouch,
			clearCache: () => { gitCache.clear(); gitInflight.clear(); },
			snapshot: () => focusCache, effectiveDir: (ctx) => focusDir(ctx), source: () => focusSource(),
			pinned: () => pinnedDir, pin: (dir) => { pinnedDir = dir; },
			setCwdRoot: (dir) => { cwdRoot = dir; } };
	`);
	runInNewContext(`${instrumented}\nexports.quotaSources = QUOTA_SOURCES;`, {
		exports,
		process: { env: {}, cwd: () => process.cwd() },
		require(id) {
			if (id === "@earendil-works/pi-tui") return tui;
			if (id === "@earendil-works/pi-coding-agent") return {
				readStoredCredential: (provider) => options.credentials?.[provider],
			};
			// pi-ai is ESM-only, so the sandbox cannot require the real package for TypeBox.
			if (id === "@earendil-works/pi-ai") return {
				Type: { Object: (properties) => ({ type: "object", properties }) },
			};
			// realGit：用真实 git 子进程，覆盖 stub 表达不出来的 git 行为（未出生分支、detached、软链）
			if (id === "node:child_process") {
				return options.realGit ? require("node:child_process") : { execFile: stubExecFile(options.git) };
			}
			if (id === "node:fs") return {
				readFileSync(path) {
					reads.push(path);
					// Legacy dashboard settings must not affect the remaining UI.
					return JSON.stringify({ language, layout: "bottom", subscriptions: [{ name: "legacy" }], autoDiscoverSubs: false, ...options.config });
				},
				writeFileSync() {},
				// Real ones: nearestDir() must see the actual filesystem to walk up from a file path.
				statSync: (path) => statSync(path),
				existsSync: (path) => existsSync(path),
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
		queueMicrotask,
	});
	const pi = {
		registerCommand: (name, command) => commands.set(name, command),
		registerTool: (tool) => tools.set(tool.name, tool),
		appendEntry: (customType, data) => entries.push({ customType, data }),
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		getThinkingLevel: () => "off",
	};
	exports.default(pi);
	return {
		commands, reads, entries, handlers, tools,
		quotaSources: exports.quotaSources, quota: pi.testQuota, dock: pi.testDock, focus: pi.testFocus,
	};
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
		// magpie：先 /api/hello 认身份，再读额度；带会话 id 时再问 route 定位本会话走的上游
		if (scenario.source === "Magpie") {
			assert.deepEqual(requests.map((r) => r.pathname), ["/api/hello", "/v1/magpie/quotas", "/v1/magpie/route"]);
			assert.equal(requests[2].searchParams.get("session"), "test");
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
		"https://radius.example/v1", "https://relay.example/v1", "https://opencode.ai/zen/v1",
		// 局域网共享的 magpie：要网关 key，不猜（回环才有 /v1/magpie/quotas）
		"https://magpie.example/v1", "http://192.168.1.5:3425/v1"];
	quota.resolveQuotaBindings(quotaContext(bases.map((baseUrl, i) => ({ provider: `unsupported-${i}`, baseUrl }))));
	assert.equal(quota.bindings.length, 0);
});

test("a loopback port that is not magpie shows no quota and says why", async () => {
	const { quota } = load("zh", { fetch: async (url) => {
		assert.equal(url, "http://127.0.0.1:11434/api/hello");
		return { ok: true, json: async () => ({ name: "ollama" }) };
	} });
	const ctx = quotaContext([{ provider: "local", baseUrl: "http://127.0.0.1:11434/v1" }], "local");
	quota.enable(ctx);
	// 回环地址不限定端口（magpie 的 port 可改），所以绑定先建立、再由 /api/hello 认身份决定显不显示
	assert.equal(quota.bindings.length, 1);
	assert.equal(quota.bindings[0].source.id, "Magpie");
	await quota.refreshQuota(quota.bindings[0], ctx, true);
	assert.equal(quota.buildSegments(ctx, theme, footerData, "footer").filter((s) => s.key === "quota").length, 0);
	assert.match(quota.quotaStates.get("local").detail, /不是 magpie/);
});

test("Magpie without a route record falls back to the account magpie last served", async () => {
	const { quotaSources } = load("zh", { fetch: async (url) => {
		if (new URL(url).pathname === "/api/hello")
			return { ok: true, json: async () => ({ name: "magpie", version: "0.1.1203" }) };
		return { ok: true, json: async () => ({ object: "list", data: [
			{ provider: "claude", name: "Claude Code", kind: "subscription", plan: "pro",
				windows: [{ name: "5 hours", used: 34, remaining: 66 }, { name: "7 days", remaining: 41 }] },
			{ provider: "opencode-go", name: "OpenCode Go", kind: "plan", last: true,
				windows: [{ name: "5 hours", used: 2, remaining: 98 }] },
			{ provider: "deepseek", name: "deepseek", kind: "balance", balance: "¥116.18", windows: [] },
		] }) };
	} });
	// 没有 info（无模型/会话上下文）：不请求 route，退回全局 last
	const result = await quotaSources.find((s) => s.id === "Magpie").fetch("http://127.0.0.1:3425", "magpie");
	assert.equal(result.seg.text, "OpenCode Go 5h 2%");
	assert.equal(result.seg.maxPercent, 2);
	assert.deepEqual(Array.from(result.seg.rows, (r) => r.text), ["5h 2%"]);
	assert.match(result.detail, /当前账号: OpenCode Go（套餐） · 未定位到本会话所用账号/);
	// 没有 used 的窗口按 100 - remaining 反推；其余账号只报用得最多的那个窗口
	assert.match(result.detail, /其余 2 个账号: Claude Code 周 59%；deepseek ¥116.18/);
});

test("Magpie shows the account of the model this session routed to", async () => {
	const { quotaSources } = load("zh", { fetch: async (url) => {
		const path = new URL(url).pathname;
		if (path === "/api/hello")
			return { ok: true, json: async () => ({ name: "magpie", version: "0.1.1203" }) };
		if (path === "/v1/magpie/route")
			return { ok: true, json: async () => ({ route: { asked: "group/auto-k3", model: "kimi-code-cn/k3" } }) };
		return { ok: true, json: async () => ({ object: "list", data: [
			{ provider: "opencode-go", name: "OpenCode Go", kind: "plan", last: true,
				windows: [{ name: "5 hours", used: 6, remaining: 94 }] },
			{ provider: "kimi-code-cn", name: "Kimi For Coding", kind: "plan",
				windows: [{ name: "5 hours", used: 0, remaining: 100 }, { name: "7 days", used: 16, remaining: 84 }] },
		] }) };
	} });
	const source = quotaSources.find((s) => s.id === "Magpie");
	// route 说这轮走了 kimi-code-cn/k3：即使全局 last 仍是 opencode-go，也显示 Kimi
	const routed = await source.fetch("http://127.0.0.1:3425", "magpie", { modelId: "group/auto-k3", sessionId: "s1" });
	assert.equal(routed.seg.text, "Kimi For Coding 5h 0%·周 16%");
	assert.match(routed.detail, /当前账号: Kimi For Coding（套餐） · 本会话 route: kimi-code-cn\/k3/);
	assert.match(routed.detail, /其余 1 个账号: OpenCode Go 5h 6%/);
	// 还没 route 记录时按模型 id 的前缀认（kimi-code-cn/k3 → kimi-code-cn）
	const byModel = await source.fetch("http://127.0.0.1:3425", "magpie", { modelId: "kimi-code-cn/k3" });
	assert.equal(byModel.seg.text, "Kimi For Coding 5h 0%·周 16%");
	assert.match(byModel.detail, /当前账号: Kimi For Coding（套餐） · 当前模型 kimi-code-cn\/k3/);
});

test("Magpie does not borrow another account's numbers when the routed provider has no card", async () => {
	const { quotaSources } = load("zh", { fetch: async (url) => {
		if (new URL(url).pathname === "/api/hello")
			return { ok: true, json: async () => ({ name: "magpie" }) };
		return { ok: true, json: async () => ({ object: "list", data: [
			{ provider: "opencode-go", name: "OpenCode Go", kind: "plan", last: true,
				windows: [{ name: "5 hours", used: 6, remaining: 94 }] },
		] }) };
	} });
	// tencent-cloud 在 magpie 里没有额度卡：不拿 opencode-go 的数字冒充，也不显示额度段
	const result = await quotaSources.find((s) => s.id === "Magpie").fetch(
		"http://127.0.0.1:3425", "magpie", { modelId: "tencent-cloud/kimi-k3" });
	assert.equal(result.seg, null);
	assert.match(result.detail, /当前模型: tencent-cloud\/kimi-k3/);
	assert.match(result.detail, /magpie 里没有 tencent-cloud 的额度卡/);
	assert.doesNotMatch(result.detail, /当前账号/);
	// 别的账号仍然在详情里可见，只是不当成「当前账号」
	assert.match(result.detail, /其余 1 个账号: OpenCode Go 5h 6%/);
});

test("a model switch refetches the model-aware quota source without waiting for the TTL", async () => {
	let quotaCalls = 0;
	const { quota } = load("zh", { fetch: async (url) => {
		const path = new URL(url).pathname;
		if (path === "/api/hello")
			return { ok: true, json: async () => ({ name: "magpie", version: "0.1.1203" }) };
		if (path === "/v1/magpie/route") return { ok: true, json: async () => ({ route: null }) };
		quotaCalls++;
		return { ok: true, json: async () => ({ object: "list", data: [
			{ provider: "kimi-code-cn", name: "Kimi For Coding", kind: "plan", last: true,
				windows: [{ name: "5 hours", used: 1, remaining: 99 }] },
		] }) };
	} });
	const ctx = quotaContext([{ provider: "magpie", baseUrl: "http://127.0.0.1:3425/v1" }], "magpie");
	quota.enable(ctx);
	await quota.refreshQuota(quota.bindings[0], ctx, true);
	assert.equal(quotaCalls, 1);
	ctx.model.id = "kimi-code-cn/k3"; // 切模型 → 不等 TTL，立刻重拉
	await quota.refreshQuota(quota.bindings[0], ctx, false);
	assert.equal(quotaCalls, 2);
	await quota.refreshQuota(quota.bindings[0], ctx, false); // 同一模型、TTL 内不再拉
	assert.equal(quotaCalls, 2);
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

/**
 * 复刻 pi 1.2.0 InteractiveMode 的布局树：TUI 上按固定顺序挂 7 个容器，
 * dock（VStack）里是 pending / status / 上方 widget / editor / 下方 widget / footer。
 */
function piLikeTree({ includeAbove = true, includeBelow = true, breakOrder = false } = {}) {
	const leaf = (name) => ({ render: () => [`[${name}]`] });
	const document = leaf("document");
	const pending = leaf("pending");
	const status = leaf("status");
	const widgetsAbove = new tui.VStack([]);
	const editor = new tui.VStack([]);
	const widgetsBelow = new tui.VStack([]);
	const footer = leaf("footer");
	const dockChildren = [pending, status];
	if (includeAbove) dockChildren.push(widgetsAbove);
	if (breakOrder) dockChildren.push(widgetsBelow); // 位置对不上：下方容器跑到了 editor 前面
	dockChildren.push(editor);
	if (!breakOrder && includeBelow) dockChildren.push(widgetsBelow);
	dockChildren.push(footer);
	const dock = new tui.VStack(dockChildren);
	const root = new tui.VStack([
		{ component: document, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	const tuiStub = {
		mode: "fullscreen",
		terminal: { rows: 40, columns: 120 },
		children: [
			document,
			pending,
			status,
			includeAbove ? widgetsAbove : leaf("untracked-above"),
			editor,
			includeBelow ? widgetsBelow : leaf("untracked-below"),
			footer,
		],
		layoutRoot: root,
		setLayoutRoot(value) { this.layoutRoot = value; },
		requestRender() {},
	};
	return { tuiStub, root, dock, document, pending, status, widgetsAbove, editor, widgetsBelow, footer };
}

const dockOrder = (node) => node.entries.map((entry) => entry.component);

test("split docks both widget containers into the right column and restores the dock order", async () => {
	const { dock } = load();
	const tree = piLikeTree();
	dock.setActiveTui(tree.tuiStub);
	dock.setLayout("split");
	dock.ensureSplit(tree.tuiStub, theme);
	await Promise.resolve(); // ensureSplit 在 queueMicrotask 里安装
	const wrapper = tree.tuiStub.layoutRoot;
	assert.equal(wrapper.layoutType, "hstack");
	const right = wrapper.entries[1].component;
	assert.equal(right.layoutType, "vstack");
	assert.equal(right.entries.length, 3); // 状态面板 + 上方容器 + 下方容器
	assert.equal(right.entries[1].component, tree.widgetsAbove);
	assert.equal(right.entries[2].component, tree.widgetsBelow);
	assert.equal(dock.docked().length, 2);
	// 底部 dock 只剩原本不属于 widget 的容器，且 children 与 entries 同步
	assert.deepEqual(tree.dock.children, [tree.pending, tree.status, tree.editor, tree.footer]);
	assert.deepEqual(dockOrder(tree.dock), [tree.pending, tree.status, tree.editor, tree.footer]);
	// 还原：上方容器回 editor 之前、下方容器回 editor 之后
	dock.undockWidgets(tree.root);
	assert.deepEqual(tree.dock.children, [tree.pending, tree.status, tree.widgetsAbove, tree.editor, tree.widgetsBelow, tree.footer]);
	assert.deepEqual(dockOrder(tree.dock), [tree.pending, tree.status, tree.widgetsAbove, tree.editor, tree.widgetsBelow, tree.footer]);
	assert.equal(dock.docked().length, 0);
});

test("split docks the below-editor container alone (FleetView keeps its belowEditor default)", async () => {
	const { dock } = load();
	const tree = piLikeTree({ includeAbove: false });
	dock.setActiveTui(tree.tuiStub);
	dock.setLayout("split");
	dock.ensureSplit(tree.tuiStub, theme);
	await Promise.resolve();
	const right = tree.tuiStub.layoutRoot.entries[1].component;
	assert.equal(right.layoutType, "vstack");
	assert.equal(right.entries.length, 2); // 状态面板 + 下方容器
	assert.equal(right.entries[1].component, tree.widgetsBelow);
	assert.deepEqual(dockOrder(tree.dock), [tree.pending, tree.status, tree.editor, tree.footer]);
});

test("split refuses to dock containers whose sibling order pi no longer matches", async () => {
	const { dock } = load();
	const tree = piLikeTree({ breakOrder: true });
	const found = dock.findDockableWidgets(tree.tuiStub, tree.root);
	// 跨 vm realm 的对象原型不同，逐字段断言而不用 deepEqual
	assert.equal(found.above, null);
	assert.equal(found.below, null);
	dock.setActiveTui(tree.tuiStub);
	dock.setLayout("split");
	dock.ensureSplit(tree.tuiStub, theme);
	await Promise.resolve();
	assert.equal(dock.docked().length, 0);
	// 分栏照旧安装，只是右侧只有状态面板，widget 容器原地不动
	const wrapper = tree.tuiStub.layoutRoot;
	assert.equal(wrapper.layoutType, "hstack");
	assert.equal(wrapper.entries[1].component.layoutType, undefined);
	assert.deepEqual(dockOrder(tree.dock), [tree.pending, tree.status, tree.widgetsAbove, tree.widgetsBelow, tree.editor, tree.footer]);
});

// ---------- 工作焦点（focus）：多仓工作区根下的「你要求工作的仓库」----------
// 目录名故意带大写（CodeBuddy / DashboardForAI）：/statusbar 的参数历史上被整体 toLowerCase，
// 路径大小写一旦被改写，existsSync 在 macOS 上照样通过、但 gitMap 查不到键 → 分支消失。
// 这条用例就是那个回归的护栏。

const focusTmp = mkdtempSync(join(tmpdir(), "pi-statusbar-Focus-"));
const workspace = join(focusTmp, "CodeBuddy", "harness");
const repoA = join(workspace, "pi-statusbar");
const repoB = join(workspace, "DashboardForAI");
for (const dir of [workspace, repoA, repoB]) mkdirSync(dir, { recursive: true });
writeFileSync(join(repoA, "extensions.ts"), "");
writeFileSync(join(repoB, "app.ts"), "");

const gitMap = {
	[repoA]: { root: repoA, branch: "main" },
	[repoB]: { root: repoB, branch: "feature/x" },
};
const focusFooterData = { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };

/** 等异步探测落地：execFile 存根走 setImmediate，扩展内部再 .then 一层微任务 */
const settle = async () => {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** 只带焦点相关字段的最小 ctx；cwd 默认是非 git 的工作区根 */
function focusContext(cwd = workspace) {
	const notices = [];
	return {
		notices,
		ctx: {
			cwd, hasUI: true, mode: "tui",
			model: { id: "test-model", provider: "test" },
			modelRegistry: { getAvailable: () => [], getApiKeyForProvider: async () => undefined },
			sessionManager: { getBranch: () => [], getSessionId: () => "test" },
			getContextUsage: () => undefined,
			ui: { notify: (...args) => notices.push(args) },
		},
	};
}

const branchSegments = (quota, ctx, variant = "footer") =>
	quota.buildSegments(ctx, theme, focusFooterData, variant).filter((s) => s.key === "branch");

test("focus: pinned directory renders repo, branch and dim cwd", async () => {
	const { commands, quota, focus, entries } = load("zh", { git: gitMap });
	const { ctx, notices } = focusContext();
	focus.setCwdRoot(workspace); // cwd 不是 git 目录：根就等于 cwd
	await commands.get("statusbar").handler(`focus ${repoA}`, ctx);
	await settle();

	assert.equal(focus.pinned(), repoA);
	assert.deepEqual(entries.map((e) => e.customType), ["statusbar:focus"]);
	assert.match(notices[0][0], /焦点已钉在/);

	const footer = branchSegments(quota, ctx);
	assert.equal(footer.length, 1);
	assert.equal(footer[0].text, "pi-statusbar (main) ·harness");
	assert.equal(footer[0].label, "Focus");
	assert.equal(footer[0].pri, 0);

	// 竖卡：分支括号进焦点值，一行放下
	const panel = branchSegments(quota, ctx, "panel");
	assert.deepEqual(Array.from(panel, (s) => s.text), ["pi-statusbar (main)"]);
	assert.deepEqual(Array.from(panel, (s) => s.label), ["Focus"]);
});

test("focus: clear returns to auto and records a session entry", async () => {
	const { commands, quota, focus, entries } = load("zh", { git: gitMap });
	const { ctx, notices } = focusContext();
	focus.setCwdRoot(workspace);
	const handler = commands.get("statusbar").handler;
	await handler(`focus ${repoA}`, ctx);
	await handler("focus clear", ctx);
	await settle();

	assert.equal(focus.pinned(), null);
	assert.deepEqual(entries.map((e) => e.data.path), [repoA, null]);
	assert.match(notices.at(-1)[0], /回到自动推断/);
	// 回到旧行为：cwd 非 git 目录 → Dir + 目录名
	const segs = branchSegments(quota, ctx);
	assert.deepEqual(Array.from(segs, (s) => [s.label, s.text]), [["Dir", "harness"]]);

	// 查询形式：不带参数只报告现状，不改变焦点
	await handler("focus", ctx);
	assert.match(notices.at(-1)[0], /焦点目录: /);
	assert.match(notices.at(-1)[0], /来源: 默认（跟随 cwd）/);
	assert.equal(focus.pinned(), null);
});

test("focus: same repo as cwd keeps the legacy single-branch segment", async () => {
	const { quota, focus } = load("zh", { git: gitMap });
	const { ctx } = focusContext(repoA);
	focus.setCwdRoot(repoA);
	focus.pin(repoA);
	await focus.refreshFocusNow(ctx);
	assert.deepEqual(Array.from(branchSegments(quota, ctx), (s) => [s.label, s.text]), [["Branch", "main"]]);

	// 快照未就绪时完全退回旧行为（footerData 给什么就显示什么）
	const fresh = load("zh", { git: gitMap });
	const withCwdBranch = { ...focusFooterData, getGitBranch: () => "retired" };
	assert.deepEqual(
		Array.from(
			fresh.quota.buildSegments(ctx, theme, focusFooterData, "footer").filter((s) => s.key === "branch"),
			(s) => [s.label, s.text],
		),
		[["Dir", "pi-statusbar"]],
	);
	// 未就绪时不碰 git，直接用 pi 给的 cwd 分支（本用例故意用一个与探测结果不同的分支名）
	assert.deepEqual(
		Array.from(
			fresh.quota.buildSegments(ctx, theme, withCwdBranch, "footer").filter((s) => s.key === "branch"),
			(s) => [s.label, s.text],
		),
		[["Branch", "retired"]],
	);
});

test("focus: edit takes over, a read does not steal an existing focus", async () => {
	const { quota, focus } = load("zh", { git: gitMap });
	const { ctx } = focusContext();
	focus.setCwdRoot(workspace);
	const fileA = join(repoA, "extensions.ts");
	const fileB = join(repoB, "app.ts");

	// 暂无焦点：弱信号可以建立焦点（read 一个新仓库不算抢占）
	assert.equal(await focus.noteTouchedPath(ctx, fileA, false), true);
	assert.equal(focus.source(), "auto");
	assert.equal(focus.effectiveDir(ctx), repoA);

	// 已有焦点：弱信号不抢占
	assert.equal(await focus.noteTouchedPath(ctx, fileB, false), false);
	assert.equal(focus.effectiveDir(ctx), repoA);

	// 强信号（edit/write）立即抢占
	assert.equal(await focus.noteTouchedPath(ctx, fileB, true), true);
	await settle();
	assert.equal(focus.effectiveDir(ctx), repoB);
	assert.equal(branchSegments(quota, ctx)[0].text, "DashboardForAI (feature/x) ·harness");

	// 相对路径按 cwd 解析
	assert.equal(await focus.noteTouchedPath(ctx, "pi-statusbar/extensions.ts", true), true);
	assert.equal(focus.effectiveDir(ctx), repoA);

	// 非 git 路径（工作区根里的散文件）不改变焦点
	assert.equal(await focus.noteTouchedPath(ctx, join(workspace, "scratch.txt"), true), false);
	assert.equal(focus.effectiveDir(ctx), repoA);
});

test("focus: returning to cwd's own repo resets the default view", async () => {
	const { quota, focus } = load("zh", { git: gitMap });
	const { ctx } = focusContext(repoA);
	focus.setCwdRoot(repoA);
	await focus.noteTouchedPath(ctx, join(repoB, "app.ts"), true);
	await settle();
	assert.equal(focus.effectiveDir(ctx), repoB);
	assert.deepEqual(Array.from(branchSegments(quota, ctx), (s) => s.text), ["DashboardForAI (feature/x) ·pi-statusbar"]);

	await focus.noteTouchedPath(ctx, join(repoA, "extensions.ts"), true);
	await settle();
	assert.equal(focus.effectiveDir(ctx), repoA);
	assert.equal(focus.source(), "cwd");
	assert.deepEqual(Array.from(branchSegments(quota, ctx), (s) => s.text), ["main"]);
});

test("focus: tool_call wiring ignores bash, missing paths and pinned focus", async () => {
	const { handlers, focus } = load("zh", { git: gitMap });
	const { ctx } = focusContext();
	focus.setCwdRoot(workspace);
	const onToolCall = handlers.get("tool_call");
	assert.equal(onToolCall.length, 1);

	await onToolCall[0]({ toolName: "bash", input: { command: "git status" } }, ctx);
	await onToolCall[0]({ toolName: "read", input: {} }, ctx);
	await settle();
	assert.equal(focus.effectiveDir(ctx), workspace);

	await onToolCall[0]({ toolName: "read", input: { path: join(repoA, "extensions.ts") } }, ctx);
	await settle();
	assert.equal(focus.effectiveDir(ctx), repoA);

	// 手动钉住后事件不再参与推断
	focus.pin(repoB);
	await onToolCall[0]({ toolName: "edit", input: { path: join(repoA, "extensions.ts") } }, ctx);
	await settle();
	assert.equal(focus.effectiveDir(ctx), repoB);
});

test("focus: get_work_focus is read-only and reports the effective focus", async () => {
	const { tools, focus } = load("zh", { git: gitMap });
	const tool = tools.get("get_work_focus");
	assert.ok(tool, "get_work_focus must be registered");
	assert.equal(tool.annotations.readOnlyHint, true);
	assert.equal(tool.annotations.idempotentHint, true);
	assert.equal(tool.parameters.type, "object");
	assert.deepEqual(Object.keys(tool.parameters.properties), []);

	const { ctx } = focusContext();
	focus.setCwdRoot(workspace);
	focus.pin(repoA);
	const pinned = await tool.execute("call-1", {}, undefined, undefined, ctx);
	assert.equal(pinned.details, undefined);
	assert.match(pinned.content[0].text, new RegExp(`焦点目录: ${repoA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(pinned.content[0].text, /仓库根: .*pi-statusbar/);
	assert.match(pinned.content[0].text, /分支: main/);
	assert.match(pinned.content[0].text, /来源: 手动钉住/);
	assert.match(pinned.content[0].text, /与 cwd 不是同一个仓库/);

	// 未钉住且 cwd 不是仓库：如实报告「非 git 目录」，不编造分支
	focus.pin(null);
	const auto = await tool.execute("call-2", {}, undefined, undefined, ctx);
	assert.match(auto.content[0].text, /仓库根: （非 git 目录）/);
	assert.match(auto.content[0].text, /分支: （未知）/);
	assert.match(auto.content[0].text, /来源: 默认（跟随 cwd）/);
	assert.match(auto.content[0].text, /与 cwd 同一仓库/);
});

test("focus: the branch segment survives a narrow footer", async () => {
	const { quota, focus } = load("zh", { git: gitMap });
	const { ctx } = focusContext();
	focus.setCwdRoot(workspace);
	focus.pin(repoA);
	await focus.refreshFocusNow(ctx);
	ctx.model = { id: "very-long-model-name-for-width-pressure", provider: "test" };
	ctx.getContextUsage = () => ({ percent: 42 });
	ctx.ui.setFooter = function (factory) {
		this.footer = factory({ terminal: { columns: 44 }, requestRender() {} }, theme, focusFooterData);
	};
	quota.enable(ctx);
	const rendered = ctx.ui.footer.render(44).join("\n");
	assert.match(rendered, /pi-statusbar \(main\)/); // pri=0 的焦点段永不被丢弃
});

test("focus: unborn branch keeps its name, detached HEAD falls back to a short sha", async () => {
	// 回归：曾用一条 `rev-parse --show-toplevel --abbrev-ref HEAD` 探测，未出生分支（git init 后
	// 还没提交）会让整条命令报错，连仓库根一起丢掉 —— 只能显示“非 git 目录”。
	const unborn = join(workspace, "FreshRepo");
	const detached = join(workspace, "DetachedRepo");
	for (const dir of [unborn, detached]) mkdirSync(dir, { recursive: true });
	const { focus } = load("zh", {
		git: {
			...gitMap,
			[unborn]: { root: unborn, branch: "fresh" }, // 有分支名、无 HEAD 提交
			[detached]: { root: detached, sha: "abc1234" }, // 无符号引用、有提交
		},
	});
	const { ctx } = focusContext();
	focus.setCwdRoot(workspace);
	// 跨 vm realm 的对象原型不同，逐字段断言而不用 deepEqual
	const fresh = await focus.probeGit(unborn);
	assert.equal(fresh.root, unborn);
	assert.equal(fresh.branch, "fresh");
	const det = await focus.probeGit(detached);
	assert.equal(det.root, detached);
	assert.equal(det.branch, "abc1234");
	// 非 git 目录：没有仓库根，也不编造分支
	const none = await focus.probeGit(ctx.cwd);
	assert.equal(none.root, undefined);
	assert.equal(none.branch, undefined);
});


test("focus: real git — unborn branch keeps its name, detached HEAD becomes a short sha", async () => {
	// 这两条都是 stub 表达不出来的 git 真实行为，且都曾把实现打回原形：
	//  - 未出生分支（git init 后没提交）：`rev-parse --show-toplevel --abbrev-ref HEAD` 整条失败，
	//    连仓库根一起丢 → 状态栏显示成“非 git 目录”
	//  - detached HEAD：symbolic-ref 为空，必须回落到短 sha
	const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-statusbar-git-")));
	const repo = join(tmp, "work");
	mkdirSync(repo, { recursive: true });
	const run = (...args) => execFileSync("git", ["-C", repo, ...args]).toString().trim();
	try {
		execFileSync("git", ["init", "-q", "-b", "feat", repo]);
		const { focus } = load("zh", { realGit: true });
		const unborn = await focus.probeGit(repo);
		assert.equal(unborn.root, repo, "未出生分支也要能探到仓库根");
		assert.equal(unborn.branch, "feat");

		writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
		run("config", "user.email", "test@example.com");
		run("config", "user.name", "test");
		run("add", "-A");
		run("commit", "-qm", "init");
		focus.clearCache();
		assert.equal((await focus.probeGit(repo)).branch, "feat");

		run("checkout", "-q", "--detach");
		focus.clearCache();
		const detached = await focus.probeGit(repo);
		assert.equal(detached.root, repo);
		assert.equal(detached.branch, run("rev-parse", "--short", "HEAD"));

		// 非 git 目录：没有仓库根，也不编造分支
		focus.clearCache();
		const none = await focus.probeGit(tmp);
		assert.equal(none.root, undefined);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("focus: get_work_focus waits for a sibling tool call in the same batch", async () => {
	// 回归：真实 pi 里 agent 常把 `read X` + `get_work_focus` 放在同一条消息里。pi 会先把一批的
	// 全部 tool_call 事件派发完，再并发执行这批次，所以 read 的触碰路径已登记、但 git 探测还在跑；
	// 工具若不先等那次探测落地，就会报“上一批”的焦点（实测：cwd 而不是刚读的仓库）。
	const { tools, focus, handlers } = load("zh", { git: gitMap });
	const { ctx } = focusContext();
	focus.setCwdRoot(workspace);
	const onToolCall = handlers.get("tool_call")[0];

	// 不 await 探测落地就调工具：模拟同批并发执行
	await onToolCall({ toolName: "read", input: { path: join(repoA, "extensions.ts") } }, ctx);
	const out = await tools.get("get_work_focus").execute("call-1", {}, undefined, undefined, ctx);
	assert.match(out.content[0].text, /来源: 自动推断（最近被改动的仓库）/);
	assert.match(out.content[0].text, new RegExp(`焦点目录: ${repoA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(out.content[0].text, /分支: main/);
});

test("focus: a resumed session replays its last worked-in repo from the transcript", async () => {
	// 回归：重启/续接会话后扩展内存是空的，不回放 transcript 就会退回 cwd（用户：重启后忘了我在哪工作）
	const call = (name, path) => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: "1", name, arguments: { path } }] },
	});
	const withBranch = (entries) => ({ sessionManager: { getBranch: () => entries } });
	const { focus } = load("zh", { git: gitMap });

	// 最近的 edit/write 优先于更新的 read（与实时推断的“强信号优先”一致）
	assert.equal(
		focus.seededTouch(withBranch([
			call("edit", join(repoB, "app.ts")),
			call("read", join(repoA, "extensions.ts")),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
		])),
		join(repoB, "app.ts"),
	);
	// 只有读取类调用时，用最近那次
	assert.equal(focus.seededTouch(withBranch([call("read", join(repoA, "x.ts"))])), join(repoA, "x.ts"));
	// 带 bash 路径参数的工具不算（bash 的 input 不是 path）
	assert.equal(
		focus.seededTouch(withBranch([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } }] } }])),
		undefined,
	);
	// 没有带路径的调用 / transcript 读不出来 → 无种子，保持 cwd 行为
	assert.equal(focus.seededTouch(withBranch([{ type: "message", message: { role: "user", content: "hi" } }])), undefined);
	assert.equal(focus.seededTouch({ sessionManager: { getBranch: () => { throw new Error("boom"); } } }), undefined);
});

test("focus: the seeded touch becomes the focus snapshot on session start", async () => {
	const { focus } = load("zh", { git: gitMap });
	const { ctx } = focusContext();
	focus.setCwdRoot(workspace);
	// session_start 的实际接线：种子 → noteTouchedPath → 快照
	await focus.noteTouchedPath(ctx, focus.seededTouch({
		sessionManager: {
			getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit", arguments: { path: join(repoA, "extensions.ts") } }] } }],
		},
	}), true);
	await settle();
	assert.equal(focus.effectiveDir(ctx), repoA);
	assert.equal(focus.snapshot().branch, "main");
});

test("focus: the sidebar renders one English-labelled Focus row", async () => {
	// 回归 1：新 label 曾用 t().segFocus 跟着 config.language，在 zh 配置下渲染成「焦点」，
	//        而本文件所有面板 label（Branch/Dir/Ctx/Model/Quota…）都是英文。
	// 回归 2：分支曾另起一行 Branch，现在应括号进焦点值、一行放下。
	const { quota, focus } = load("zh", { git: gitMap }); // 故意用 zh 配置
	const { ctx } = focusContext();
	focus.setCwdRoot(workspace);
	focus.pin(repoA);
	await focus.refreshFocusNow(ctx);
	ctx.ui.setFooter = function (factory) {
		this.footer = factory({ terminal: { columns: 120 }, requestRender() {} }, theme, focusFooterData);
	};
	quota.enable(ctx);

	const panel = quota.createPanel(theme).render(32);
	const row = panel.filter((line) => line.includes("pi-statusbar"));
	assert.equal(row.length, 1, "焦点应占一行，不折行");
	assert.match(row[0], /Focus\s+pi-statusbar \(main\)/);
	assert.doesNotMatch(panel.join("\n"), /焦点/, "面板 label 不应跟随 config.language");
	for (const line of panel) assert.ok(tui.visibleWidth(line) <= 32);
});
