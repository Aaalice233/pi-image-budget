// Synthetic warm-path budget benchmark. Fixture creation, Pi's structuredClone and first-time Photon
// decoding are deliberately outside these timings. Real decoding has a separate integration test.
import { performance } from "node:perf_hooks";
import { planImageBudget } from "../src/budget.ts";
import { DEFAULT_CONFIG, MiB } from "../src/config.ts";
import { jsonSize } from "../src/json-size.ts";
import { ImageProcessor } from "../src/resize.ts";
import { scrubPayload } from "../src/payload.ts";
import { readTurns } from "../test/helpers.ts";

for (const count of [6, 12, 30]) {
	const messages = readTurns(count, 2 * MiB);
	for (let i = 0; i < 500; i++) messages.push({ role: "user", timestamp: 1e6 + i, content: "中文 text \n".repeat(100) });
	const processor = new ImageProcessor({ resize: async (bytes) => ({
		data: Buffer.from(bytes.subarray(0, 192 * 1024)).toString("base64"), mimeType: "image/jpeg",
		width: 1280, height: 720, originalWidth: 1920, originalHeight: 1080,
	}) });
	const transform = async (ref: any, spec: any) => processor.process(processor.hashOf(ref.key, ref.block.data), ref.block.data, ref.mimeType, spec);
	const sticky = new Map();
	const run = () => planImageBudget({ messages, limits: DEFAULT_CONFIG, overheadBytes: 512 * 1024, sticky, transform });
	const first = await run();
	for (const [key, reason] of first.evicted) sticky.set(key, reason);
	await run();
	let start = performance.now();
	for (let i = 0; i < 10; i++) await run();
	const planMs = (performance.now() - start) / 10;
	const payload = { messages: first.messages.map((message) => ({
		...message,
		content: Array.isArray(message.content) ? message.content.map((block: any) => block.type === "image"
			? { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } } : block) : message.content,
	})) };
	start = performance.now();
	for (let i = 0; i < 10; i++) scrubPayload(payload, jsonSize(payload), DEFAULT_CONFIG.maxRequestBytes, DEFAULT_CONFIG.protectRecent, DEFAULT_CONFIG);
	const guardMs = (performance.now() - start) / 10;
	start = performance.now();
	for (let i = 0; i < 10; i++) Buffer.byteLength(JSON.stringify({ messages }));
	const originalMs = (performance.now() - start) / 10;
	console.log(`${count} × 2MiB + 500 text messages: plan ${planMs.toFixed(1)}ms, final guard ${guardMs.toFixed(1)}ms, original stringify ${originalMs.toFixed(1)}ms; ${(jsonSize(payload) / MiB).toFixed(1)}MiB sent, ${first.stats.keptImages} kept (${first.stats.resizedImages} reduced)`);
}
