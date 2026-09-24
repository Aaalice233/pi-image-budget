import assert from "node:assert/strict";
import { test } from "node:test";
import imageBudget from "../src/index.ts";
import { MiB } from "../src/config.ts";
import { readTurns } from "./helpers.ts";

type Handler = (event: any, ctx: any) => any;

/** Minimal stand-in for Pi's extension runtime: records handlers and replays events. */
function harness(options: { model?: Record<string, unknown> } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const notes: Array<{ message: string; level: string }> = [];
	const status = new Map<string, string | undefined>();
	const appended: unknown[] = [];
	const branch: any[] = [];
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => {};
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
	};
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		model: options.model ?? { provider: "yuan", id: "claude" },
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string, level = "info") => notes.push({ message, level }),
			setStatus: (key: string, value: string | undefined) => status.set(key, value),
			theme: { fg: (_color: string, value: string) => value },
		},
	};
	imageBudget(pi as any);
	const emit = async (name: string, event: any) => {
		let result: any;
		for (const handler of handlers.get(name) ?? []) result = (await handler({ type: name, ...event }, ctx)) ?? result;
		return result;
	};
	return { emit, ctx, notes, status, appended, branch, commands };
}

const imageCount = (messages: any[]) =>
	messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "image").length : 0), 0);

test("context handler trims the reported 12-screenshot session and shows status", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	const messages = readTurns(12, 3 * MiB);
	const result = await h.emit("context", { messages });
	assert.ok(result?.messages, "context must return rewritten messages");
	assert.ok(imageCount(result.messages) < 12);
	assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) < 24 * MiB);
	assert.match(h.status.get("image-budget") ?? "", /\d+\/12/);
	assert.equal(h.notes.length, 1, "first eviction notifies once");
	await h.emit("context", { messages });
	assert.equal(h.notes.length, 1, "later evictions stay quiet");
});

test("413 lowers the limit, persists it, drops the failed turn and continues", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	// 5 × 3 MB = 15 MB passes the default budgets (16 MB images / 24 MB request) but a stricter gateway rejects it.
	const messages = readTurns(5, 3 * MiB);
	const first = await h.emit("context", { messages });
	assert.equal(first, undefined, "under budget: request untouched");
	const payload = { model: "x", messages: JSON.parse(JSON.stringify(messages)) };
	await h.emit("before_provider_request", { payload });
	await h.emit("after_provider_response", { status: 413, headers: {} });

	const failed = { role: "assistant", stopReason: "error", errorMessage: "413 Request exceeds the maximum size", content: [] };
	const contextMessages = [...messages, failed];
	const entries = contextMessages.map((message, index) => ({ sourceEntry: { id: `e${index}` }, messages: [message] }));
	const settle = await h.emit("agent_before_settle", { context: { contextEntries: entries, contextMessages }, entries: [], continue: false });
	assert.equal(settle?.continue, true);
	const custom = settle.entries.find((e: any) => e.type === "custom");
	assert.ok(custom.data.maxRequestBytes < Buffer.byteLength(JSON.stringify(payload)));
	assert.deepEqual(settle.entries.find((e: any) => e.type === "context_edit"), {
		type: "context_edit",
		targetId: `e${contextMessages.length - 1}`,
		replacement: null,
	});

	const retry = await h.emit("context", { messages });
	assert.ok(retry?.messages, "retry request must be trimmed under the learned limit");
	assert.ok(Buffer.byteLength(JSON.stringify(retry.messages)) < custom.data.maxRequestBytes);
});

test("learned limits are restored from the session branch", async () => {
	const h = harness();
	h.branch.push({ type: "custom", customType: "pi-image-budget", data: { model: "yuan/claude", maxRequestBytes: 10 * MiB } });
	await h.emit("session_start", { reason: "resume" });
	const result = await h.emit("context", { messages: readTurns(5, 3 * MiB) });
	assert.ok(result?.messages);
	assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) <= 10 * MiB);
});

test("error-text fallback detects wrapped 413s without an HTTP status", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	const messages = readTurns(5, 3 * MiB);
	await h.emit("context", { messages });
	await h.emit("before_provider_request", { payload: { messages } });
	const failed = { role: "assistant", stopReason: "error", errorMessage: "proxy_error: Request exceeds the maximum size", content: [] };
	const contextMessages = [...messages, failed];
	const entries = contextMessages.map((message, index) => ({ sourceEntry: { id: `e${index}` }, messages: [message] }));
	const settle = await h.emit("agent_before_settle", { context: { contextEntries: entries, contextMessages }, entries: [], continue: false });
	assert.equal(settle?.continue, true);
});

test("no retry loop when nothing more can be removed", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	const messages = readTurns(1, 1024);
	await h.emit("context", { messages });
	await h.emit("before_provider_request", { payload: { messages } });
	await h.emit("after_provider_response", { status: 413, headers: {} });
	const failed = { role: "assistant", stopReason: "error", errorMessage: "413", content: [] };
	const contextMessages = [...messages, failed];
	const entries = contextMessages.map((message, index) => ({ sourceEntry: { id: `e${index}` }, messages: [message] }));
	const settle = await h.emit("agent_before_settle", { context: { contextEntries: entries, contextMessages }, entries: [], continue: false });
	assert.notEqual(settle?.continue, true);
	assert.ok(h.notes.some((n) => n.level === "error"));
});

test("payload guard scrubs a payload the estimate missed", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	const image = (c: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: c.repeat(5 * MiB) } });
	const payload = { messages: ["A", "B", "C", "D", "E", "F"].map((c) => ({ role: "user", content: [image(c)] })) };
	const result = await h.emit("before_provider_request", { payload });
	assert.ok(result, "oversized payload must be replaced");
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24 * MiB);
});

test("/image-budget off disables trimming for the session", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	await h.commands.get("image-budget")!.handler("off", h.ctx);
	assert.equal(await h.emit("context", { messages: readTurns(12, 3 * MiB) }), undefined);
	await h.commands.get("image-budget")!.handler("status", h.ctx);
	assert.match(h.notes.at(-1)!.message, /disabled/);
});
