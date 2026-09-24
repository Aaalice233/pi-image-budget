import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubPayload } from "../src/payload.ts";

const b64 = (n: number, c = "A") => c.repeat(n);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("anthropic: oldest images become text, newest kept", () => {
	const payload = {
		messages: [
			{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64(1000) } }] },
			{ role: "user", content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64(1000, "B") } }] }] },
			{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64(1000, "C") } }] },
		],
	};
	const result = scrubPayload(payload, size(payload), 1500, 1);
	assert.equal(result.removed, 2);
	assert.equal((payload.messages[0]!.content[0] as { type: string }).type, "text");
	assert.equal(((payload.messages[1]!.content[0] as { content: Array<{ type: string }> }).content[0]!).type, "text");
	assert.equal((payload.messages[2]!.content[0] as { type: string }).type, "image");
	assert.ok(size(payload) <= result.bytesAfter + 50);
});

test("openai chat, responses, gemini and bedrock shapes", () => {
	const payload = {
		a: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64(500)}` } }],
		b: [{ type: "input_image", image_url: `data:image/png;base64,${b64(500)}` }],
		c: [{ inlineData: { mimeType: "image/png", data: b64(500) } }],
		d: [{ image: { format: "png", source: { bytes: b64(500) } } }],
		keep: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64(500)}` } }],
	};
	const result = scrubPayload(payload, size(payload), 0, 1);
	assert.equal(result.removed, 4);
	assert.equal(payload.a[0]!.type, "text");
	assert.equal((payload.b[0] as { type: string }).type, "input_text");
	assert.ok("text" in payload.c[0]!);
	assert.ok("text" in payload.d[0]!);
	assert.equal(payload.keep[0]!.type, "image_url");
});

test("no-op when already under the limit", () => {
	const payload = { messages: [{ type: "image", source: { type: "base64", data: b64(100) } }] };
	const result = scrubPayload(payload, size(payload), 10_000, 0);
	assert.equal(result.removed, 0);
});
