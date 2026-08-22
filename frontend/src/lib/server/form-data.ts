/**
 * @file parseMultipartFormData — shared multipart body parsing for upload
 * routes that surfaces SvelteKit's body-size-limit rejection as a real 413.
 *
 * adapter-node enforces BODY_SIZE_LIMIT (default 512K) by erroring the request
 * stream mid-read when the content length exceeds it; undici's
 * `request.formData()` then rejects with that error object verbatim. The old
 * per-route `catch {} → 400 "Expected multipart"` mis-reported oversized
 * uploads (notebooks, PDFs, backups are routinely larger than 512K) as
 * malformed bodies. This helper rethrows the 413 so the teacher sees the real
 * cause, keeping the generic 400 only for genuinely malformed bodies.
 */

import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

/**
 * Parse a multipart/form-data request body.
 *
 * @param event the request event (its `.request.formData()` is consumed)
 * @param badRequestMessage fallback message for genuinely invalid bodies
 * @throws SvelteKitError 413 when the body exceeds BODY_SIZE_LIMIT (message
 *         preserved from the adapter), 400 with `badRequestMessage` otherwise
 */
export async function parseMultipartFormData(
	event: RequestEvent,
	badRequestMessage = "Expected a multipart/form-data body",
): Promise<FormData> {
	try {
		return await event.request.formData();
	} catch (err) {
		if (err instanceof Error && (err as { status?: unknown }).status === 413) {
			throw error(413, err.message);
		}
		throw error(400, badRequestMessage);
	}
}
