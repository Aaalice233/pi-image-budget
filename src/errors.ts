/**
 * Classifies provider/gateway errors that a smaller or leaner request can fix.
 *
 * Relays often forward images untouched, so the upstream limits surface through many different
 * wordings (and sometimes without the original HTTP status). Each kind maps to the budget that must
 * shrink; numbers quoted in the message are extracted so the learned limit matches the real one.
 */

export type RejectionKind = "request-bytes" | "image-count" | "image-bytes" | "image-dimension" | "invalid-image";

export interface Rejection {
	kind: RejectionKind;
	/** Limit quoted by the provider, in the unit of the kind (bytes, images, or pixels). */
	quotedLimit?: number;
}

const INVALID_IMAGE =
	/could not process image|invalid (?:base64 )?image|unsupported image|image[^.]{0,40}(?:corrupt|cannot be (?:decoded|processed)|failed to (?:decode|process)|is not valid)|image_parse_error|invalid_image\b/i;
const IMAGE_COUNT =
	/too many images|(?:maximum|max(?:imum)? of|at most|up to|no more than|limit of)\s*(\d+)\s*images|images?[^.]{0,30}(?:count|number)[^.]{0,30}exceed|number of images/i;
const IMAGE_DIMENSION =
	/image dimensions? (?:exceed|must|cannot|is too large)|(?:width|height)[^.]{0,40}(?:exceed|must not|cannot|max)[^.]{0,40}\d+\s*(?:px|pixels)|image[^.]{0,60}\d+\s*(?:px|pixels)/i;
const IMAGE_BYTES =
	/image[^.]{0,60}(?:exceeds?|too large|too big|larger than|size limit|maximum (?:file )?size)|image_too_large|invalid_image_(?:size|dimensions)/i;
const REQUEST_BYTES =
	/\b413\b|request[_ ]too[_ ]large|payload too large|request entity too large|exceeds the maximum size|body (?:is )?too large|request body[^.]{0,40}(?:limit|too large|exceed)|request buffer limit|maximum request size|request size (?:exceeds|limit)|content[- ]length[^.]{0,40}(?:exceed|limit)/i;

const SIZE_UNITS: Record<string, number> = { b: 1, bytes: 1, kb: 1024, kib: 1024, mb: 1024 * 1024, mib: 1024 * 1024 };

/** Parses the first "5 MB" / "5242880 bytes" style quantity. */
function quotedBytes(text: string): number | undefined {
	// A message may quote both observed and permitted sizes. Only learn a number associated with a
	// limit, never the first incidental size in the error.
	const match = /(?:limit(?: of| is)?|maximum(?: allowed)?(?: request| body| file| image)?(?: size)?|at most|exceeds?)\D{0,24}(\d+(?:\.\d+)?)\s*(bytes|b|kib|kb|mib|mb)\b/i.exec(text)
		?? /(\d+(?:\.\d+)?)\s*(bytes|b|kib|kb|mib|mb)\s+(?:maximum|limit)/i.exec(text)
		?? />\s*(\d+(?:\.\d+)?)\s*(bytes|b|kib|kb|mib|mb)\b/i.exec(text);
	if (!match) return undefined;
	const value = Number(match[1]) * SIZE_UNITS[match[2]!.toLowerCase()]!;
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function quotedPixels(text: string): number | undefined {
	const match = /(\d{3,5})\s*(?:px|pixels)/i.exec(text);
	return match ? Number(match[1]) : undefined;
}

/**
 * Returns the rejection kind for an error message and/or HTTP status, or undefined when the error is
 * unrelated to request size (rate limits, auth, overload, ...). Image-specific causes win over the
 * generic "request too large" because they need a different budget to shrink.
 */
export function classifyError(message: string | undefined, status?: number): Rejection | undefined {
	const text = message ?? "";
	if (text) {
		if (INVALID_IMAGE.test(text)) return { kind: "invalid-image" };
		const count = IMAGE_COUNT.exec(text);
		if (count) {
			const quoted = Number(count[1] ?? /max(?:imum)?(?:\s+is|\s+of|:)?\s*(\d+)/i.exec(text)?.[1]);
			return { kind: "image-count", quotedLimit: quoted > 0 ? quoted : undefined };
		}
		if (IMAGE_DIMENSION.test(text)) return { kind: "image-dimension", quotedLimit: quotedPixels(text) };
		if (IMAGE_BYTES.test(text)) return { kind: "image-bytes", quotedLimit: quotedBytes(text) };
		if (REQUEST_BYTES.test(text)) return { kind: "request-bytes", quotedLimit: quotedBytes(text) };
	}
	if (status === 413) return { kind: "request-bytes" };
	return undefined;
}
