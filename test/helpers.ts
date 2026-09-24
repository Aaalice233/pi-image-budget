import { type MessageLike } from "../src/budget.ts";

/** Builds a PNG-looking base64 payload of exactly `bytes` characters with a unique body. */
export function fakePng(bytes: number, seed: string, width = 1920, height = 1080): string {
	const header = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
	header.writeUInt32BE(13, 8);
	header.write("IHDR", 12, "ascii");
	header.writeUInt32BE(width, 16);
	header.writeUInt32BE(height, 20);
	const head = header.toString("base64"); // 32 chars, 4-aligned
	const body = Buffer.from(seed.repeat(Math.ceil(bytes / seed.length))).toString("base64");
	return (head + body).slice(0, bytes - (bytes % 4));
}

/** One screenshot per turn, exactly like a `read` of a PNG file. */
export function readTurns(count: number, bytes: number): MessageLike[] {
	const messages: MessageLike[] = [{ role: "user", content: "check screenshots", timestamp: 1 }];
	for (let i = 0; i < count; i += 1) {
		messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: `call${i}`, name: "read", arguments: { path: `D:/shots/s${i}.png` } }],
			stopReason: "toolUse",
			timestamp: 10 + i * 2,
		});
		messages.push({
			role: "toolResult",
			toolCallId: `call${i}`,
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", mimeType: "image/png", data: fakePng(bytes, `seed-${i}-`) },
			],
			timestamp: 11 + i * 2,
		});
	}
	return messages;
}
