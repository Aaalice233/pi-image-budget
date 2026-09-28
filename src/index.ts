import { type ExtensionAPI, type ExtensionContext, resizeImage } from "@earendil-works/pi-coding-agent";
import {
	type BudgetLimits,
	type LoadedConfig,
	loadConfig,
	type ModelLike,
	modelKey,
	resolveLimits,
} from "./config.ts";
import {
	type MessageLike,
	type OmitReason,
	type PlanResult,
	type PlanStats,
	planImageBudget,
	type Transformer,
} from "./budget.ts";
import { classifyError, type Rejection } from "./errors.ts";
import { formatBytes } from "./image.ts";
import { messagesFor, type Messages } from "./i18n.ts";
import { jsonSize } from "./json-size.ts";
import { scrubPayload } from "./payload.ts";
import { ImageProcessor, type ResizeFunction } from "./resize.ts";

const ENTRY_TYPE = "pi-image-budget";
const STATUS_KEY = "image-budget";
/** After a size rejection, the next limit is this fraction of the rejected value. */
const REJECTED_SHRINK = 0.9;
/** Limits quoted by the provider are approached with this margin (estimates are not byte-exact). */
const QUOTED_MARGIN = 0.95;

/** Limits learned from provider rejections; they only ever tighten the configured ones. */
type Learned = Partial<Pick<BudgetLimits, "maxRequestBytes" | "maxImages" | "maxBytesPerImage" | "maxImageDimension">>;

interface LearnedEntry {
	model: string;
	limits?: Learned;
	/** Image key the provider could not process; kept omitted after restarts. */
	invalidImage?: string;
	/** Older entry shape; read for sessions written by earlier versions. */
	maxRequestBytes?: number;
	reset?: boolean;
}

interface LastPlan {
	model: string;
	stats: PlanStats;
	newestKey: string | undefined;
	/** Consumed by the first provider request that follows, so unrelated requests cannot skew calibration. */
	pendingCalibration: boolean;
}

interface PendingRejection extends Rejection {
	model: string;
	/** Request stats at the time of the rejection, to verify that a retry is actually smaller. */
	stats: PlanStats | undefined;
	rejectedBytes: number | undefined;
	invalidKey?: string;
}

export interface ImageBudgetOptions {
	/** Test seam; defaults to Pi's Photon-based `resizeImage` (worker thread). */
	resize?: ResizeFunction;
}

/**
 * Keeps image payloads in each provider request within count and byte budgets.
 *
 * State ownership: the session file stays untouched (Pi's append-only history remains the source of
 * truth); this extension only rewrites the per-request copy in `context` and, as a backstop, the
 * provider payload. Learned limits are persisted as custom session entries so they survive restarts.
 */
