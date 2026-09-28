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
	assert.equal(size(payload), result.bytesAfter);
});

test("openai chat, responses, gemini and bedrock real content envelopes", () => {
	const shapes = [
		{ field: "messages", parts: "content", block: { type: "image_url", image_url: { url: `data:image/png;base64,${b64(500)}` } }, type: "text" },
		{ field: "input", parts: "content", block: { type: "input_image", image_url: `data:image/png;base64,${b64(500)}` }, type: "input_text" },
		{ field: "contents", parts: "parts", block: { inlineData: { mimeType: "image/png", data: b64(500) } }, type: undefined },
		{ field: "messages", parts: "content", block: { image: { format: "png", source: { bytes: b64(500) } } }, type: undefined },
	];
	for (const shape of shapes) {
		const parts: any[] = [structuredClone(shape.block), structuredClone(shape.block)];
		const schema = { example: [structuredClone(shape.block)] };
		const payload = { [shape.field]: [{ role: "user", [shape.parts]: parts }], tools: [schema] };
		const beforeSchema = JSON.stringify(schema);
		const result = scrubPayload(payload, size(payload), 0, 1);
		assert.equal(result.removed, 1);
		assert.equal(parts[0].type, shape.type);
		assert.equal(typeof parts[0].text, "string");
		assert.deepEqual(parts[1], shape.block);
		assert.equal(JSON.stringify(schema), beforeSchema, "never traverse tool schemas");
		assert.equal(result.bytesAfter, size(payload));
	}
});

test("no-op when already under the limit", () => {
	const payload = { messages: [{ type: "image", source: { type: "base64", data: b64(100) } }] };
	const result = scrubPayload(payload, size(payload), 10_000, 0);
	assert.equal(result.removed, 0);
});
