import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, MiB, type BudgetLimits } from "../src/config.ts";
import { type ImageRef, type MessageLike, planImageBudget, type Transformer } from "../src/budget.ts";
import { ImageProcessor, type ResizeFunction, type ResizeSpec } from "../src/resize.ts";
import { readTurns } from "./helpers.ts";

const limits = (overrides: Partial<BudgetLimits> = {}): BudgetLimits => ({
	maxImages: DEFAULT_CONFIG.maxImages,
	maxImagesPerMessage: DEFAULT_CONFIG.maxImagesPerMessage,
	maxImageBytes: DEFAULT_CONFIG.maxImageBytes,
	maxRequestBytes: DEFAULT_CONFIG.maxRequestBytes,
	maxBytesPerImage: DEFAULT_CONFIG.maxBytesPerImage,
	maxImageDimension: DEFAULT_CONFIG.maxImageDimension,
	compress: true,
	compressMaxDimension: DEFAULT_CONFIG.compressMaxDimension,
	compressMaxBytes: DEFAULT_CONFIG.compressMaxBytes,
	protectRecent: DEFAULT_CONFIG.protectRecent,
	lowWatermark: DEFAULT_CONFIG.lowWatermark,
	dedupe: DEFAULT_CONFIG.dedupe,
	...overrides,
});

/** Deterministic stand-in for Photon: output depends only on the input and the spec. */
const fakeTransform = (calls: ResizeSpec[] = []): Transformer => async (ref: ImageRef, spec: ResizeSpec) => {
	calls.push(spec);
	const scale = Math.min(1, spec.maxDimension / Math.max(ref.size?.width ?? 1, ref.size?.height ?? 1));
	const bytes = Math.min(spec.maxBytes, Math.floor(ref.bytes / 8)) & ~3;
	return {
		data: ref.block.data.slice(0, bytes),
		mimeType: "image/jpeg",
		width: Math.round((ref.size?.width ?? 1) * scale),
		height: Math.round((ref.size?.height ?? 1) * scale),
		originalWidth: ref.size?.width ?? 1,
		originalHeight: ref.size?.height ?? 1,
	};
};

const blocks = (message: MessageLike) => message.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

