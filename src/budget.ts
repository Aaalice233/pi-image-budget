import type { BudgetLimits } from "./config.ts";
import { formatBytes, imageDimensions } from "./image.ts";

/** Minimal structural view of Pi `AgentMessage`; unknown roles and fields pass through untouched. */
export interface MessageLike {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	timestamp?: number;
	[key: string]: unknown;
}

interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export type OmitReason = "duplicate" | "per-message" | "count" | "image-bytes" | "request-bytes";

export interface ImageRef {
	/** Stable across requests of one session, so evictions can stay sticky. */
	key: string;
	messageIndex: number;
	blockIndex: number;
	bytes: number;
	mimeType: string;
	label: string;
	fingerprint: string;
	block: ImageBlock;
}

export interface PlanStats {
	totalImages: number;
	keptImages: number;
	omittedImages: number;
	keptImageBytes: number;
	omittedImageBytes: number;
	/** Serialized size of the returned messages (images included). */
	messageBytes: number;
	/** `messageBytes` plus the estimated non-message part of the provider request. */
	estimatedRequestBytes: number;
	/** True when every removable image was removed and a limit is still exceeded. */
	overBudget: boolean;
	reasons: Partial<Record<OmitReason, number>>;
}

export interface PlanResult {
	messages: MessageLike[];
	changed: boolean;
	stats: PlanStats;
	/** Every image omitted from this request with its reason; the caller keeps them sticky. */
	evicted: Map<string, OmitReason>;
}

export interface PlanInput {
	messages: MessageLike[];
	limits: BudgetLimits;
	/** Bytes the provider request adds on top of the messages (system prompt, tools, envelope). */
	overheadBytes: number;
	/**
	 * Images evicted by earlier requests of this session, with their original reason so the
	 * placeholder text (and therefore the cached request prefix) stays byte-identical.
	 */
	sticky: ReadonlyMap<string, OmitReason>;
}

function isImage(block: unknown): block is ImageBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "image" &&
		typeof (block as { data?: unknown }).data === "string"
	);
}

function toolCallIndex(messages: MessageLike[]): Map<string, { name: string; args: Record<string, unknown> }> {
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as Array<Record<string, unknown>>) {
			if (block?.type === "toolCall" && typeof block.id === "string") {
				const args = (block.arguments && typeof block.arguments === "object" ? block.arguments : {}) as Record<string, unknown>;
				calls.set(block.id, { name: String(block.name ?? "tool"), args });
			}
		}
	}
	return calls;
}

function sourceLabel(
	message: MessageLike,
	calls: Map<string, { name: string; args: Record<string, unknown> }>,
): string {
	if (message.role === "toolResult") {
		const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
		const name = call?.name ?? message.toolName ?? "tool";
		const path = call?.args.path ?? call?.args.file_path ?? call?.args.filePath ?? call?.args.file;
		return typeof path === "string" && path ? `${name} ${path}` : `${name} result`;
	}
	if (message.role === "user") return "user attachment";
	return `${message.role ?? "message"} image`;
}

/** Cheap identity for dedupe: length plus head/middle/tail samples; collisions need identical samples. */
function fingerprint(data: string): string {
	const mid = Math.floor(data.length / 2);
	return `${data.length}:${data.slice(0, 96)}:${data.slice(mid, mid + 96)}:${data.slice(-96)}`;
}

export function collectImages(messages: MessageLike[]): ImageRef[] {
	const calls = toolCallIndex(messages);
	const refs: ImageRef[] = [];
	messages.forEach((message, messageIndex) => {
		if (!Array.isArray(message.content)) return;
		const label = sourceLabel(message, calls);
		(message.content as unknown[]).forEach((block, blockIndex) => {
			if (!isImage(block)) return;
			const owner = message.toolCallId
				? `tr:${message.toolCallId}`
				: `${message.role ?? "m"}:${message.timestamp ?? `i${messageIndex}`}`;
			refs.push({
				key: `${owner}:${blockIndex}`,
				messageIndex,
				blockIndex,
				bytes: block.data.length,
				mimeType: block.mimeType,
				label,
				fingerprint: fingerprint(block.data),
				block,
			});
		});
	});
	return refs;
}

export function placeholderText(ref: ImageRef, reason: OmitReason): string {
	const size = imageDimensions(ref.block.data, ref.mimeType);
	const details = [size ? `${size.width}x${size.height}` : undefined, ref.mimeType, formatBytes(ref.bytes)]
		.filter(Boolean)
		.join(", ");
	const why =
		reason === "duplicate"
			? "an identical copy appears later in the conversation"
			: "older image dropped to keep the request within size limits";
	return `[Image omitted by pi-image-budget: ${ref.label} (${details}); ${why}. It is still in the session file; read the source again if you need to see it.]`;
}

/** Serialized size of messages, counting each image as its base64 length without re-serializing it. */
export function measureMessages(messages: MessageLike[]): number {
	let imageBytes = 0;
	const json = JSON.stringify(messages, (_key, value) => {
		if (isImage(value)) {
			imageBytes += value.data.length;
			return { type: "image", mimeType: value.mimeType, data: "" };
		}
		return value;
	});
	return Buffer.byteLength(json ?? "", "utf8") + imageBytes;
}

/**
 * Decides which images stay in one provider request.
 *
 * Order of rules:
 * 1. Images evicted earlier in the session stay evicted (keeps the request prefix cache-stable).
 * 2. Earlier byte-identical copies are replaced (the newest copy remains visible).
 * 3. Per-message caps (hard provider limits) keep the newest images of each message.
 * 4. If the count, image-byte, or request-byte budget is exceeded, the oldest unprotected images are
 *    evicted until every metric is at or below `limit * lowWatermark`.
 * The newest `protectRecent` images are exempt from rules 1 and 4 so a just-read screenshot is never hidden.
 */
