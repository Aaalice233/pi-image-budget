import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Effective limits for one provider request. `Infinity` means "no limit".
 * All byte values measure serialized JSON bytes; image bytes are the base64 payload length,
 * which is exactly what travels on the wire.
 */
export interface BudgetLimits {
	/** Maximum images kept across one request. */
	maxImages: number;
	/** Maximum images kept inside one conversation message. */
	maxImagesPerMessage: number;
	/** Maximum total base64 bytes of the kept images. */
	maxImageBytes: number;
	/** Hard cap for one image's base64 size; larger images are downscaled (Anthropic rejects > 5 MB). */
	maxBytesPerImage: number;
	/** Hard cap for an image's width and height in pixels; larger images are downscaled. */
	maxImageDimension: number;
	/**
	 * Re-encode images outside the protected newest ones to `compressMaxDimension` / `compressMaxBytes`
	 * before any are dropped, so far more of them fit in the same budget.
	 */
	compress: boolean;
	compressMaxDimension: number;
	compressMaxBytes: number;
	/** Maximum estimated size of the whole provider request body. */
	maxRequestBytes: number;
	/** The newest N images are never removed by count/size budgets. */
	protectRecent: number;
	/**
	 * When a limit is exceeded, evict down to `limit * lowWatermark` instead of just below the limit.
	 * Batch eviction keeps the request prefix stable for more turns, so provider prompt caches survive.
	 */
	lowWatermark: number;
	/** Replace earlier copies of byte-identical images with a placeholder. */
	dedupe: boolean;
}

export interface BudgetConfig extends BudgetLimits {
	enabled: boolean;
	/** Last-resort scrub of the provider payload when the measured body still exceeds the limit. */
	payloadGuard: boolean;
	/** After an HTTP 413, lower this session's request limit and retry automatically. */
	autoRecover: boolean;
	/** Maximum automatic 413 recoveries in one agent run. */
	maxAutoRecoveries: number;
	/** Request overhead assumed before the first real payload has been measured. */
	initialOverheadBytes: number;
	/** Show kept/omitted image counts in the footer. */
	showStatus: boolean;
	locale: "auto" | "en" | "zh-CN";
	/** Per-model overrides keyed by `provider/modelId` glob, e.g. `"yuan/*"` or `"*\/claude-*"`. */
	models: Record<string, Partial<BudgetLimits>>;
}

export const MiB = 1024 * 1024;

export const DEFAULT_CONFIG: BudgetConfig = {
	enabled: true,
	maxImages: 12,
	maxImagesPerMessage: Infinity,
	maxImageBytes: 16 * MiB,
	maxBytesPerImage: Math.floor(4.5 * MiB),
	maxImageDimension: 2000,
	compress: true,
	compressMaxDimension: 1280,
	compressMaxBytes: 400 * 1024,
	maxRequestBytes: 24 * MiB,
	protectRecent: 2,
	lowWatermark: 0.75,
	dedupe: true,
	payloadGuard: true,
	autoRecover: true,
	maxAutoRecoveries: 2,
	initialOverheadBytes: 512 * 1024,
	showStatus: true,
	locale: "auto",
	models: {},
};

const SIZE_KEYS = new Set(["maxImageBytes", "maxRequestBytes", "maxBytesPerImage", "compressMaxBytes", "initialOverheadBytes"]);
const COUNT_KEYS = new Set([
	"maxImages",
	"maxImagesPerMessage",
	"maxImageDimension",
	"compressMaxDimension",
	"protectRecent",
	"maxAutoRecoveries",
]);
const BOOL_KEYS = new Set(["enabled", "dedupe", "compress", "payloadGuard", "autoRecover", "showStatus"]);
const LIMIT_KEYS = new Set([
	"maxImages",
	"maxImagesPerMessage",
	"maxImageBytes",
	"maxRequestBytes",
	"maxBytesPerImage",
	"maxImageDimension",
	"compress",
	"compressMaxDimension",
	"compressMaxBytes",
	"protectRecent",
	"lowWatermark",
	"dedupe",
]);

