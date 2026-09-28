import type { BudgetLimits } from "./config.ts";
import { formatBytes, imageDimensions } from "./image.ts";
import { jsonSize } from "./json-size.ts";
import type { ImageVariant, ResizeSpec } from "./resize.ts";

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

export type OmitReason = "duplicate" | "per-message" | "count" | "image-bytes" | "request-bytes" | "invalid";

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
	/** Header dimensions; undefined when the format is unknown or the header is unreadable. */
	size: { width: number; height: number } | undefined;
}

export interface PlanStats {
	totalImages: number;
	keptImages: number;
	omittedImages: number;
	/** Kept images sent re-encoded (compressed or downscaled to a hard cap). */
	resizedImages: number;
	keptImageBytes: number;
	omittedImageBytes: number;
	/** Base64 bytes saved by re-encoding kept images. */
	savedBytes: number;
	/** Largest kept image, in base64 bytes and pixels; used to learn per-image limits after a rejection. */
	largestImageBytes: number;
	largestImageDimension: number;
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
	/** Key of the newest image in the request, so an "invalid image" rejection can target it. */
	newestKey: string | undefined;
}

/** Produces a re-encoded image for a spec, or null when that is impossible. */
export type Transformer = (ref: ImageRef, spec: ResizeSpec) => Promise<ImageVariant | null>;

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
	/** Omit when re-encoding is unavailable; images then stay original or are dropped. */
	transform?: Transformer;
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

/** Session-stable identity of an image block; shared by the planner and background pre-compression. */
function imageKey(message: MessageLike, messageIndex: number, blockIndex: number): string {
	const owner = message.toolCallId
		? `tr:${message.toolCallId}`
		: `${message.role ?? "m"}:${message.timestamp ?? `i${messageIndex}`}`;
	return `${owner}:${blockIndex}`;
}

export function collectImages(messages: MessageLike[]): ImageRef[] {
	const calls = toolCallIndex(messages);
	const refs: ImageRef[] = [];
	messages.forEach((message, messageIndex) => {
		if (!Array.isArray(message.content)) return;
		const label = sourceLabel(message, calls);
		(message.content as unknown[]).forEach((block, blockIndex) => {
			if (!isImage(block)) return;
			refs.push({
				key: imageKey(message, messageIndex, blockIndex),
				messageIndex,
				blockIndex,
				bytes: block.data.length,
				mimeType: block.mimeType,
				label,
				fingerprint: fingerprint(block.data),
				block,
				size: imageDimensions(block.data, block.mimeType),
			});
		});
	});
	return refs;
}

function describe(ref: ImageRef): string {
	return [ref.size ? `${ref.size.width}x${ref.size.height}` : undefined, ref.mimeType, formatBytes(ref.bytes)]
		.filter(Boolean)
		.join(", ");
}

export function placeholderText(ref: ImageRef, reason: OmitReason): string {
	const why =
		reason === "duplicate"
			? "an identical copy appears later in the conversation"
			: reason === "invalid"
				? "the provider could not process it"
				: "older image dropped to keep the request within size limits";
	return `[Image omitted by pi-image-budget: ${ref.label} (${describe(ref)}); ${why}. It is still in the session file; read the source again if you need to see it.]`;
}

/** Text placed right before a re-encoded image so the model knows detail was lost and can map coordinates. */
export function resizedNote(ref: ImageRef, variant: ImageVariant): string {
	const scale = variant.originalWidth / Math.max(1, variant.width);
	return (
		`[pi-image-budget: ${ref.label} is shown reduced to ${variant.width}x${variant.height} ` +
		`(original ${variant.originalWidth}x${variant.originalHeight}, ${formatBytes(ref.bytes)}) to keep the request small; ` +
		`multiply coordinates by ${scale.toFixed(2)} for the original. Read the source again for full detail.]`
	);
}

