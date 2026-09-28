import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, parseLayer, parseSize, resolveLimits } from "../src/config.ts";
import { planImageBudget } from "../src/budget.ts";
import { jsonSize } from "../src/json-size.ts";
import { classifyError } from "../src/errors.ts";
import { scrubPayload } from "../src/payload.ts";
import { readTurns } from "./helpers.ts";

test("sample collisions do not delete distinct images", async () => {
	const messages = readTurns(2, 4096);
	const a = (messages[2]!.content as any[])[1];
	const b = (messages[4]!.content as any[])[1];
	b.data = a.data.slice(0, 500) + (a.data[500] === "A" ? "B" : "A") + a.data.slice(501);
	const plan = await planImageBudget({ messages, limits: { ...DEFAULT_CONFIG, compress: false }, overheadBytes: 0, sticky: new Map() });
	assert.equal(plan.stats.keptImages, 2);
});

test("a dimension-only downscale is used even when encoded output grows", async () => {
	const messages = readTurns(1, 1024);
	const plan = await planImageBudget({ messages, limits: { ...DEFAULT_CONFIG, maxImageDimension: 1000 }, overheadBytes: 0, sticky: new Map(),
		transform: async () => ({ data: "A".repeat(2048), mimeType: "image/png", width: 1000, height: 563, originalWidth: 1920, originalHeight: 1080 }) });
	assert.equal(plan.stats.resizedImages, 1);
	assert.equal(plan.stats.omittedImages, 0);
	assert.equal(plan.stats.largestImageDimension, 1000);
});

test("text-only oversized requests are reported rather than marked in budget", async () => {
	const plan = await planImageBudget({ messages: [{ role: "user", content: "large" }], limits: { ...DEFAULT_CONFIG, maxRequestBytes: 1 }, overheadBytes: 0, sticky: new Map() });
	assert.equal(plan.stats.overBudget, true);
});

test("invalid resize/retry parameters are rejected; model catalog zero caps work", () => {
	const errors: string[] = [];
	assert.deepEqual(parseLayer({ maxBytesPerImage: null, maxImageDimension: 0, compressMaxBytes: -1, maxAutoRecoveries: null }, "test", errors), {});
	assert.equal(errors.length, 4);
	assert.throws(() => parseSize("999999999999999999GB"));
	const limits = resolveLimits(DEFAULT_CONFIG, { inputLimits: { images: { maxPerRequest: 0, maxPerMessage: 0 } } });
	assert.equal(limits.maxImages, 0);
	assert.equal(limits.maxImagesPerMessage, 0);
});

test("JSON sizing handles surrogate code units, escaping, cycles and unrelated image-like data", () => {
	for (const value of ["\ud800", "\udc00", "😀", { type: "image", data: "A".repeat(20_000) + '"\n' }, { a: new Number(4) }]) {
		assert.equal(jsonSize(value), Buffer.byteLength(JSON.stringify(value)));
	}
	const circular: any = {}; circular.self = circular;
	assert.throws(() => jsonSize(circular), /circular/);
});

test("learns permitted rather than observed request size", () => {
	assert.equal(classifyError("Request body too large: observed 10 MB, limit is 8 MB")?.quotedLimit, 8 * 1024 * 1024);
	assert.equal(classifyError("invalid_image_size: image exceeds 5 MB")?.kind, "image-bytes");
});

test("payload caps apply after multiple tool results merge into one provider message", () => {
	const image = () => ({ type: "image", source: { type: "base64", data: "A".repeat(2000) } });
	const payload = { messages: [{ role: "user", content: [
		{ type: "tool_result", tool_use_id: "a", content: [image(), image()] },
		{ type: "tool_result", tool_use_id: "b", content: [image(), image()] },
	] }] };
	const result = scrubPayload(payload, jsonSize(payload), Infinity, 2, { maxImagesPerMessage: 1 });
	assert.equal(result.removed, 3);
	assert.equal(payload.messages[0]!.content[1]!.content[1]!.type, "image");
	assert.equal(result.bytesAfter, jsonSize(payload));
});
