import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, MiB, type BudgetLimits } from "../src/config.ts";
import { type MessageLike, type OmitReason, planImageBudget } from "../src/budget.ts";
import { fakePng, readTurns } from "./helpers.ts";

const limits = (overrides: Partial<BudgetLimits> = {}): BudgetLimits => ({
	maxImages: DEFAULT_CONFIG.maxImages,
	maxImagesPerMessage: DEFAULT_CONFIG.maxImagesPerMessage,
	maxImageBytes: DEFAULT_CONFIG.maxImageBytes,
	maxRequestBytes: DEFAULT_CONFIG.maxRequestBytes,
	protectRecent: DEFAULT_CONFIG.protectRecent,
	lowWatermark: DEFAULT_CONFIG.lowWatermark,
	dedupe: DEFAULT_CONFIG.dedupe,
	...overrides,
});

const imagesIn = (messages: MessageLike[]) =>
	messages.flatMap((message) =>
		Array.isArray(message.content) ? (message.content as Array<{ type: string }>).filter((b) => b.type === "image") : [],
	);

test("reproduces the reported session: 12 screenshots of ~3 MB stay under a 32 MiB gateway", () => {
	const messages = readTurns(12, 3 * MiB);
	const plan = planImageBudget({ messages, limits: limits(), overheadBytes: 300 * 1024, sticky: new Map() });
	assert.equal(plan.changed, true);
	assert.ok(plan.stats.estimatedRequestBytes <= 24 * MiB, `estimate ${plan.stats.estimatedRequestBytes}`);
	const serialized = Buffer.byteLength(JSON.stringify(plan.messages));
	assert.ok(serialized + 300 * 1024 <= 24 * MiB + 1024, `serialized ${serialized}`);
	assert.equal(plan.stats.messageBytes, serialized, "request estimate must match the real serialized size");
	// Newest screenshots stay visible.
	const last = plan.messages.at(-1)!.content as Array<{ type: string }>;
	assert.equal(last[1]!.type, "image");
});

test("input messages are never mutated", () => {
	const messages = readTurns(12, 3 * MiB);
	const before = JSON.stringify(messages);
	planImageBudget({ messages, limits: limits(), overheadBytes: 0, sticky: new Map() });
	assert.equal(JSON.stringify(messages), before);
});

test("placeholder names the source file, size and dimensions", () => {
	const plan = planImageBudget({ messages: readTurns(12, 3 * MiB), limits: limits(), overheadBytes: 0, sticky: new Map() });
	const first = (plan.messages[2]!.content as Array<{ type: string; text?: string }>)[1]!;
	assert.equal(first.type, "text");
	assert.match(first.text!, /read D:\/shots\/s0\.png/);
	assert.match(first.text!, /1920x1080/);
	assert.match(first.text!, /3\.0 MB/);
});

test("count budget evicts down to the low watermark in one batch", () => {
	const plan = planImageBudget({
		messages: readTurns(9, 100 * 1024),
		limits: limits({ maxImages: 8 }),
		overheadBytes: 0,
		sticky: new Map(),
	});
	assert.equal(plan.stats.keptImages, 6); // floor(8 * 0.75)
	assert.equal(plan.stats.reasons.count, 3);
});

test("nothing changes while all budgets are satisfied", () => {
	const messages = readTurns(8, 100 * 1024);
	const plan = planImageBudget({ messages, limits: limits(), overheadBytes: 0, sticky: new Map() });
	assert.equal(plan.changed, false);
	assert.equal(plan.messages, messages);
});

test("sticky evictions keep the prefix byte-identical on the next request", () => {
	const sticky = new Map<string, OmitReason>();
	const first = planImageBudget({ messages: readTurns(9, 100 * 1024), limits: limits(), overheadBytes: 0, sticky });
	for (const [key, reason] of first.evicted) sticky.set(key, reason);
	const second = planImageBudget({ messages: readTurns(10, 100 * 1024), limits: limits(), overheadBytes: 0, sticky });
	// 10 images, 3 sticky → 7 kept, under the limit of 8, so no new evictions and an unchanged prefix.
	assert.equal(second.stats.keptImages, 7);
	const prefix = (plan: typeof first) => JSON.stringify(plan.messages.slice(0, 19));
	assert.equal(prefix(second), prefix(first));
});

test("protected newest images survive even when they alone exceed the budget", () => {
	const plan = planImageBudget({
		messages: readTurns(3, 4 * MiB),
		limits: limits({ maxRequestBytes: 5 * MiB }),
		overheadBytes: 0,
		sticky: new Map(),
	});
	assert.equal(plan.stats.keptImages, 2);
	assert.equal(plan.stats.overBudget, true);
});

test("a hard per-request image cap outranks protection", () => {
	const plan = planImageBudget({
		messages: readTurns(3, 1024),
		limits: limits({ maxImages: 1 }),
		overheadBytes: 0,
		sticky: new Map(),
	});
	assert.equal(plan.stats.keptImages, 1);
});

test("duplicates keep only the newest copy", () => {
	const messages = readTurns(3, 50 * 1024);
	const image = (messages[2]!.content as Array<{ data?: string }>)[1]!;
	(messages[6]!.content as Array<{ data?: string }>)[1]!.data = image.data; // same file read again
	const plan = planImageBudget({ messages, limits: limits(), overheadBytes: 0, sticky: new Map() });
	assert.equal(plan.stats.reasons.duplicate, 1);
	assert.equal(imagesIn(plan.messages).length, 2);
	assert.match((plan.messages[2]!.content as Array<{ text?: string }>)[1]!.text!, /identical copy/);
});

test("per-message cap keeps the newest images of each message", () => {
	const messages: MessageLike[] = [
		{
			role: "user",
			timestamp: 1,
			content: [
				{ type: "image", mimeType: "image/png", data: fakePng(1024, "a") },
				{ type: "image", mimeType: "image/png", data: fakePng(1024, "b") },
				{ type: "image", mimeType: "image/png", data: fakePng(1024, "c") },
			],
		},
	];
	const plan = planImageBudget({ messages, limits: limits({ maxImagesPerMessage: 2 }), overheadBytes: 0, sticky: new Map() });
	const blocks = plan.messages[0]!.content as Array<{ type: string }>;
	assert.deepEqual(blocks.map((b) => b.type), ["text", "image", "image"]);
});

test("request budget accounts for overhead", () => {
	const plan = planImageBudget({
		messages: readTurns(6, 1 * MiB),
		limits: limits({ maxRequestBytes: 8 * MiB }),
		overheadBytes: 4 * MiB,
		sticky: new Map(),
	});
	// Only the two protected images remain, so the result sits just above the 6 MiB watermark
	// but safely below the hard 8 MiB limit.
	assert.equal(plan.stats.keptImages, 2);
	assert.ok(plan.stats.estimatedRequestBytes <= 8 * MiB);
	assert.equal(plan.stats.overBudget, false);
	assert.equal(plan.stats.reasons["request-bytes"] !== undefined, true);
});