/**
 * Neutral Pi images carry base64 (ASCII, no JSON escapes). Count their length without rescanning the
 * entire image history. Final provider payloads are measured separately with the exact JSON walker,
 * including content introduced by other extensions and malformed/non-base64 strings.
 */
export function measureMessages(messages: MessageLike[]): number {
	let imageBytes = 0;
	const skeleton = JSON.stringify(messages, (_key, value) => {
		if (isImage(value)) {
			imageBytes += value.data.length;
			return { ...value, data: "" };
		}
		return value;
	});
	return Buffer.byteLength(skeleton ?? "") + imageBytes;
}

const textBlockBytes = (text: string) => jsonSize({ type: "text", text });
const imageBlockBytes = (mimeType: string, dataLength: number) => jsonSize({ type: "image", mimeType, data: "" }) + dataLength;
/** A comma separates the extra note block from its neighbour in the content array. */
const ARRAY_SEPARATOR = 1;

interface Choice {
	/** Kept with this re-encoded variant; undefined = original bytes. */
	variant?: ImageVariant;
	omitted?: OmitReason;
}

function exceedsCaps(ref: Pick<ImageRef, "bytes" | "size">, maxBytes: number, maxDimension: number): boolean {
	return ref.bytes > maxBytes || (ref.size !== undefined && Math.max(ref.size.width, ref.size.height) > maxDimension);
}

/**
 * Decides how each image appears in one provider request: original, re-encoded, or a placeholder.
 *
 * Order of rules:
 * 1. Images evicted earlier in the session stay evicted (keeps the request prefix cache-stable).
 * 2. Earlier byte-identical copies are replaced (the newest copy remains visible).
 * 3. Per-message caps (hard provider limits) keep the newest images of each message.
 * 4. Images above the per-image hard caps are downscaled; images outside the protected newest ones are
 *    compressed. Re-encoding is deterministic and cached, so the bytes stay identical across requests.
 * 5. If the count, image-byte, or request-byte budget is still exceeded, the oldest unprotected images are
 *    evicted until every metric is at or below `limit * lowWatermark`.
 * 6. If the protected images alone still break a limit, they are compressed as well.
 * The newest `protectRecent` images are exempt from rules 1 and 5 so a just-read screenshot is never hidden.
 */
