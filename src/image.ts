/**
 * Reads pixel dimensions from the first bytes of a base64 image without decoding the whole payload.
 * Only used to label placeholders so the model can tell omitted screenshots apart; failures return undefined.
 */
export function imageDimensions(base64: string, mimeType: string): { width: number; height: number } | undefined {
	try {
		// 64 KiB of base64 covers PNG/GIF/WebP headers and the SOF marker of typical JPEGs.
		const head = Buffer.from(base64.slice(0, 65536 - (65536 % 4)), "base64");
		const type = mimeType.toLowerCase();
		if (type.includes("png") && head.length >= 24) {
			return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
		}
		if (type.includes("gif") && head.length >= 10) {
			return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
		}
		if (type.includes("webp") && head.length >= 30) {
			const chunk = head.toString("ascii", 12, 16);
			if (chunk === "VP8X") return { width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3) };
			if (chunk === "VP8 ") return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
			if (chunk === "VP8L") {
				const bits = head.readUInt32LE(21);
				return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
			}
		}
		if ((type.includes("jpeg") || type.includes("jpg")) && head.length >= 4) {
			let offset = 2;
			while (offset + 9 < head.length) {
				if (head[offset] !== 0xff) return undefined;
				const marker = head[offset + 1]!;
				const length = head.readUInt16BE(offset + 2);
				// SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC) carry the frame size.
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { width: head.readUInt16BE(offset + 7), height: head.readUInt16BE(offset + 5) };
				}
				offset += 2 + length;
			}
		}
	} catch {
		// Labels are cosmetic; a malformed header must never affect budgeting.
	}
	return undefined;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes)) return "∞";
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}
