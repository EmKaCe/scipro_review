/**
 * @file GET /api/copilot/threads — list the threads of one scope.
 *
 * Scope query: ?submissionId=X (submission panel) or ?assignmentId=Y
 * (dashboard panel) — at least one is required (400 otherwise). The server
 * module enforces scope isolation: only threads whose resourceId matches the
 * requested scope are returned.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { z } from "zod";

import { listThreads } from "$lib/server/copilot/threads";

const scopeQuerySchema = z
	.object({
		submissionId: z.string().min(1).optional(),
		assignmentId: z.string().min(1).optional(),
	})
	.refine((scope) => scope.submissionId !== undefined || scope.assignmentId !== undefined, {
		message: "submissionId or assignmentId must be provided (at least one)",
	});

export async function GET(event: RequestEvent): Promise<Response> {
	const parsed = scopeQuerySchema.safeParse(Object.fromEntries(event.url.searchParams));
	if (!parsed.success) {
		error(400, "submissionId or assignmentId must be provided (at least one)");
	}
	const threads = await listThreads(parsed.data);
	return json({ threads });
}