export default function imageBudget(pi: ExtensionAPI, options: ImageBudgetOptions = {}) {
	let loaded: LoadedConfig = loadConfig(process.cwd(), false);
	let text: Messages = messagesFor(loaded.config.locale);
	let sessionEnabled = true;
	const sticky = new Map<string, OmitReason>();
	const overheadByModel = new Map<string, number>();
	const invalidByModel = new Map<string, Set<string>>();
	const learnedByModel = new Map<string, Learned>();
	let lastPlan: LastPlan | undefined;
	let lastPayloadBytes: number | undefined;
	let lastStatus: number | undefined;
	let pendingRejection: PendingRejection | undefined;
	/** Learned-limit entries waiting for the next settle boundary, where Pi accepts entry drafts. */
	let pendingEntries: LearnedEntry[] = [];
	let recoveriesSinceInput = 0;
	let notifiedEviction = false;
	let warnedOverBudget = false;

	let resizeFailure: string | undefined;
	let warnedResize = false;
	const processor = new ImageProcessor({
		resize: options.resize ?? (resizeImage as ResizeFunction),
		onFailure: (message) => { resizeFailure = message; },
	});
	const transform: Transformer = (ref, spec) =>
		processor.process(processor.hashOf(ref.key, ref.block.data), ref.block.data, ref.mimeType, spec);

	const active = () => loaded.config.enabled && sessionEnabled;

	const limitsFor = (model: ModelLike | undefined): BudgetLimits => {
		const limits = resolveLimits(loaded.config, model);
		const learned = learnedByModel.get(modelKey(model));
		if (learned) {
			for (const [key, value] of Object.entries(learned) as Array<[keyof Learned, number]>) {
				limits[key] = Math.min(limits[key], value);
			}
		}
		return limits;
	};

	const plan = (messages: MessageLike[], ctx: ExtensionContext, stickyMap: ReadonlyMap<string, OmitReason>): Promise<PlanResult> =>
		planImageBudget({
			messages,
			limits: limitsFor(ctx.model),
			overheadBytes: overheadByModel.get(modelKey(ctx.model)) ?? loaded.config.initialOverheadBytes,
			sticky: new Map([...stickyMap, ...[...(invalidByModel.get(modelKey(ctx.model)) ?? [])].map((key) => [key, "invalid"] as const)]),
			transform,
		});

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else if (level !== "info") console.error(message);
	};

	const setStatus = (ctx: ExtensionContext, stats: PlanStats | undefined) => {
		if (!ctx.hasUI) return;
		const visible = stats && (stats.omittedImages > 0 || stats.resizedImages > 0);
		if (!active() || !loaded.config.showStatus || !visible) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text.status(stats.keptImages, stats.totalImages, stats.resizedImages)));
	};

	const reload = (ctx: ExtensionContext) => {
		loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		text = messagesFor(loaded.config.locale);
		if (loaded.errors.length) notify(ctx, text.configErrors(loaded.errors), "warning");
	};

	const rebuildLearned = (ctx: ExtensionContext) => {
		learnedByModel.clear();
		invalidByModel.clear();
		sticky.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as Partial<LearnedEntry> | undefined;
			if (typeof data?.model !== "string") continue;
			if (data.reset) { learnedByModel.delete(data.model); invalidByModel.delete(data.model); continue; }
			if (typeof data.invalidImage === "string") {
				const keys = invalidByModel.get(data.model) ?? new Set<string>();
				keys.add(data.invalidImage);
				invalidByModel.set(data.model, keys);
			}
			const limits = data.limits ?? (typeof data.maxRequestBytes === "number" ? { maxRequestBytes: data.maxRequestBytes } : undefined);
			if (limits) {
				const valid: Learned = {};
				for (const key of ["maxRequestBytes", "maxImages", "maxBytesPerImage", "maxImageDimension"] as const) {
					const value = limits[key];
					if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) valid[key] = value;
				}
				learnedByModel.set(data.model, { ...learnedByModel.get(data.model), ...valid });
			}
			else if (data.invalidImage === undefined) learnedByModel.delete(data.model);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		reload(ctx);
		sessionEnabled = true;
		sticky.clear();
		overheadByModel.clear();
		invalidByModel.clear();
		recoveriesSinceInput = 0;
		warnedResize = false;
		resizeFailure = undefined;
		lastPlan = undefined;
		lastPayloadBytes = undefined;
		lastStatus = undefined;
		pendingRejection = undefined;
		pendingEntries = [];
		notifiedEviction = false;
		warnedOverBudget = false;
		rebuildLearned(ctx);
		setStatus(ctx, undefined);
	});

	pi.on("session_tree", (_event, ctx) => rebuildLearned(ctx));

	pi.on("input", () => {
		recoveriesSinceInput = 0;
		warnedOverBudget = false;
	});

	pi.on("context", async (event, ctx) => {
		if (!active()) return;
		const limits = limitsFor(ctx.model);
		const result = await plan(event.messages as unknown as MessageLike[], ctx, sticky);
		for (const [key, reason] of result.evicted) if (reason !== "invalid") sticky.set(key, reason);
		// Remove identities no longer present after compaction; don't retain an unbounded lifetime map.
		for (const key of sticky.keys()) if (!result.evicted.has(key)) sticky.delete(key);
		if (resizeFailure && !warnedResize) {
			warnedResize = true;
			notify(ctx, text.resizeFailed(resizeFailure), "warning");
		}
		lastPlan = { model: modelKey(ctx.model), stats: result.stats, newestKey: result.newestKey, pendingCalibration: true };
		setStatus(ctx, result.stats);

		const { stats } = result;
		if (stats.omittedImages > 0 && !notifiedEviction) {
			notifiedEviction = true;
			notify(ctx, text.firstEviction(stats.omittedImages, formatBytes(stats.estimatedRequestBytes), formatBytes(limits.maxRequestBytes)));
		}
		if (stats.overBudget && !warnedOverBudget) {
			warnedOverBudget = true;
			notify(ctx, text.overBudget(formatBytes(stats.estimatedRequestBytes), formatBytes(limits.maxRequestBytes)), "warning");
		}
		if (result.changed) return { messages: result.messages as unknown as typeof event.messages };
	});

	pi.on("before_provider_request", (event, ctx) => {
		// A transport failure after this point must not be classified with the previous response's status.
		lastStatus = undefined;
		if (!active()) return;
		const model = modelKey(ctx.model);
		const limits = limitsFor(ctx.model);
		const plannedForThis = lastPlan?.pendingCalibration && lastPlan.model === model ? lastPlan : undefined;
		if (plannedForThis) plannedForThis.pendingCalibration = false;
		// Always check the final envelope: other extensions or newly discovered tool schemas may add
		// content after context. An old estimate must never bypass the safety guard.

		let bytes: number;
		try {
			bytes = jsonSize(event.payload);
		} catch (error) {
			lastPayloadBytes = undefined;
			notify(ctx, `pi-image-budget: cannot measure provider payload: ${String(error)}`, "warning");
			return;
		}
		lastPayloadBytes = bytes;
		if (plannedForThis) {
			overheadByModel.set(model, Math.max(0, bytes - plannedForThis.stats.messageBytes));
		}

		if (!loaded.config.payloadGuard) return;
		const target = bytes > limits.maxRequestBytes ? limits.maxRequestBytes * limits.lowWatermark : limits.maxRequestBytes;
		const result = scrubPayload(event.payload, bytes, target, limits.protectRecent, limits);
		if (result.removed === 0) {
			if (bytes > limits.maxRequestBytes) notify(ctx, text.payloadTooLarge(formatBytes(bytes), formatBytes(limits.maxRequestBytes)), "warning");
			return;
		}
		if (lastPlan) lastPlan.newestKey = undefined; // Provider-side rewrites invalidate neutral image identity.
		if (result.bytesAfter > limits.maxRequestBytes) notify(ctx, text.payloadTooLarge(formatBytes(result.bytesAfter), formatBytes(limits.maxRequestBytes)), "warning");
		lastPayloadBytes = result.bytesAfter;
		notify(ctx, text.payloadScrubbed(result.removed, formatBytes(bytes), formatBytes(result.bytesAfter)), "warning");
		return result.payload;
	});

	pi.on("after_provider_response", (event) => {
		lastStatus = event.status;
	});

	/** Tightens the budget that caused a rejection. Returns a user-facing description, or undefined when nothing changed. */
	const learn = (ctx: ExtensionContext, rejection: Rejection): string | undefined => {
		const model = modelKey(ctx.model);
		const limits = limitsFor(ctx.model);
		const stats = lastPlan?.model === model ? lastPlan.stats : undefined;
		const update: Learned = {};
		let description: string | undefined;
		const quoted = rejection.quotedLimit;
		switch (rejection.kind) {
			case "request-bytes": {
				const rejected = lastPayloadBytes ?? stats?.estimatedRequestBytes;
				const candidates = [rejected && rejected * REJECTED_SHRINK, quoted && quoted * QUOTED_MARGIN].filter(Boolean) as number[];
				if (!candidates.length) break;
				const next = Math.floor(Math.min(...candidates));
				if (Number.isSafeInteger(next) && next > 0 && next < limits.maxRequestBytes) {
					update.maxRequestBytes = next;
					description = text.learnedRequest(formatBytes(rejected ?? quoted!), formatBytes(next));
				}
				break;
			}
			case "image-count": {
				const next = quoted ?? Math.max(1, Math.floor((stats?.keptImages ?? limits.maxImages) * 0.75));
				if (Number.isSafeInteger(next) && next > 0 && next < limits.maxImages) {
					update.maxImages = next;
					description = text.learnedCount(next);
				}
				break;
			}
			case "image-bytes": {
				const largest = stats?.largestImageBytes;
				const next = Math.floor(quoted ? quoted * REJECTED_SHRINK : (largest ?? limits.maxBytesPerImage) * 0.75);
				if (Number.isSafeInteger(next) && next > 0 && next < limits.maxBytesPerImage) {
					update.maxBytesPerImage = next;
					description = text.learnedImageBytes(formatBytes(next));
				}
				break;
			}
			case "image-dimension": {
				const largest = stats?.largestImageDimension || limits.maxImageDimension;
				const next = Math.floor(quoted ?? largest * 0.75);
				if (Number.isSafeInteger(next) && next > 0 && next < limits.maxImageDimension && next < largest + 1) {
					update.maxImageDimension = next;
					description = text.learnedDimension(next);
				}
				break;
			}
			case "invalid-image": {
				// Without an unambiguous provider-to-neutral image mapping, only a single-image request
				// can identify the offender. Never guess that the newest of several images is broken.
				const key = stats?.keptImages === 1 ? lastPlan?.newestKey : undefined;
				const keys = invalidByModel.get(model) ?? new Set<string>();
				if (key && !keys.has(key)) {
					keys.add(key);
					invalidByModel.set(model, keys);
					pendingEntries.push({ model, invalidImage: key });
					description = text.learnedInvalid;
				}
				break;
			}
		}
		if (Object.keys(update).length) {
			learnedByModel.set(model, { ...learnedByModel.get(model), ...update });
			pendingEntries.push({ model, limits: update });
		}
		if (description) notify(ctx, text.learned(description), "warning");
		return description;
	};

	const recordRejection = (ctx: ExtensionContext, rejection: Rejection) => {
		const model = modelKey(ctx.model);
		const stats = lastPlan?.model === model ? lastPlan.stats : undefined;
		const rejectedBytes = lastPayloadBytes ?? stats?.estimatedRequestBytes;
		const invalidKey = rejection.kind === "invalid-image" && stats?.keptImages === 1 ? lastPlan?.newestKey : undefined;
		if (recoveriesSinceInput < loaded.config.maxAutoRecoveries) learn(ctx, rejection);
		pendingRejection = { ...rejection, model, stats, rejectedBytes, invalidKey };
	};

	pi.on("message_end", (event, ctx) => {
		const message = event.message as MessageLike & { stopReason?: string; errorMessage?: string };
		if (message.role !== "assistant") return;
		if (!active()) return;
		if (message.stopReason !== "error") {
			pendingRejection = undefined;
			return;
		}
		// Learn right away: Pi retries transient-looking errors (e.g. "exceeded request buffer limit")
		// by itself, and that retry must already use the tighter budget.
		const rejection = classifyError(message.errorMessage, lastStatus);
		if (rejection) recordRejection(ctx, rejection);
	});

	/** True when the retry request shrinks the dimension the provider rejected. */
	const retryHelps = (rejection: PendingRejection, retry: PlanResult): boolean => {
		const before = rejection.stats;
		const after = retry.stats;
		if (after.overBudget) return false;
		switch (rejection.kind) {
			case "request-bytes":
				return (
					!after.overBudget &&
					rejection.rejectedBytes !== undefined &&
					after.estimatedRequestBytes < rejection.rejectedBytes * REJECTED_SHRINK
				);
			case "image-count":
				return before !== undefined && after.keptImages < before.keptImages;
			case "image-bytes":
				return before !== undefined && after.largestImageBytes < before.largestImageBytes;
			case "image-dimension":
				return before !== undefined && after.largestImageDimension < before.largestImageDimension;
			case "invalid-image":
				return rejection.invalidKey !== undefined && retry.evicted.get(rejection.invalidKey) === "invalid";
		}
	};

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!active()) return;
		const entries = event.context.contextEntries;
		let errorEntryId: string | undefined;
		let errorMessage: string | undefined;
		for (let index = entries.length - 1; index >= 0 && errorEntryId === undefined; index -= 1) {
			const assistant = entries[index]!.messages.find((message) => message.role === "assistant") as
				| { stopReason?: string; errorMessage?: string }
				| undefined;
			if (!assistant) continue;
			if (assistant.stopReason !== "error") break;
			errorEntryId = entries[index]!.sourceEntry.id;
			errorMessage = assistant.errorMessage;
		}
		if (errorEntryId && !pendingRejection) {
			const rejection = classifyError(errorMessage, lastStatus);
			if (rejection) recordRejection(ctx, rejection);
		}
		const rejection = errorEntryId && pendingRejection?.model === modelKey(ctx.model) ? pendingRejection : undefined;
		pendingRejection = undefined;
		const drafts: Array<
			{ type: "custom"; customType: string; data: LearnedEntry } | { type: "context_edit"; targetId: string; replacement: null }
		> = pendingEntries.map((data) => ({ type: "custom", customType: ENTRY_TYPE, data }));
		pendingEntries = [];
		if (!rejection) return drafts.length ? { entries: drafts } : undefined;

		const retry = await plan(
			event.context.contextMessages.filter((message) => {
				const candidate = message as { role?: string; stopReason?: string };
				return !(candidate.role === "assistant" && candidate.stopReason === "error");
			}) as unknown as MessageLike[],
			ctx,
			new Map(sticky),
		);
		const helps = retryHelps(rejection, retry);
		if (loaded.config.autoRecover && helps && recoveriesSinceInput < loaded.config.maxAutoRecoveries) {
			recoveriesSinceInput += 1;
			// Dropping the failed assistant turn from context lets Pi continue from the last user/tool message.
			drafts.push({ type: "context_edit", targetId: errorEntryId!, replacement: null });
			notify(ctx, text.recovering, "warning");
			return { entries: drafts, continue: true };
		}
		if (!helps) notify(ctx, rejection.kind === "invalid-image" ? text.cannotLocateImage : text.cannotRecover, "error");
		return drafts.length ? { entries: drafts } : undefined;
	});

	const statusReport = (ctx: ExtensionContext): string => {
		const model = modelKey(ctx.model);
		const limits = limitsFor(ctx.model);
		const learned = learnedByModel.get(model);
		const count = (value: number) => (Number.isFinite(value) ? String(value) : "∞");
		const lines = [
			`pi-image-budget: ${active() ? "enabled" : "disabled"}`,
			`Model: ${model}`,
			`Limits: images ≤ ${count(limits.maxImages)} (per message ≤ ${count(limits.maxImagesPerMessage)}), ` +
				`image bytes ≤ ${formatBytes(limits.maxImageBytes)}, request ≤ ${formatBytes(limits.maxRequestBytes)}, ` +
				`per image ≤ ${formatBytes(limits.maxBytesPerImage)} / ${count(limits.maxImageDimension)}px, ` +
				`protect newest ${limits.protectRecent}, low watermark ${limits.lowWatermark}`,
			`Compression: ${limits.compress ? `older images → ${limits.compressMaxDimension}px / ${formatBytes(limits.compressMaxBytes)}` : "off"}`,
		];
		if (learned && Object.keys(learned).length) {
			lines.push(
				`Learned from rejections: ${Object.entries(learned)
					.map(([key, value]) => `${key} ${key.endsWith("Bytes") || key === "maxBytesPerImage" ? formatBytes(value) : value}`)
					.join(", ")}`,
			);
		}
		const stats = lastPlan?.stats;
		if (stats) {
			const reasons = Object.entries(stats.reasons)
				.map(([reason, value]) => `${reason} ${value}`)
				.join(", ");
			lines.push(
				`Last request: ${stats.keptImages}/${stats.totalImages} images kept (${stats.resizedImages} reduced, saved ${formatBytes(stats.savedBytes)}), ` +
					`image bytes ${formatBytes(stats.keptImageBytes)}, request ≈ ${formatBytes(stats.estimatedRequestBytes)}` +
					`${lastPayloadBytes !== undefined ? ` (payload ${formatBytes(lastPayloadBytes)})` : ""}` +
					`, overhead ${formatBytes(overheadByModel.get(model) ?? loaded.config.initialOverheadBytes)}`,
			);
			if (reasons) lines.push(`Omitted: ${reasons}`);
		}
		lines.push(`Config: ${loaded.sources.length ? loaded.sources.join(", ") : "defaults"}`);
		return lines.join("\n");
	};

	pi.registerCommand("image-budget", {
		description: "Show or control the image budget (status|on|off|reset|reload)",
		getArgumentCompletions: (prefix) =>
			["status", "on", "off", "reset", "reload"]
				.filter((value) => value.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			switch (action) {
				case "status":
					ctx.ui.notify(statusReport(ctx), "info");
					return;
				case "on":
					sessionEnabled = true;
					ctx.ui.notify(text.enabled, "info");
					return;
				case "off":
					sessionEnabled = false;
					setStatus(ctx, undefined);
					ctx.ui.notify(text.disabled, "info");
					return;
				case "reset": {
					const model = modelKey(ctx.model);
					learnedByModel.delete(model);
					invalidByModel.delete(model);
					pendingEntries = pendingEntries.filter((entry) => entry.model !== model);
					pendingRejection = undefined;
					pi.appendEntry(ENTRY_TYPE, { model, reset: true });
					sticky.clear();
					notifiedEviction = false;
					ctx.ui.notify(text.reset, "info");
					return;
				}
				case "reload":
					reload(ctx);
					ctx.ui.notify(text.reloaded(loaded.sources), "info");
					return;
				default:
					ctx.ui.notify(text.usage, "warning");
			}
		},
	});
}
