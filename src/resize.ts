import { createHash } from "node:crypto";

export interface ResizeSpec { maxDimension: number; maxBytes: number }
export interface ImageVariant {
	data: string;
	mimeType: string;
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
}
export type ResizeFunction = (
	input: Uint8Array, mimeType: string,
	options: { maxWidth: number; maxHeight: number; maxBytes: number },
) => Promise<ImageVariant | null>;
export interface ProcessorOptions {
	resize: ResizeFunction;
	concurrency?: number;
	memoryEntries?: number;
	maxCacheBytes?: number;
	onFailure?: (message: string) => void;
}

/**
 * A bounded in-memory cache: screenshots are not copied to another persistent disk location.
 * Hash the complete content (not samples or message IDs), and include MIME and target in the key.
 * Pi's public resizeImage owns the worker lifecycle. It has no cancellation API, so we don't fake a
 * timeout that releases the slot while the worker is still consuming CPU. At most two jobs run.
 */
export class ImageProcessor {
	private readonly options: ProcessorOptions;
	private readonly memory = new Map<string, ImageVariant | null>();
	private readonly inflight = new Map<string, Promise<ImageVariant | null>>();
	private readonly queue: Array<() => void> = [];
	private running = 0;
	private bytes = 0;
	constructor(options: ProcessorOptions) { this.options = options; }

	hashOf(_key: string, data: string): string {
		return createHash("sha256").update(data).digest("hex");
	}

	process(hash: string, data: string, mimeType: string, spec: ResizeSpec): Promise<ImageVariant | null> {
		const id = `${hash}:${mimeType}:${spec.maxDimension}:${spec.maxBytes}`;
		if (this.memory.has(id)) {
			const hit = this.memory.get(id)!;
			this.memory.delete(id);
			this.memory.set(id, hit);
			return Promise.resolve(hit);
		}
		const pending = this.inflight.get(id);
		if (pending) return pending;
		const job = this.schedule(async () => {
			try {
				const result = await this.options.resize(Buffer.from(data, "base64"), mimeType, {
					maxWidth: spec.maxDimension, maxHeight: spec.maxDimension, maxBytes: spec.maxBytes,
				});
				if (!result || !result.data.length || result.data.length > spec.maxBytes ||
					![result.width, result.height, result.originalWidth, result.originalHeight].every((n) => Number.isInteger(n) && n > 0) ||
					Math.max(result.width, result.height) > spec.maxDimension) {
					throw new Error("Decoder unavailable, invalid image, or resize target could not be met");
				}
				return result;
			} catch (error) {
				this.options.onFailure?.(error instanceof Error ? error.message : String(error));
				return null;
			}
		}).then((result) => {
			this.inflight.delete(id);
			this.memory.set(id, result);
			this.bytes += result?.data.length ?? 0;
			while (this.memory.size > (this.options.memoryEntries ?? 128) || this.bytes > (this.options.maxCacheBytes ?? 32 * 1024 * 1024)) {
				const key = this.memory.keys().next().value!;
				this.bytes -= this.memory.get(key)?.data.length ?? 0;
				this.memory.delete(key);
			}
			return result;
		});
		this.inflight.set(id, job);
		return job;
	}

	private schedule<T>(task: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const run = () => {
				this.running++;
				void task().then(resolve, reject).finally(() => {
					this.running--;
					this.queue.shift()?.();
				});
			};
			if (this.running < (this.options.concurrency ?? 2)) run();
			else this.queue.push(run);
		});
	}
}
