/**
 * @file File-backed Mastra memory storage domain.
 *
 * Thread + message persistence for the copilot under the app's DATA_DIR,
 * following the repo's "files are the database" pattern (results-store-style
 * atomic tmp+rename writes). The default in-memory store keeps nothing
 * across restarts; this adapter makes chat threads survive process restarts.
 *
 * Layout under DATA_DIR:
 *   copilot/memory/threads/<threadId>.json    — one StorageThreadType per file
 *   copilot/memory/messages/<threadId>.json   — one MastraDBMessage[] per file
 *
 * Date fields (createdAt/updatedAt) are serialized as ISO strings by
 * JSON.stringify and re-hydrated to Date on read via a reviver — critical for
 * Mastra's createdAt ordering in listMessages.
 *
 * Only the abstract MemoryStorage methods are implemented; the inherited
 * non-abstract members (init no-op, listMessagesByResourceId/deleteMessages/
 * cloneThread throwing defaults, observational-memory methods) are left at
 * their base-class behavior.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { MemoryStorage } from "@mastra/core/storage";
import type {
	StorageListMessagesInput,
	StorageListMessagesOutput,
	StorageListThreadsInput,
	StorageListThreadsOutput,
} from "@mastra/core/storage";
import type { MastraDBMessage, StorageThreadType } from "@mastra/core/memory";

import { assertSafeSegment, getDataDir } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function threadsDir(): string {
	return path.join(getDataDir(), "copilot", "memory", "threads");
}

function messagesDir(): string {
	return path.join(getDataDir(), "copilot", "memory", "messages");
}

/** Sanitize a thread id for use as a file name (client-supplied ids). */
function threadFileName(threadId: string): string {
	assertSafeSegment(threadId, "threadId");
	return `${threadId}.json`;
}

// ---------------------------------------------------------------------------
// JSON helpers (atomic writes + Date re-hydration)
// ---------------------------------------------------------------------------

const DATE_KEYS = new Set(["createdAt", "updatedAt"]);

/** JSON reviver: ISO date strings under known keys become Date instances. */
function reviver(_key: string, value: unknown): unknown {
	if (typeof value === "string" && DATE_KEYS.has(_key) && !Number.isNaN(Date.parse(value))) {
		return new Date(value);
	}
	return value;
}

async function readJson<T>(file: string): Promise<T | null> {
	try {
		const raw = await readFile(file, "utf8");
		return JSON.parse(raw, reviver) as T;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, "\t"));
	await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// FileMemoryStore
// ---------------------------------------------------------------------------

export class FileMemoryStore extends MemoryStorage {
	// -- threads ------------------------------------------------------------

	async getThreadById({
		threadId,
		resourceId,
	}: {
		threadId: string;
		resourceId?: string;
	}): Promise<StorageThreadType | null> {
		const thread = await readJson<StorageThreadType>(
			path.join(threadsDir(), threadFileName(threadId)),
		);
		if (!thread) return null;
		if (resourceId !== undefined && thread.resourceId !== resourceId) return null;
		return thread;
	}

	async saveThread({ thread }: { thread: StorageThreadType }): Promise<StorageThreadType> {
		// Merge with the existing thread instead of blind-overwriting: Mastra
		// calls saveThread with a STALE thread object (e.g. the agent's
		// onStepFinish/onFinish createThread re-save, which carries the
		// thread as it was at prepare-memory-step time) AFTER the
		// updateWorkingMemory tool wrote metadata.workingMemory via
		// updateThread. A blind overwrite would clobber the working memory.
		// updateThread already merges; saveThread must too (same file).
		const file = path.join(threadsDir(), threadFileName(thread.id));
		const existing = await readJson<StorageThreadType>(file);
		if (existing) {
			const merged: StorageThreadType = {
				...existing,
				...thread,
				// Mastra's createThread re-save regenerates createdAt — keep
				// the original creation time.
				createdAt: existing.createdAt ?? thread.createdAt,
				// The incoming thread may carry stale/empty metadata (Mastra
				// re-saves the prepare-memory-step snapshot) — keep the
				// stored metadata keys the incoming one doesn't set.
				metadata: { ...existing.metadata, ...thread.metadata },
				updatedAt: new Date(),
			};
			await writeJsonAtomic(file, merged);
			return merged;
		}
		await writeJsonAtomic(file, thread);
		return thread;
	}

