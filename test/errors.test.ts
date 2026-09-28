import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyError } from "../src/errors.ts";
import { jsonSize } from "../src/json-size.ts";

test("jsonSize equals the UTF-8 length of JSON.stringify", () => {
	const samples: unknown[] = [
		null,
		0,
		-1.5e-7,
		Number.NaN,
		true,
		"",
		'quote " backslash \\ newline \n tab \t bell \u0007 nul \u0000',
		"中文 emoji 😀 line\u2028sep",
		{ a: undefined, b: () => 1, c: [undefined, () => 1, 3], d: { e: "x" } },
		{ date: new Date(0), nested: [[[]], {}] },
		{ type: "image", data: "QUJD".repeat(20_000) },
		{ image_url: { url: `data:image/png;base64,${"QUJD".repeat(20_000)}` } },
		// Long text that merely starts and ends like base64 must still be scanned for escapes.
		{ text: `${"a".repeat(600)}\n"${"b".repeat(20_000)}` },
	];
	for (const sample of samples) {
		assert.equal(jsonSize(sample), Buffer.byteLength(JSON.stringify(sample) ?? "", "utf8"), JSON.stringify(sample)?.slice(0, 80));
	}
});

test("classifies request-size rejections seen from relays", () => {
	assert.deepEqual(classifyError('yuan API error (413): {"message":"Request exceeds the maximum size","type":"proxy_error","code":413}'), {
		kind: "request-bytes",
		quotedLimit: undefined,
	});
	assert.equal(classifyError("exceeded request buffer limit while retrying upstream")?.kind, "request-bytes");
	assert.equal(classifyError("request_too_large: Request exceeds the maximum allowed number of bytes")?.kind, "request-bytes");
	assert.equal(classifyError("Payload Too Large", 413)?.kind, "request-bytes");
	assert.equal(classifyError(undefined, 413)?.kind, "request-bytes");
});

test("classifies image-specific rejections and extracts quoted limits", () => {
	assert.deepEqual(classifyError("messages.3.content.1.image.source.base64: image exceeds 5 MB maximum: 5300000 bytes > 5242880 bytes"), {
		kind: "image-bytes",
		quotedLimit: 5 * 1024 * 1024,
	});
	assert.deepEqual(classifyError("messages.0.content.4.image: image dimensions exceed max allowed size for many-image requests: 2000 pixels"), {
		kind: "image-dimension",
		quotedLimit: 2000,
	});
	assert.deepEqual(classifyError("Too many images in request. Max is 20."), { kind: "image-count", quotedLimit: 20 });
	assert.deepEqual(classifyError("A maximum of 100 images may be provided in one request"), { kind: "image-count", quotedLimit: 100 });
	assert.equal(classifyError("Could not process image")?.kind, "invalid-image");
	assert.equal(classifyError("Invalid image data: failed to decode")?.kind, "invalid-image");
});

test("unrelated errors are ignored", () => {
	assert.equal(classifyError("yuan API error (429): 429 status code (no body)", 429), undefined);
	assert.equal(classifyError('yuan API error (503): {"message":"system cpu overloaded (current: 99.4%)"}', 503), undefined);
	assert.equal(classifyError("Connection error."), undefined);
	assert.equal(classifyError("Your credit balance is too low to access the Anthropic API.", 400), undefined);
});
