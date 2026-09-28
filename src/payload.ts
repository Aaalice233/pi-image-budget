import { jsonSize } from "./json-size.ts";

interface Slot {
	parent: unknown[];
	index: number;
	group: object;
	bytes: number;
	imageBytes: number;
	replacement: (text: string) => unknown;
}
const TEXT = "[Image omitted by pi-image-budget: provider request limits exceeded. Original remains in the session; read the source again for detail.]";
const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function classify(node: Record<string, unknown>): Pick<Slot, "imageBytes" | "replacement"> | undefined {
	const source = object(node.source);
	if (node.type === "image" && source?.type === "base64" && typeof source.data === "string")
		return { imageBytes: source.data.length, replacement: (text) => ({ type: "text", text }) };
	if (node.type === "image_url" || node.type === "input_image") {
		const url = object(node.image_url)?.url ?? node.image_url;
		if (typeof url === "string") return {
			imageBytes: url.startsWith("data:image/") ? url.length : 0,
			replacement: (text) => ({ type: node.type === "input_image" ? "input_text" : "text", text }),
		};
	}
	const inline = object(node.inlineData);
	if (inline && typeof inline.data === "string" && String(inline.mimeType).startsWith("image/"))
		return { imageBytes: inline.data.length, replacement: (text) => ({ text }) };
	const bytes = object(object(node.image)?.source)?.bytes;
	if (typeof bytes === "string" || bytes instanceof Uint8Array)
		return { imageBytes: typeof bytes === "string" ? bytes.length : Math.ceil(bytes.length / 3) * 4, replacement: (text) => ({ text }) };
	return undefined;
}

/** Only traverse documented message content arrays, never tool schemas/arguments/arbitrary metadata. */
function collectParts(parts: unknown, group: object, out: Slot[]): void {
	if (!Array.isArray(parts)) return;
	parts.forEach((part, index) => {
		const node = object(part);
		if (!node) return;
		const hit = classify(node);
		if (hit) out.push({ ...hit, parent: parts, index, group, bytes: jsonSize(part) });
		else if (node.type === "tool_result") collectParts(node.content, group, out);
		else if (object(node.toolResult)) collectParts(object(node.toolResult)!.content, group, out);
	});
}

export interface ScrubResult { payload: unknown; removed: number; bytesBefore: number; bytesAfter: number }
export interface PayloadCaps { maxImages?: number; maxImagesPerMessage?: number; maxImageBytes?: number }
export function scrubPayload(payload: unknown, bytesBefore: number, limitBytes: number, protectRecent: number, caps: PayloadCaps = {}): ScrubResult {
	const slots: Slot[] = [];
	const root = object(payload);
	for (const field of ["messages", "input", "contents"]) {
		const list = root?.[field];
		if (!Array.isArray(list)) continue;
		for (const message of list) {
			const record = object(message);
			if (record) collectParts(record.content ?? record.parts, record, slots);
		}
	}
	let bytes = bytesBefore;
	let imageBytes = slots.reduce((sum, slot) => sum + slot.imageBytes, 0);
	const removed = new Set<Slot>();
	const remove = (slot: Slot) => {
		if (removed.has(slot)) return;
		const replacement = slot.replacement(TEXT);
		slot.parent[slot.index] = replacement;
		bytes += jsonSize(replacement) - slot.bytes;
		imageBytes -= slot.imageBytes;
		removed.add(slot);
	};
	const maxPerMessage = caps.maxImagesPerMessage ?? Infinity;
	const groups = new Map<object, Slot[]>();
	for (const slot of slots) { const list = groups.get(slot.group) ?? []; list.push(slot); groups.set(slot.group, list); }
	for (const list of groups.values()) for (const slot of list.slice(0, Math.max(0, list.length - maxPerMessage))) remove(slot);
	const maxImages = caps.maxImages ?? Infinity;
	const remaining = slots.filter((slot) => !removed.has(slot));
	const protectedSlots = new Set(remaining.slice(Math.max(0, remaining.length - Math.min(protectRecent, maxImages))));
	for (const slot of remaining) {
		if (bytes <= limitBytes && slots.length - removed.size <= maxImages && imageBytes <= (caps.maxImageBytes ?? Infinity)) break;
		if (protectedSlots.has(slot)) continue;
		remove(slot);
	}
	return { payload, removed: removed.size, bytesBefore, bytesAfter: bytes };
}