	async updateThread({
		id,
		title,
		metadata,
	}: {
		id: string;
		title: string;
		metadata: Record<string, unknown>;
	}): Promise<StorageThreadType> {
		const file = path.join(threadsDir(), threadFileName(id));
		const existing = (await readJson<StorageThreadType>(file)) ?? {
			id,
			resourceId: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		const updated: StorageThreadType = {
			...existing,
			title: title !== undefined ? title : existing.title,
			metadata: { ...existing.metadata, ...metadata },
			updatedAt: new Date(),
		};
		await writeJsonAtomic(file, updated);
		return updated;
	}

	async deleteThread({ threadId }: { threadId: string }): Promise<void> {
		const name = threadFileName(threadId);
		await rm(path.join(threadsDir(), name), { force: true });
		await rm(path.join(messagesDir(), name), { force: true });
	}

	async listThreads(args: StorageListThreadsInput): Promise<StorageListThreadsOutput> {
		const all = await readAllThreads();
		const filtered = all.filter((t) => {
			if (args.filter?.resourceId && t.resourceId !== args.filter.resourceId) return false;
			if (args.filter?.metadata) {
				for (const [key, value] of Object.entries(args.filter.metadata)) {
					if (t.metadata?.[key] !== value) return false;
				}
			}
			return true;
		});
		const perPage = args.perPage === false ? Number.MAX_SAFE_INTEGER : (args.perPage ?? 100);
		const page = args.page ?? 0;
		const direction = args.orderBy?.direction === "DESC" ? -1 : 1;
		const field = args.orderBy?.field === "updatedAt" ? "updatedAt" : "createdAt";
		filtered.sort((a, b) => direction * (a[field].getTime() - b[field].getTime()));
		const start = page * perPage;
		const threads = filtered.slice(start, start + perPage);
		return {
			threads,
			total: filtered.length,
			page,
			perPage: args.perPage === false ? false : perPage,
			hasMore: start + perPage < filtered.length,
		};
	}

	// -- messages -----------------------------------------------------------

	async listMessages(args: StorageListMessagesInput): Promise<StorageListMessagesOutput> {
		const threadIds = Array.isArray(args.threadId) ? args.threadId : [args.threadId];
		const all = (
			await Promise.all(threadIds.map((id) => readJson<MastraDBMessage[]>(messagesFile(id))))
		)
			.flat()
			.filter((m): m is MastraDBMessage => m !== null);

		const filtered = all.filter((m) => {
			if (args.resourceId && m.resourceId !== args.resourceId) return false;
			if (args.filter?.dateRange) {
				const { start, end } = args.filter.dateRange;
				if (start && m.createdAt < start) return false;
				if (end && m.createdAt > end) return false;
			}
			return true;
		});

		// Honor the requested direction: Mastra's recall asks for
		// the NEWEST N messages (createdAt DESC + perPage) to build the
		// lastMessages window. Sorting always ascending made the store
		// paginate the OLDEST N instead — the rolling window silently showed
		// the first messages of a thread, not the last. Same pattern as
		// listThreads above; callers without orderBy keep chronological order.
		const direction = args.orderBy?.direction === "DESC" ? -1 : 1;
		filtered.sort((a, b) => direction * (a.createdAt.getTime() - b.createdAt.getTime()));
		const perPage = args.perPage === false ? Number.MAX_SAFE_INTEGER : (args.perPage ?? 40);
		const page = args.page ?? 0;
		const start = page * perPage;
		const messages = filtered.slice(start, start + perPage);
		return {
			messages,
			total: filtered.length,
			page,
			perPage: args.perPage === false ? false : perPage,
			hasMore: start + perPage < filtered.length,
		};
	}

	async listMessagesById({ messageIds }: { messageIds: string[] }): Promise<{
		messages: MastraDBMessage[];
	}> {
		const wanted = new Set(messageIds);
		const all = (await readAllMessages()).filter((m) => wanted.has(m.id));
		return { messages: all };
	}

	async saveMessages(args: {
		messages: MastraDBMessage[];
	}): Promise<{ messages: MastraDBMessage[] }> {
		const byThread = new Map<string, MastraDBMessage[]>();
		for (const message of args.messages) {
			const threadId = message.threadId ?? "";
			const list = byThread.get(threadId) ?? [];
			list.push(message);
			byThread.set(threadId, list);
		}
		for (const [threadId, incoming] of byThread) {
			const file = messagesFile(threadId);
			const existing = (await readJson<MastraDBMessage[]>(file)) ?? [];
			const byId = new Map(existing.map((m) => [m.id, m]));
			for (const message of incoming) byId.set(message.id, message);
			await writeJsonAtomic(file, [...byId.values()]);
		}
		return { messages: args.messages };
	}

	async updateMessages(args: {
		messages: (Partial<Omit<MastraDBMessage, "createdAt">> & {
			id: string;
			content?: { metadata?: unknown; content?: unknown };
		})[];
	}): Promise<MastraDBMessage[]> {
		const updated: MastraDBMessage[] = [];
		const files = (await listMessageFiles()).map((f) => path.join(messagesDir(), f));
		for (const file of files) {
			const messages = (await readJson<MastraDBMessage[]>(file)) ?? [];
			let changed = false;
			for (const patch of args.messages) {
				const idx = messages.findIndex((m) => m.id === patch.id);
				if (idx === -1) continue;
				const merged: MastraDBMessage = {
					...messages[idx],
					...(patch as unknown as MastraDBMessage),
					content: (patch.content?.content ??
						messages[idx].content) as MastraDBMessage["content"],
				};
				if (patch.content?.metadata !== undefined) {
					const current = (messages[idx].content as { metadata?: unknown } | null)
						?.metadata;
					(merged.content as { metadata?: unknown }).metadata = {
						...(current as Record<string, unknown> | undefined),
						...(patch.content.metadata as Record<string, unknown>),
					};
				}
				messages[idx] = merged;
				updated.push(merged);
				changed = true;
			}
			if (changed) await writeJsonAtomic(file, messages);
		}
		return updated;
	}

	// -- housekeeping -------------------------------------------------------

	async dangerouslyClearAll(): Promise<void> {
		await rm(threadsDir(), { recursive: true, force: true });
		await rm(messagesDir(), { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function messagesFile(threadId: string): string {
	return path.join(messagesDir(), threadFileName(threadId));
}

async function listMessageFiles(): Promise<string[]> {
	try {
		return (await readdir(messagesDir())).filter((f) => f.endsWith(".json"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

async function readAllMessages(): Promise<MastraDBMessage[]> {
	const files = await listMessageFiles();
	const lists = await Promise.all(
		files.map((f) => readJson<MastraDBMessage[]>(path.join(messagesDir(), f))),
	);
	return lists.flat().filter((m): m is MastraDBMessage => m !== null);
}

async function readAllThreads(): Promise<StorageThreadType[]> {
	let files: string[];
	try {
		files = (await readdir(threadsDir())).filter((f) => f.endsWith(".json"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const threads = await Promise.all(
		files.map((f) => readJson<StorageThreadType>(path.join(threadsDir(), f))),
	);
	return threads.filter((t): t is StorageThreadType => t !== null);
}