export async function planImageBudget(input: PlanInput): Promise<PlanResult> {
	const { messages, limits, overheadBytes, sticky, transform } = input;
	const refs = collectImages(messages);
	const baseMessageBytes = measureMessages(messages);
	const newestKey = refs.at(-1)?.key;
	if (refs.length === 0) {
		return {
			messages,
			changed: false,
			evicted: new Map(),
			newestKey,
			stats: {
				totalImages: 0,
				keptImages: 0,
				omittedImages: 0,
				resizedImages: 0,
				keptImageBytes: 0,
				omittedImageBytes: 0,
				savedBytes: 0,
				largestImageBytes: 0,
				largestImageDimension: 0,
				messageBytes: baseMessageBytes,
				estimatedRequestBytes: baseMessageBytes + overheadBytes,
				overBudget: baseMessageBytes + overheadBytes > limits.maxRequestBytes,
				reasons: {},
			},
		};
	}

	// A hard image-count cap (e.g. a catalog maxPerRequest of 1) outranks protection.
	const protectCount = Math.min(limits.protectRecent, limits.maxImages);
	const protectedKeys = new Set(refs.slice(Math.max(0, refs.length - protectCount)).map((ref) => ref.key));
	const choices = new Map<string, Choice>();
	const omit = (ref: ImageRef, reason: OmitReason) => choices.set(ref.key, { omitted: reason });
	const isOmitted = (ref: ImageRef) => choices.get(ref.key)?.omitted !== undefined;

	for (const ref of refs) {
		const reason = sticky.get(ref.key);
		// "invalid" is a provider verdict on the bytes themselves, so it outranks protection.
		if (reason && (reason === "invalid" || !protectedKeys.has(ref.key))) omit(ref, reason);
	}

	if (limits.dedupe) {
		const buckets = new Map<string, ImageRef[]>();
		for (const ref of [...refs].reverse()) {
			const key = `${ref.mimeType}:${ref.fingerprint}`;
			const newer = buckets.get(key) ?? [];
			// Samples narrow candidates only: byte equality proves a duplicate.
			if (newer.some((copy) => copy.block.data === ref.block.data)) {
				if (!isOmitted(ref)) omit(ref, "duplicate");
			}
			else { newer.push(ref); buckets.set(key, newer); }
		}
	}

	if (Number.isFinite(limits.maxImagesPerMessage)) {
		const byMessage = new Map<number, ImageRef[]>();
		for (const ref of refs) {
			if (isOmitted(ref)) continue;
			const list = byMessage.get(ref.messageIndex) ?? [];
			list.push(ref);
			byMessage.set(ref.messageIndex, list);
		}
		for (const list of byMessage.values()) {
			for (const ref of list.slice(0, Math.max(0, list.length - limits.maxImagesPerMessage))) omit(ref, "per-message");
		}
	}

	// Re-encode only images that can survive the count cap: older ones are evicted anyway, and every
	// re-encode costs ~1 s of worker time on first sight.
	const hardSpec: ResizeSpec = { maxDimension: limits.maxImageDimension, maxBytes: limits.maxBytesPerImage };
	const compressSpec: ResizeSpec = {
		maxDimension: Math.min(limits.compressMaxDimension, limits.maxImageDimension),
		maxBytes: Math.min(limits.compressMaxBytes, limits.maxBytesPerImage),
	};
	let candidates = refs.filter((ref) => !isOmitted(ref));
	if (candidates.length > limits.maxImages) {
		const target = Math.max(protectCount, Math.floor(limits.maxImages * limits.lowWatermark));
		for (const ref of candidates.slice(0, candidates.length - target)) omit(ref, "count");
		candidates = candidates.filter((ref) => !isOmitted(ref));
	}
	await Promise.all(
		candidates.map(async (ref) => {
			const wantsCompression = limits.compress && !protectedKeys.has(ref.key);
			const spec = wantsCompression ? compressSpec : hardSpec;
			const breaksHardCap = exceedsCaps(ref, hardSpec.maxBytes, hardSpec.maxDimension);
			if (!exceedsCaps(ref, spec.maxBytes, spec.maxDimension)) return;
			let variant = transform ? await transform(ref, spec) : null;
			// Compression failed but the hard caps can still be met by a milder re-encode.
			if (!variant && breaksHardCap && spec !== hardSpec && transform) variant = await transform(ref, hardSpec);
			if (variant && (variant.data.length < ref.bytes || breaksHardCap)) choices.set(ref.key, { variant });
			else if (breaksHardCap) omit(ref, "image-bytes");
		}),
	);

	const placeholderBytes = (ref: ImageRef, reason: OmitReason) => textBlockBytes(placeholderText(ref, reason));
	const originalBytes = (ref: ImageRef) => jsonSize({ ...ref.block, data: "" }) + ref.bytes;
	const keptBytes = (ref: ImageRef) => choices.get(ref.key)?.variant?.data.length ?? ref.bytes;
	const variantDelta = (ref: ImageRef, variant: ImageVariant) =>
		textBlockBytes(resizedNote(ref, variant)) + ARRAY_SEPARATOR + imageBlockBytes(variant.mimeType, variant.data.length) - originalBytes(ref);

	let keptCount = 0;
	let keptImageBytes = 0;
	let requestBytes = baseMessageBytes + overheadBytes;
	for (const ref of refs) {
		const choice = choices.get(ref.key);
		if (choice?.omitted) {
			requestBytes += placeholderBytes(ref, choice.omitted) - originalBytes(ref);
			continue;
		}
		keptCount += 1;
		keptImageBytes += keptBytes(ref);
		if (choice?.variant) requestBytes += variantDelta(ref, choice.variant);
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
			if (isOmitted(ref) || protectedKeys.has(ref.key)) continue;
			const reason = reasonNow();
			const variant = choices.get(ref.key)?.variant;
			requestBytes -= variant ? variantDelta(ref, variant) : 0;
			requestBytes += placeholderBytes(ref, reason) - originalBytes(ref);
			keptCount -= 1;
			keptImageBytes -= keptBytes(ref);
			omit(ref, reason);
		}
	}

	// Last resort before failing: the protected newest images alone break a limit (typically a tight
	// limit learned from a rejection), so send them compressed too rather than a request that will bounce.
	if (exceeds(1) && limits.compress && transform) {
		for (const ref of refs) {
			if (!exceeds(1)) break;
			if (!protectedKeys.has(ref.key) || isOmitted(ref) || choices.get(ref.key)?.variant) continue;
			if (!exceedsCaps(ref, compressSpec.maxBytes, compressSpec.maxDimension)) continue;
			const variant = await transform(ref, compressSpec);
			if (!variant || variant.data.length >= ref.bytes) continue;
			choices.set(ref.key, { variant });
			keptImageBytes += variant.data.length - ref.bytes;
			requestBytes += variantDelta(ref, variant);
		}
	}

	const evicted = new Map<string, OmitReason>();
	const stats: PlanStats = {
		totalImages: refs.length,
		keptImages: keptCount,
		omittedImages: refs.length - keptCount,
		resizedImages: 0,
		keptImageBytes,
		omittedImageBytes: 0,
		savedBytes: 0,
		largestImageBytes: 0,
		largestImageDimension: 0,
		messageBytes: requestBytes - overheadBytes,
		estimatedRequestBytes: requestBytes,
		overBudget: exceeds(1),
		reasons: {},
	};
	for (const ref of refs) {
		const choice = choices.get(ref.key);
		if (choice?.omitted) {
			evicted.set(ref.key, choice.omitted);
			stats.omittedImageBytes += ref.bytes;
			stats.reasons[choice.omitted] = (stats.reasons[choice.omitted] ?? 0) + 1;
			continue;
		}
		const variant = choice?.variant;
		if (variant) {
			stats.resizedImages += 1;
			stats.savedBytes += ref.bytes - variant.data.length;
		}
		stats.largestImageBytes = Math.max(stats.largestImageBytes, variant?.data.length ?? ref.bytes);
		const dimension = variant
			? Math.max(variant.width, variant.height)
			: ref.size
				? Math.max(ref.size.width, ref.size.height)
				: 0;
		stats.largestImageDimension = Math.max(stats.largestImageDimension, dimension);
	}
	if (choices.size === 0) return { messages, changed: false, stats, evicted, newestKey };

	const byMessage = new Map<number, ImageRef[]>();
	for (const ref of refs) {
		if (!choices.has(ref.key)) continue;
		const list = byMessage.get(ref.messageIndex) ?? [];
		list.push(ref);
		byMessage.set(ref.messageIndex, list);
	}
	const out = messages.map((message, index) => {
		const list = byMessage.get(index);
		if (!list) return message;
		const replaced = new Map(list.map((ref) => [ref.blockIndex, ref]));
		const content = (message.content as unknown[]).flatMap((block, blockIndex) => {
			const ref = replaced.get(blockIndex);
			if (!ref) return [block];
			const choice = choices.get(ref.key)!;
			if (choice.omitted) return [{ type: "text", text: placeholderText(ref, choice.omitted) }];
			const variant = choice.variant!;
			return [
				{ type: "text", text: resizedNote(ref, variant) },
				{ type: "image", mimeType: variant.mimeType, data: variant.data },
			];
		});
		return { ...message, content };
	});
	return { messages: out, changed: true, stats, evicted, newestKey: refs.filter((ref) => !isOmitted(ref)).at(-1)?.key };
}
