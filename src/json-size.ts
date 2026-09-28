/**
 * Measures JSON without allocating one giant string for a multi-image request.
 * Strings with escapes use the native serializer (including lone surrogates); plain base64 takes
 * only native regex/UTF-8 scans. No sampling: a quote anywhere in a long string must count.
 * The fast walker handles JSON data; custom toJSON objects delegate to the native serializer.
 */
const ESCAPED = /["\\\u0000-\u001f\ud800-\udfff]/;
export function jsonStringSize(value: string): number {
	return ESCAPED.test(value) ? Buffer.byteLength(JSON.stringify(value)) : Buffer.byteLength(value) + 2;
}

export function jsonSize(value: unknown): number {
	const ancestors = new Set<object>();
	function visit(value: unknown): number {
		if (value === null) return 4;
		switch (typeof value) {
			case "string": return jsonStringSize(value);
			case "number": return Number.isFinite(value) ? String(value).length : 4;
			case "boolean": return value ? 4 : 5;
			case "bigint": throw new TypeError("Do not know how to serialize a BigInt");
			case "object": {
				if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
				const record = value as Record<string, unknown>;
				if (typeof record.toJSON === "function" || value instanceof Number || value instanceof String || value instanceof Boolean) {
					return Buffer.byteLength(JSON.stringify(value) ?? "");
				}
				ancestors.add(value);
				let bytes = 2;
				if (Array.isArray(value)) {
					bytes += Math.max(0, value.length - 1);
					for (const item of value) bytes += visit(item) || 4;
				} else {
					let first = true;
					for (const key of Object.keys(record)) {
						const size = visit(record[key]);
						if (!size) continue;
						bytes += (first ? 0 : 1) + jsonStringSize(key) + 1 + size;
						first = false;
					}
				}
				ancestors.delete(value);
				return bytes;
			}
			default: return 0;
		}
	}
	return visit(value);
}
