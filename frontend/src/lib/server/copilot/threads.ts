/**
 * @file Thread management API over the FileMemoryStore (Task T).
 *
 * Exposes the file-backed memory domain as a thread surface the panel can
 * list/open/delete/rename:
 *   - listThreads  — threads of one scope (submission or assignment), newest
 *     first, with derived titles (first user message) + message counts +
 *     last-message previews.
 *   - getThread    — one thread's messages mapped to the wire shape.
 *   - deleteThread / renameThread — scoped mutations.
 *
 * Scope isolation is enforced HERE and again in the API routes: a thread
 * belongs to the scope it was opened in (resourceId = submissionId for the
 * submission panel, assignmentId for the dashboard panel), and a caller can
 * never read or mutate a thread owned by another scope.
 *
 * Message shapes (Mastra 1.54): stored messages use the V2 content object
 * `{ format: 2, parts: MastraMessagePart[] }` — never a bare string or array.
 * Roles are "user" | "assistant" | "system" | "signal" (there is NO "tool"
 * role); tool info lives at `part.toolInvocation`. The wire "tool" role is
 * DERIVED here for messages whose parts are only tool-invocations.
 */

import { FileMemoryStore } from "./file-memory";
import type { MastraDBMessage } from "@mastra/core/memory";

export interface CopilotThreadMeta {
	id: string;
	title: string;
	createdAt: string; // ISO
	updatedAt: string; // ISO
	messageCount: number;
	lastPreview?: string;
}
export interface CopilotThreadMessage {
	id: string;
	role: "user" | "assistant" | "tool" | "system"; // "tool" is DERIVED (see toWireMessage)
	createdAt: string;
	text?: string;
	toolName?: string;
	ok?: boolean;
}
export interface CopilotThreadDetail extends CopilotThreadMeta {
	messages: CopilotThreadMessage[];
}

const store = new FileMemoryStore();
const TITLE_MAX = 60;
const PREVIEW_MAX = 80;

// ---------------------------------------------------------------------------
// Stored-message helpers (V2 content shape)
// ---------------------------------------------------------------------------