test("older images are compressed before any is dropped; the newest stay original", async () => {
	const messages = readTurns(12, 3 * MiB);
	const plan = await planImageBudget({ messages, limits: limits(), overheadBytes: 0, sticky: new Map(), transform: fakeTransform() });
	assert.equal(plan.stats.keptImages, 12, "all 12 fit once compressed");
	assert.equal(plan.stats.resizedImages, 10);
	assert.equal(plan.stats.omittedImages, 0);
	const newest = blocks(plan.messages.at(-1)!);
	assert.equal(newest[1]!.data!.length, (messages.at(-1)!.content as Array<{ data: string }>)[1]!.data.length);
	const oldest = blocks(plan.messages[2]!);
	assert.deepEqual(oldest.map((b) => b.type), ["text", "text", "image"]);
	assert.match(oldest[1]!.text!, /reduced to 1280x720 \(original 1920x1080/);
	assert.equal(oldest[2]!.mimeType, "image/jpeg");
	assert.equal(plan.stats.messageBytes, Buffer.byteLength(JSON.stringify(plan.messages)), "estimate stays exact with notes");
});

test("without compression the same session loses most images", async () => {
	const plan = await planImageBudget({
		messages: readTurns(12, 3 * MiB),
		limits: limits({ compress: false }),
		overheadBytes: 0,
		sticky: new Map(),
	});
	assert.ok(plan.stats.keptImages <= 4, `kept ${plan.stats.keptImages}`);
});

test("only images that can survive the count cap are re-encoded", async () => {
	const calls: ResizeSpec[] = [];
	await planImageBudget({
		messages: readTurns(30, 3 * MiB),
		limits: limits({ maxImages: 6 }),
		overheadBytes: 0,
		sticky: new Map(),
		transform: fakeTransform(calls),
	});
	assert.equal(calls.length, 2, "count eviction leaves 4 images, of which 2 are protected");
});

test("protected images above the hard per-image cap are downscaled, not dropped", async () => {
	const calls: ResizeSpec[] = [];
	const plan = await planImageBudget({
		messages: readTurns(1, 6 * MiB),
		limits: limits(),
		overheadBytes: 0,
		sticky: new Map(),
		transform: fakeTransform(calls),
	});
	assert.equal(plan.stats.keptImages, 1);
	assert.equal(plan.stats.resizedImages, 1);
	assert.deepEqual(calls, [{ maxDimension: 2000, maxBytes: DEFAULT_CONFIG.maxBytesPerImage }]);
});

test("protected images are compressed as a last resort when they alone break the request limit", async () => {
	const plan = await planImageBudget({
		messages: readTurns(8, 3 * MiB),
		limits: limits({ maxRequestBytes: 5 * MiB }),
		overheadBytes: 0,
		sticky: new Map(),
		transform: fakeTransform(),
	});
	assert.equal(plan.stats.overBudget, false);
	// The older protected image is reduced first; that alone is enough, so the newest stays original.
	assert.equal(plan.stats.keptImages, 2);
	assert.equal(plan.stats.resizedImages, 1);
	assert.equal(blocks(plan.messages.at(-1)!)[1]!.mimeType, "image/png");
	assert.ok(plan.stats.estimatedRequestBytes <= 5 * MiB);
});

test("an image above the hard cap that cannot be re-encoded is omitted", async () => {
	const plan = await planImageBudget({
		messages: readTurns(1, 6 * MiB),
		limits: limits(),
		overheadBytes: 0,
		sticky: new Map(),
		transform: async () => null,
	});
	assert.equal(plan.stats.keptImages, 0);
	assert.equal(plan.stats.reasons["image-bytes"], 1);
});

test("a failed compression keeps the original when it is within the hard caps", async () => {
	const plan = await planImageBudget({
		messages: readTurns(4, 1 * MiB),
		limits: limits(),
		overheadBytes: 0,
		sticky: new Map(),
		transform: async () => null,
	});
	assert.equal(plan.stats.keptImages, 4);
	assert.equal(plan.changed, false);
});

test("invalid images stay omitted even when protected", async () => {
	const messages = readTurns(2, 1024);
	const plan = await planImageBudget({ messages, limits: limits(), overheadBytes: 0, sticky: new Map([["tr:call1:1", "invalid"]]) });
	assert.equal(plan.stats.keptImages, 1);
	assert.match(blocks(plan.messages[4]!)[1]!.text!, /could not process it/);
});

test("processor dedupes concurrent work, remembers failures and bounds concurrency", async () => {
	let running = 0;
	let peak = 0;
	let calls = 0;
	const resize: ResizeFunction = async (input) => {
		calls += 1;
		running += 1;
		peak = Math.max(peak, running);
		await new Promise((resolve) => setTimeout(resolve, 5));
		running -= 1;
		if (input.length === 3) return null;
		return { data: "QUJD", mimeType: "image/jpeg", width: 1, height: 1, originalWidth: 2, originalHeight: 2 };
	};
	const processor = new ImageProcessor({ resize, concurrency: 2 });
	const spec = { maxDimension: 10, maxBytes: 100 };
	const same = await Promise.all([processor.process("h1", "QUJDRA==", "image/png", spec), processor.process("h1", "QUJDRA==", "image/png", spec)]);
	assert.equal(calls, 1);
	assert.equal(same[0], same[1]);
	await Promise.all(["h2", "h3", "h4", "h5"].map((hash) => processor.process(hash, "QUJDRA==", "image/png", spec)));
	assert.equal(peak, 2);
	assert.equal(await processor.process("bad", "QUJD", "image/png", spec), null);
	assert.equal(await processor.process("bad", "QUJD", "image/png", spec), null);
	assert.equal(calls, 6, "failure is cached");
});

test("cache is byte-bounded, includes MIME, and does not trust message ID/length", async () => {
	let calls = 0;
	const processor = new ImageProcessor({ maxCacheBytes: 4, resize: async () => {
		calls++;
		return { data: "QUJD", mimeType: "image/jpeg", width: 1, height: 1, originalWidth: 2, originalHeight: 2 };
	} });
	const spec = { maxDimension: 10, maxBytes: 100 };
	const a = processor.hashOf("same-message", "QUJD");
	const b = processor.hashOf("same-message", "REVH");
	assert.notEqual(a, b);
	await processor.process(a, "QUJD", "image/png", spec);
	await processor.process(a, "QUJD", "image/jpeg", spec);
	await processor.process(a, "QUJD", "image/png", spec);
	assert.equal(calls, 3, "old MIME variant is evicted by byte budget");
});

test("resize exceptions and oversized outputs report failure and are cached", async () => {
	const errors: string[] = [];
	const processor = new ImageProcessor({ resize: async () => { throw new Error("decoder failed"); }, onFailure: (message) => errors.push(message) });
	const spec = { maxDimension: 10, maxBytes: 100 };
	assert.equal(await processor.process("h", "QUJD", "image/png", spec), null);
	assert.equal(await processor.process("h", "QUJD", "image/png", spec), null);
	assert.deepEqual(errors, ["decoder failed"]);
});

/** Minimal truecolor PNG encoder so the integration test exercises real Photon decoding. */
function pngBase64(width: number, height: number): string {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buffer: Buffer) => {
		let c = 0xffffffff;
		for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, sum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	let seed = 1;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			const offset = y * (width * 3 + 1) + 1 + x * 3;
			raw[offset] = (x * 255) / width;
			raw[offset + 1] = (y * 255) / height;
			raw[offset + 2] = seed & 0x3f;
		}
	}
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
	return png.toString("base64");
}

test("real Photon re-encode is deterministic and fits the compression spec", async () => {
	const data = pngBase64(1920, 1080);
	const spec = { maxDimension: 1280, maxBytes: 400 * 1024 };
	const first = await new ImageProcessor({ resize: resizeImage as ResizeFunction }).process("a", data, "image/png", spec);
	const second = await new ImageProcessor({ resize: resizeImage as ResizeFunction }).process("a", data, "image/png", spec);
	assert.ok(first, "Photon must decode the PNG");
	assert.equal(first.width, 1280);
	assert.equal(first.height, 720);
	assert.ok(first.data.length <= spec.maxBytes, `${first.data.length} bytes`);
	assert.ok(first.data.length < data.length);
	assert.equal(second?.data, first.data, "same input and spec must produce identical bytes");
});