export function planImageBudget(input: PlanInput): PlanResult {
	const { messages, limits, overheadBytes, sticky } = input;
	const refs = collectImages(messages);
	const baseMessageBytes = measureMessages(messages);
	const emptyStats = (): PlanStats => ({
		totalImages: refs.length,
		keptImages: refs.length,
		omittedImages: 0,
		keptImageBytes: refs.reduce((sum, ref) => sum + ref.bytes, 0),
		omittedImageBytes: 0,
		messageBytes: baseMessageBytes,
		estimatedRequestBytes: baseMessageBytes + overheadBytes,
		overBudget: false,
		reasons: {},
	});
	if (refs.length === 0) return { messages, changed: false, stats: emptyStats(), evicted: new Map() };

	// A hard image-count cap (e.g. a catalog maxPerRequest of 1) outranks protection.
	const protectCount = Math.min(limits.protectRecent, limits.maxImages);
	const protectedKeys = new Set(refs.slice(Math.max(0, refs.length - protectCount)).map((ref) => ref.key));
	const omitted = new Map<string, OmitReason>();

	for (const ref of refs) {
		const reason = sticky.get(ref.key);
		if (reason && !protectedKeys.has(ref.key)) omitted.set(ref.key, reason);
	}

	if (limits.dedupe) {
		const newest = new Map<string, string>();
		for (const ref of refs) newest.set(ref.fingerprint, ref.key);
		for (const ref of refs) {
			if (newest.get(ref.fingerprint) !== ref.key && !omitted.has(ref.key)) omitted.set(ref.key, "duplicate");
		}
	}

	if (Number.isFinite(limits.maxImagesPerMessage)) {
		const byMessage = new Map<number, ImageRef[]>();
		for (const ref of refs) {
			if (omitted.has(ref.key)) continue;
			const list = byMessage.get(ref.messageIndex) ?? [];
			list.push(ref);
			byMessage.set(ref.messageIndex, list);
		}
		for (const list of byMessage.values()) {
			for (const ref of list.slice(0, Math.max(0, list.length - limits.maxImagesPerMessage))) {
				omitted.set(ref.key, "per-message");
			}
		}
	}

	// Placeholder bytes replace image bytes; precompute so the request estimate stays exact.
	const placeholderBytes = new Map<string, number>();
	const placeholderFor = (ref: ImageRef, reason: OmitReason): number => {
		const cached = placeholderBytes.get(ref.key);
		if (cached !== undefined) return cached;
		// JSON envelope of {"type":"text","text":"..."} vs the image block it replaces.
		const bytes = Buffer.byteLength(JSON.stringify({ type: "text", text: placeholderText(ref, reason) }), "utf8");
		placeholderBytes.set(ref.key, bytes);
		return bytes;
	};
	const imageBlockBytes = (ref: ImageRef): number =>
		Buffer.byteLength(JSON.stringify({ type: "image", mimeType: ref.mimeType, data: "" }), "utf8") + ref.bytes;

	let keptCount = 0;
	let keptImageBytes = 0;
	let requestBytes = baseMessageBytes + overheadBytes;
	for (const ref of refs) {
		const reason = omitted.get(ref.key);
		if (reason) requestBytes += placeholderFor(ref, reason) - imageBlockBytes(ref);
		else {
			keptCount += 1;
			keptImageBytes += ref.bytes;
		}
	}

	const exceeds = (factor: number): boolean =>
		keptCount > Math.max(protectCount, Math.floor(limits.maxImages * factor)) ||
		keptImageBytes > limits.maxImageBytes * factor ||
		requestBytes > limits.maxRequestBytes * factor;

	if (exceeds(1)) {
		const reasonNow = (): OmitReason =>
			keptCount > limits.maxImages * limits.lowWatermark
				? "count"
				: keptImageBytes > limits.maxImageBytes * limits.lowWatermark
					? "image-bytes"
					: "request-bytes";
		for (const ref of refs) {
			if (!exceeds(limits.lowWatermark)) break;
			if (omitted.has(ref.key) || protectedKeys.has(ref.key)) continue;
			const reason = reasonNow();
			omitted.set(ref.key, reason);
			keptCount -= 1;
			keptImageBytes -= ref.bytes;
			requestBytes += placeholderFor(ref, reason) - imageBlockBytes(ref);
		}
	}

	const stats: PlanStats = {
		totalImages: refs.length,
		keptImages: keptCount,
		omittedImages: refs.length - keptCount,
		keptImageBytes,
		omittedImageBytes: refs.reduce((sum, ref) => sum + (omitted.has(ref.key) ? ref.bytes : 0), 0),
		messageBytes: requestBytes - overheadBytes,
		estimatedRequestBytes: requestBytes,
		overBudget: exceeds(1),
		reasons: {},
	};
	for (const reason of omitted.values()) stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
	if (omitted.size === 0) return { messages, changed: false, stats, evicted: omitted };

	const byMessage = new Map<number, ImageRef[]>();
	for (const ref of refs) {
		if (!omitted.has(ref.key)) continue;
		const list = byMessage.get(ref.messageIndex) ?? [];
		list.push(ref);
		byMessage.set(ref.messageIndex, list);
	}
	const out = messages.map((message, index) => {
		const list = byMessage.get(index);
		if (!list) return message;
		const replaced = new Map(list.map((ref) => [ref.blockIndex, ref]));
		const content = (message.content as unknown[]).map((block, blockIndex) => {
			const ref = replaced.get(blockIndex);
			return ref ? { type: "text", text: placeholderText(ref, omitted.get(ref.key)!) } : block;
		});
		return { ...message, content };
	});
	return { messages: out, changed: true, stats, evicted: omitted };
}
