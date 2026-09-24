/**
 * Last-resort scrub of a provider-specific request payload.
 *
 * The message-level planner works on Pi's neutral message format and is the primary mechanism.
 * Its request-size estimate can only be calibrated after the first real payload has been seen, so
 * this guard catches the remaining cases (first request of a session, extensions that add content
 * after `context`). It recognises the base64 image shapes of the wire formats Pi ships with and
 * replaces the oldest ones with a text part of the same API dialect.
 */

interface Slot {
	parent: Record<string, unknown> | unknown[];
	key: string | number;
	bytes: number;
	replacement: (text: string) => unknown;
}

const TEXT =
	"[Image omitted by pi-image-budget: the provider request exceeded its size limit. It is still in the session file; read the source again if you need to see it.]";

function dataUrlBytes(value: unknown): number {
	return typeof value === "string" && value.startsWith("data:") ? value.length : 0;
}

function classify(node: Record<string, unknown>): Omit<Slot, "parent" | "key"> | undefined {
	// Anthropic Messages: { type: "image", source: { type: "base64", data } }
	const source = node.source as Record<string, unknown> | undefined;
	if (node.type === "image" && source?.type === "base64" && typeof source.data === "string") {
		return { bytes: source.data.length, replacement: (text) => ({ type: "text", text }) };
	}
	// OpenAI Chat Completions: { type: "image_url", image_url: { url: "data:..." } }
	if (node.type === "image_url") {
		const url = (node.image_url as Record<string, unknown> | undefined)?.url ?? node.image_url;
		const bytes = dataUrlBytes(url);
		if (bytes) return { bytes, replacement: (text) => ({ type: "text", text }) };
	}
	// OpenAI Responses: { type: "input_image", image_url: "data:..." }
	if (node.type === "input_image") {
		const bytes = dataUrlBytes(node.image_url);
		if (bytes) return { bytes, replacement: (text) => ({ type: "input_text", text }) };
	}
	// Google Gemini: { inlineData: { mimeType: "image/...", data } }
	const inline = node.inlineData as Record<string, unknown> | undefined;
	if (inline && typeof inline.data === "string" && String(inline.mimeType ?? "").startsWith("image/")) {
		return { bytes: inline.data.length, replacement: (text) => ({ text }) };
	}
	// Amazon Bedrock Converse: { image: { format, source: { bytes } } }
	const image = node.image as Record<string, unknown> | undefined;
	const bedrockBytes = (image?.source as Record<string, unknown> | undefined)?.bytes;
	if (typeof bedrockBytes === "string") return { bytes: bedrockBytes.length, replacement: (text) => ({ text }) };
	return undefined;
}

function collect(node: unknown, parent: Slot["parent"] | undefined, key: string | number, out: Slot[]): void {
	if (Array.isArray(node)) {
		node.forEach((child, index) => collect(child, node, index, out));
		return;
	}
	if (node === null || typeof node !== "object") return;
	const record = node as Record<string, unknown>;
	const hit = parent ? classify(record) : undefined;
	if (hit && parent) {
		out.push({ parent, key, ...hit });
		return;
	}
	for (const [childKey, child] of Object.entries(record)) collect(child, record, childKey, out);
}

export interface ScrubResult {
	payload: unknown;
	removed: number;
	bytesBefore: number;
	bytesAfter: number;
}

/**
 * Replaces the oldest images (document order) until the serialized payload fits `limitBytes`.
 * The newest `protectRecent` images are kept. Mutates and returns the given payload object,
 * which Pi builds fresh for every request.
 */
export function scrubPayload(payload: unknown, bytesBefore: number, limitBytes: number, protectRecent: number): ScrubResult {
	const slots: Slot[] = [];
	collect(payload, undefined, "", slots);
	let bytes = bytesBefore;
	let removed = 0;
	const removable = slots.slice(0, Math.max(0, slots.length - protectRecent));
	for (const slot of removable) {
		if (bytes <= limitBytes) break;
		const replacement = slot.replacement(TEXT);
		(slot.parent as Record<string | number, unknown>)[slot.key] = replacement;
		// The replaced node's non-data fields are small; the base64 payload dominates the delta.
		bytes -= slot.bytes - JSON.stringify(replacement).length;
		removed += 1;
	}
	return { payload, removed, bytesBefore, bytesAfter: bytes };
}
