import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BudgetLimits, type LoadedConfig, loadConfig, type ModelLike, modelKey, resolveLimits } from "./config.ts";
import { type MessageLike, type OmitReason, type PlanStats, planImageBudget } from "./budget.ts";
import { messagesFor, type Messages } from "./i18n.ts";
import { formatBytes } from "./image.ts";
import { scrubPayload } from "./payload.ts";

const ENTRY_TYPE = "pi-image-budget";
const STATUS_KEY = "image-budget";
/** After a 413, the next limit is this fraction of the rejected body size. */
const REJECTED_SHRINK = 0.9;
/** Error texts gateways use for body-size rejections when the HTTP status is not visible. */
const TOO_LARGE_PATTERN =
	/\b413\b|request[_ ]too[_ ]large|payload too large|request entity too large|exceeds the maximum size|body (?:is )?too large|request body.*(?:limit|too large|exceed)/i;

interface LearnedEntry {
	model: string;
	maxRequestBytes: number;
}

interface LastPlan {
	model: string;
	stats: PlanStats;
	/** Consumed by the first provider request that follows, so unrelated requests cannot skew calibration. */
	pendingCalibration: boolean;
}

/**
 * Keeps image payloads in each provider request within count and byte budgets.
 *
 * State ownership: the session file stays untouched (Pi's append-only history remains the source of
 * truth); this extension only rewrites the per-request copy in `context` and, as a backstop, the
 * provider payload. Learned 413 limits are persisted as custom session entries so they survive restarts.
 */