/** V2 text parts of a stored message (content is { format: 2, parts: [...] }). */
function textPartsOf(message: MastraDBMessage): { type: "text"; text: string }[] {
	return (message.content?.parts ?? []).filter(
		(p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string",
	);
}

/** First tool-invocation part of a stored message, if any (tool info lives here). */
function toolInvocationOf(
	message: MastraDBMessage,
): { toolName?: string; state?: string; errorText?: string } | undefined {
	const part = (message.content?.parts ?? []).find((p) => p.type === "tool-invocation");
	return part?.type === "tool-invocation" ? part.toolInvocation : undefined;
}

function textOf(message: MastraDBMessage): string {
	return textPartsOf(message)
		.map((part) => part.text)
		.join("");
}
function toolNameOf(message: MastraDBMessage): string | undefined {
	return toolInvocationOf(message)?.toolName;
}
function okOf(message: MastraDBMessage): boolean {
	const inv = toolInvocationOf(message);
	if (!inv) return true;
	// state: "completed" | "error" | "output-error" | "output-denied" |
	// "approval-requested" | ... (the ai-sdk union types the first two as
	// 'partial-call' | 'call' | 'result', so the comparison needs a cast).
	return (inv.state as string) === "completed" && !inv.errorText;
}
function truncate(text: string, max: number): string {
	const firstLine = text.split("\n")[0].trim();
	return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}
function titleFromMessages(messages: MastraDBMessage[]): string {
	const firstUser = messages.find((m) => m.role === "user");
	return firstUser ? truncate(textOf(firstUser), TITLE_MAX) : "";
}
function previewOf(message: MastraDBMessage | undefined): string | undefined {
	if (!message) return undefined;
	const text = textOf(message).trim();
	if (text) return truncate(text, PREVIEW_MAX);
	const toolName = toolNameOf(message);
	return toolName ? `Tool: ${toolName}` : undefined;
}

/**
 * Map a stored message to the wire shape:
 *   - system                    → { role: "system" }
 *   - user/assistant            → text from the V2 text parts
 *   - ONLY tool-invocations     → { role: "tool", toolName, ok } (derived)
 *   - mixed text+tool           → text wins (renders as an assistant bubble)
 */
function toWireMessage(message: MastraDBMessage): CopilotThreadMessage {
	const base = { id: message.id, createdAt: message.createdAt.toISOString() };
	if (message.role === "system") return { ...base, role: "system" };
	const parts = message.content?.parts ?? [];
	const text = textOf(message);
	const hasTool = parts.some((p) => p.type === "tool-invocation");
	if (!text && hasTool) {
		const inv = toolInvocationOf(message);
		return { ...base, role: "tool", toolName: inv?.toolName, ok: okOf(message) };
	}
	return { ...base, role: message.role === "assistant" ? "assistant" : "user", text };
}

// ---------------------------------------------------------------------------
// Exported API (scope isolation enforced here AND in the routes)
// ---------------------------------------------------------------------------

function scopeResourceId(scope: { submissionId?: string; assignmentId?: string }): string {
	return scope.submissionId ?? scope.assignmentId ?? "";
}

/** List the threads of one scope, newest-first, with derived titles + previews. */
export async function listThreads(scope: {
	submissionId?: string;
	assignmentId?: string;
}): Promise<CopilotThreadMeta[]> {
	const resourceId = scope.submissionId ?? scope.assignmentId;
	if (!resourceId) return [];
	const { threads } = await store.listThreads({
		filter: { resourceId },
		orderBy: { field: "updatedAt", direction: "DESC" },
		perPage: false,
	});
	return Promise.all(
		threads.map(async (t) => {
			const { messages } = await store.listMessages({ threadId: t.id, perPage: false });
			return {
				id: t.id,
				title: t.title || titleFromMessages(messages) || "Untitled conversation",
				createdAt: t.createdAt.toISOString(),
				updatedAt: t.updatedAt.toISOString(),
				messageCount: messages.length,
				lastPreview: previewOf(messages.at(-1)),
			};
		}),
	);
}

/** One thread's detail, or null when missing / owned by another scope. */
export async function getThread(
	threadId: string,
	scope: { submissionId?: string; assignmentId?: string },
): Promise<CopilotThreadDetail | null> {
	const thread = await store.getThreadById({ threadId });
	// Scope isolation: a thread is only visible from the scope that owns it.
	if (!thread || thread.resourceId !== scopeResourceId(scope)) return null;
	const { messages } = await store.listMessages({ threadId, perPage: false });
	return {
		id: thread.id,
		title: thread.title || titleFromMessages(messages) || "Untitled conversation",
		createdAt: thread.createdAt.toISOString(),
		updatedAt: thread.updatedAt.toISOString(),
		messageCount: messages.length,
		lastPreview: previewOf(messages.at(-1)),
		messages: messages.map(toWireMessage),
	};
}

/** Delete a thread (and its messages). False when missing / wrong scope. */
export async function deleteThread(
	threadId: string,
	scope: { submissionId?: string; assignmentId?: string },
): Promise<boolean> {
	const thread = await store.getThreadById({ threadId });
	if (!thread || thread.resourceId !== scopeResourceId(scope)) return false;
	await store.deleteThread({ threadId });
	return true;
}

/** Rename a thread (title truncated to TITLE_MAX). False when missing / wrong scope. */
export async function renameThread(
	threadId: string,
	title: string,
	scope: { submissionId?: string; assignmentId?: string },
): Promise<boolean> {
	const thread = await store.getThreadById({ threadId });
	if (!thread || thread.resourceId !== scopeResourceId(scope)) return false;
	await store.updateThread({ id: threadId, title: truncate(title, TITLE_MAX), metadata: {} });
	return true;
}