const UNITS: Record<string, number> = { "": 1, b: 1, k: 1024, kb: 1024, kib: 1024, m: MiB, mb: MiB, mib: MiB, g: 1024 * MiB, gb: 1024 * MiB, gib: 1024 * MiB };

/**
 * Parses `24MB`, `"512 KiB"`, `1048576` or `null` (= unlimited).
 * K/M/G are binary (1024-based) because gateway limits such as "32MB" are almost always MiB;
 * reading them as decimal would overshoot by ~5%.
 */
export function parseSize(value: unknown): number {
	if (value === null || value === "unlimited" || value === "off") return Infinity;
	if (typeof value === "number" && Number.isSafeInteger(Math.floor(value)) && value >= 0) return Math.floor(value);
	if (typeof value === "string") {
		const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value);
		const unit = match ? UNITS[match[2]!.toLowerCase()] : undefined;
		if (match && unit !== undefined) {
			const bytes = Math.floor(Number(match[1]) * unit);
			if (Number.isSafeInteger(bytes)) return bytes;
		}
	}
	throw new Error(`invalid size ${JSON.stringify(value)} (use e.g. "24MB", "512KB", a byte count, or null)`);
}

function parseCount(value: unknown): number {
	if (value === null || value === "unlimited" || value === "off") return Infinity;
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
	throw new Error(`invalid count ${JSON.stringify(value)} (use a non-negative integer or null)`);
}

function parseValue(key: string, value: unknown): unknown {
	if (["maxBytesPerImage", "compressMaxBytes", "maxImageDimension", "compressMaxDimension", "initialOverheadBytes", "protectRecent", "maxAutoRecoveries"].includes(key)) {
		const parsed = SIZE_KEYS.has(key) ? parseSize(value) : parseCount(value);
		const min = ["maxBytesPerImage", "compressMaxBytes", "maxImageDimension", "compressMaxDimension"].includes(key) ? 1 : 0;
		if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`expected a finite value ≥ ${min}`);
		return parsed;
	}
	if (SIZE_KEYS.has(key)) return parseSize(value);
	if (COUNT_KEYS.has(key)) return parseCount(value);
	if (BOOL_KEYS.has(key)) {
		if (typeof value === "boolean") return value;
		throw new Error(`expected true/false, got ${JSON.stringify(value)}`);
	}
	if (key === "lowWatermark") {
		if (typeof value === "number" && value > 0 && value <= 1) return value;
		throw new Error(`expected a number in (0, 1], got ${JSON.stringify(value)}`);
	}
	if (key === "locale") {
		if (value === "auto" || value === "en" || value === "zh-CN") return value;
		throw new Error(`expected "auto", "en" or "zh-CN", got ${JSON.stringify(value)}`);
	}
	throw new Error("unknown option");
}

/** Validates one raw layer. Invalid entries are reported and skipped; they never abort loading. */
export function parseLayer(raw: unknown, origin: string, errors: string[]): Partial<BudgetConfig> {
	const out: Partial<BudgetConfig> = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		errors.push(`${origin}: top level must be a JSON object`);
		return out;
	}
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (key === "$schema") continue;
		if (key === "models") {
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				errors.push(`${origin}: "models" must be an object of glob -> overrides`);
				continue;
			}
			const models: Record<string, Partial<BudgetLimits>> = {};
			for (const [pattern, overrides] of Object.entries(value as Record<string, unknown>)) {
				if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
					errors.push(`${origin}: models["${pattern}"] must be an object`);
					continue;
				}
				const entry: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
					if (!LIMIT_KEYS.has(k)) {
						errors.push(`${origin}: models["${pattern}"].${k}: not a per-model option`);
						continue;
					}
					try {
						entry[k] = parseValue(k, v);
					} catch (error) {
						errors.push(`${origin}: models["${pattern}"].${k}: ${(error as Error).message}`);
					}
				}
				models[pattern] = entry as Partial<BudgetLimits>;
			}
			out.models = models;
			continue;
		}
		try {
			(out as Record<string, unknown>)[key] = parseValue(key, value);
		} catch (error) {
			errors.push(`${origin}: ${key}: ${(error as Error).message}`);
		}
	}
	return out;
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export interface LoadedConfig {
	config: BudgetConfig;
	sources: string[];
	errors: string[];
}