export default function imageBudget(pi: ExtensionAPI) {
	let loaded: LoadedConfig = loadConfig(process.cwd(), false);
	let text: Messages = messagesFor(loaded.config.locale);
	let sessionEnabled = true;
	const sticky = new Map<string, OmitReason>();
	const overheadByModel = new Map<string, number>();
	const learnedByModel = new Map<string, number>();
	let lastPlan: LastPlan | undefined;
	let lastPayloadBytes: number | undefined;
	let pendingRejection: { model: string; rejectedBytes: number; newLimit: number | undefined } | undefined;
	let recoveriesSinceInput = 0;
	let notifiedEviction = false;
	let warnedOverBudget = false;

	const active = () => loaded.config.enabled && sessionEnabled;

	const limitsFor = (model: ModelLike | undefined): BudgetLimits => {
		const limits = resolveLimits(loaded.config, model);
		const learned = learnedByModel.get(modelKey(model));
		if (learned !== undefined) limits.maxRequestBytes = Math.min(limits.maxRequestBytes, learned);
		return limits;
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else if (level !== "info") console.error(message);
	};

	const setStatus = (ctx: ExtensionContext, stats: PlanStats | undefined) => {
		if (!ctx.hasUI) return;
		if (!active() || !loaded.config.showStatus || !stats || stats.omittedImages === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text.status(stats.keptImages, stats.totalImages)));
	};

	const reload = (ctx: ExtensionContext) => {
		loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		text = messagesFor(loaded.config.locale);
		if (loaded.errors.length) notify(ctx, text.configErrors(loaded.errors), "warning");
	};

	const rebuildLearned = (ctx: ExtensionContext) => {
		learnedByModel.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as Partial<LearnedEntry> | undefined;
			if (typeof data?.model === "string" && typeof data.maxRequestBytes === "number") {
				learnedByModel.set(data.model, data.maxRequestBytes);
			} else if (typeof data?.model === "string" && data.maxRequestBytes === undefined) {
				learnedByModel.delete(data.model);
			}
		}
	};

	pi.on("session_start", (_event, ctx) => {
		reload(ctx);
		sessionEnabled = true;
		sticky.clear();
		overheadByModel.clear();
		lastPlan = undefined;
		lastPayloadBytes = undefined;
		pendingRejection = undefined;
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

	pi.on("context", (event, ctx) => {
		if (!active()) return;
		const model = modelKey(ctx.model);
		const limits = limitsFor(ctx.model);
		const plan = planImageBudget({
			messages: event.messages as unknown as MessageLike[],
			limits,
			overheadBytes: overheadByModel.get(model) ?? loaded.config.initialOverheadBytes,
			sticky,
		});
		for (const [key, reason] of plan.evicted) sticky.set(key, reason);
		lastPlan = { model, stats: plan.stats, pendingCalibration: true };
		setStatus(ctx, plan.stats);

		if (plan.stats.omittedImages > 0 && !notifiedEviction) {
			notifiedEviction = true;
			notify(
				ctx,
				text.firstEviction(
					plan.stats.omittedImages,
					formatBytes(plan.stats.estimatedRequestBytes),
					formatBytes(limits.maxRequestBytes),
				),
			);
		}
		if (plan.stats.overBudget && !warnedOverBudget) {
			warnedOverBudget = true;
			notify(ctx, text.overBudget(formatBytes(plan.stats.estimatedRequestBytes), formatBytes(limits.maxRequestBytes)), "warning");
		}
		if (plan.changed) return { messages: plan.messages as unknown as typeof event.messages };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!active()) return;
		let bytes: number;
		try {
			bytes = Buffer.byteLength(JSON.stringify(event.payload) ?? "", "utf8");
		} catch {
			return;
		}
		const model = modelKey(ctx.model);
		lastPayloadBytes = bytes;
		if (lastPlan?.pendingCalibration && lastPlan.model === model) {
			lastPlan.pendingCalibration = false;
			overheadByModel.set(model, Math.max(0, bytes - lastPlan.stats.messageBytes));
		}

		const limits = limitsFor(ctx.model);
		if (bytes <= limits.maxRequestBytes) return;
		if (!loaded.config.payloadGuard) return;
		const result = scrubPayload(event.payload, bytes, limits.maxRequestBytes * limits.lowWatermark, limits.protectRecent);
		if (result.removed === 0) {
			notify(ctx, text.payloadTooLarge(formatBytes(bytes), formatBytes(limits.maxRequestBytes)), "warning");
			return;
		}
		const after = Buffer.byteLength(JSON.stringify(result.payload) ?? "", "utf8");
		lastPayloadBytes = after;
		notify(ctx, text.payloadScrubbed(result.removed, formatBytes(bytes), formatBytes(after)), "warning");
		return result.payload;
	});

	/** Records a body-size rejection and lowers this model's limit below the rejected size. */
	const recordRejection = (ctx: ExtensionContext, rejectedBytes: number | undefined) => {
		const bytes = rejectedBytes ?? lastPlan?.stats.estimatedRequestBytes;
		if (bytes === undefined) return;
		const model = modelKey(ctx.model);
		const current = limitsFor(ctx.model).maxRequestBytes;
		const candidate = Math.floor(bytes * REJECTED_SHRINK);
		const newLimit = candidate < current ? candidate : undefined;
		if (newLimit !== undefined) {
			learnedByModel.set(model, newLimit);
			notify(ctx, text.learned(formatBytes(bytes), formatBytes(newLimit)), "warning");
		}
		pendingRejection = { model, rejectedBytes: bytes, newLimit };
	};

	pi.on("after_provider_response", (event, ctx) => {
		if (!active()) return;
		if (event.status === 413) recordRejection(ctx, lastPayloadBytes);
		else if (event.status < 400) pendingRejection = undefined;
	});

	pi.on("agent_before_settle", (event, ctx) => {
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
		// Some gateways hide the status behind a 200 stream or a wrapped error; fall back to the text.
		if (!pendingRejection && errorEntryId && errorMessage && TOO_LARGE_PATTERN.test(errorMessage)) {
			recordRejection(ctx, lastPayloadBytes);
		}
		const rejection = pendingRejection;
		if (!rejection) return;
		pendingRejection = undefined;

		const drafts: Array<{ type: "custom"; customType: string; data: LearnedEntry } | { type: "context_edit"; targetId: string; replacement: null }> = [];
		if (rejection.newLimit !== undefined) {
			drafts.push({ type: "custom", customType: ENTRY_TYPE, data: { model: rejection.model, maxRequestBytes: rejection.newLimit } });
		}

		const limits = limitsFor(ctx.model);
		const retryPlan = planImageBudget({
			messages: event.context.contextMessages.filter((message) => {
				const candidate = message as { role?: string; stopReason?: string };
				return !(candidate.role === "assistant" && candidate.stopReason === "error");
			}) as unknown as MessageLike[],
			limits,
			overheadBytes: overheadByModel.get(rejection.model) ?? loaded.config.initialOverheadBytes,
			sticky: new Map(sticky),
		});
		// Retrying only helps when the tightened budget actually produces a smaller request.
		const shrinks = retryPlan.stats.estimatedRequestBytes < rejection.rejectedBytes * REJECTED_SHRINK && !retryPlan.stats.overBudget;
		const canRetry =
			loaded.config.autoRecover &&
			errorEntryId !== undefined &&
			recoveriesSinceInput < loaded.config.maxAutoRecoveries &&
			shrinks;
		if (canRetry) {
			recoveriesSinceInput += 1;
			// Dropping the failed assistant turn from context lets Pi continue from the last user/tool message.
			drafts.push({ type: "context_edit", targetId: errorEntryId!, replacement: null });
			notify(ctx, text.recovering(formatBytes(limits.maxRequestBytes)), "warning");
			return { entries: drafts, continue: true };
		}
		if (!shrinks) notify(ctx, text.cannotRecover, "error");
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
				`image bytes ≤ ${formatBytes(limits.maxImageBytes)}, request ≤ ${formatBytes(limits.maxRequestBytes)}` +
				`${learned !== undefined ? " (learned from 413)" : ""}, protect newest ${limits.protectRecent}, ` +
				`low watermark ${limits.lowWatermark}`,
		];
		const stats = lastPlan?.stats;
		if (stats) {
			const reasons = Object.entries(stats.reasons)
				.map(([reason, value]) => `${reason} ${value}`)
				.join(", ");
			lines.push(
				`Last request: ${stats.keptImages}/${stats.totalImages} images kept, image bytes ${formatBytes(stats.keptImageBytes)}, ` +
					`request ≈ ${formatBytes(stats.estimatedRequestBytes)}` +
					`${lastPayloadBytes !== undefined ? ` (measured ${formatBytes(lastPayloadBytes)})` : ""}` +
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
					if (learnedByModel.delete(model)) pi.appendEntry(ENTRY_TYPE, { model });
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