/** Global `<agentDir>/image-budget.json`, then project `<cwd>/.pi/image-budget.json` on top. */
export function loadConfig(cwd: string, projectTrusted: boolean): LoadedConfig {
	const errors: string[] = [];
	const sources: string[] = [];
	let config: BudgetConfig = { ...DEFAULT_CONFIG, models: {} };
	const files = [join(agentDir(), "image-budget.json")];
	if (projectTrusted) files.push(join(cwd, ".pi", "image-budget.json"));
	for (const file of files) {
		if (!existsSync(file)) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			errors.push(`${file}: ${(error as Error).message}`);
			continue;
		}
		const layer = parseLayer(raw, file, errors);
		config = { ...config, ...layer, models: { ...config.models, ...(layer.models ?? {}) } };
		sources.push(file);
	}
	return { config, sources, errors };
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

export interface ModelLike {
	provider?: string;
	id?: string;
	inputLimits?: {
		maxRequestBytes?: number;
		images?: {
			maxPerMessage?: number;
			maxPerRequest?: number;
			resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number };
		};
	};
}

/**
 * Resolves limits for one model: defaults/config, then matching `models` globs in file order,
 * then hard caps declared by the model catalog (`inputLimits`), which Pi documents but does not enforce.
 * Catalog caps only ever tighten the result.
 */
export function resolveLimits(config: BudgetConfig, model: ModelLike | undefined): BudgetLimits {
	const limits: BudgetLimits = {
		maxImages: config.maxImages,
		maxImagesPerMessage: config.maxImagesPerMessage,
		maxImageBytes: config.maxImageBytes,
		maxRequestBytes: config.maxRequestBytes,
		maxBytesPerImage: config.maxBytesPerImage,
		maxImageDimension: config.maxImageDimension,
		compress: config.compress,
		compressMaxDimension: config.compressMaxDimension,
		compressMaxBytes: config.compressMaxBytes,
		protectRecent: config.protectRecent,
		lowWatermark: config.lowWatermark,
		dedupe: config.dedupe,
	};
	const key = `${model?.provider ?? ""}/${model?.id ?? ""}`;
	for (const [pattern, overrides] of Object.entries(config.models)) {
		if (globToRegExp(pattern).test(key)) Object.assign(limits, overrides);
	}
	const catalog = model?.inputLimits;
	if (typeof catalog?.maxRequestBytes === "number" && catalog.maxRequestBytes >= 0) limits.maxRequestBytes = Math.min(limits.maxRequestBytes, catalog.maxRequestBytes);
	if (typeof catalog?.images?.maxPerRequest === "number" && catalog.images.maxPerRequest >= 0) limits.maxImages = Math.min(limits.maxImages, catalog.images.maxPerRequest);
	if (typeof catalog?.images?.maxPerMessage === "number" && catalog.images.maxPerMessage >= 0) {
		limits.maxImagesPerMessage = Math.min(limits.maxImagesPerMessage, catalog.images.maxPerMessage);
	}
	const resize = catalog?.images?.resize;
	const catalogDimension = Math.min(resize?.maxWidth || Infinity, resize?.maxHeight || Infinity);
	limits.maxImageDimension = Math.min(limits.maxImageDimension, catalogDimension);
	if (resize?.maxBytes) limits.maxBytesPerImage = Math.min(limits.maxBytesPerImage, resize.maxBytes);
	return limits;
}

export function modelKey(model: ModelLike | undefined): string {
	return `${model?.provider ?? "?"}/${model?.id ?? "?"}`;
}
