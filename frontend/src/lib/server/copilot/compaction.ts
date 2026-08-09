/**
 * @file Automatic thread compaction (Task V).
 *
 * When a thread outgrows the recall window, the older messages fall outside
 * the model's context. `maybeCompactThread` summarizes those out-of-window
 * messages with the LLM (`Memory.summarizeThread` — Mastra's non-destructive
 * Observational-Memory Observer) and stores the summary in the thread's
 * metadata. The chat loop (agent.ts runChat) then injects the summary as a
 * system message on later turns (`opts.system`), so the model keeps
 * continuity beyond the window. Raw messages are KEPT — the thread stays a
 * full audit trail; the summary is a compressed proxy for the dropped window.
 *
 * Trigger (derived from settings — no new knobs):
 *   - first compaction when messageCount >= lastMessages * 2
 *   - re-compact only when the thread has grown by lastMessages messages
 *     since the last summary (messageCount - summarizedUpTo >= lastMessages)
 *
 * The check runs at the START of a chat turn, before the user message is
 * streamed — the crossing turn waits a few seconds and then answers WITH the
 * fresh summary. `copilot.autoCompact: false` disables compaction entirely
 * (cost guard: each summarization is an extra LLM call).
 *
 * Best-effort: never throws into the chat path — callers (runChat) wrap the
 * call in try/catch. A concurrent guard (`compactingThreads`) prevents two
 * tabs from double-summarizing the same thread.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { Memory, type SummarizeModel } from "@mastra/memory";

import { FileMemoryStore } from "./file-memory";
import { resolveSummarySizeTokens, resolveSummaryTokenCap } from "./model-context";
import type { CopilotSettings } from "../settings";

// ---------------------------------------------------------------------------
// Concurrency guard
// ---------------------------------------------------------------------------

/** Threads currently being summarized — prevents concurrent double-summarization. */
const compactingThreads = new Set<string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CompactResult = { compacted: false } | { compacted: true; summary: string };

export interface MaybeCompactOptions {
	threadId: string;
	resourceId: string;
	settings: CopilotSettings;
	/**
	 * Model that runs the summarization (the app's `createModel(settings)`
	 * instance — the same model family the Agent accepts; the Observer wraps
	 * it in its own internal Agent). Optional when `summarize` is injected.
	 */
	model: SummarizeModel;
	/** Model id — selects the model-aware input cap + summary size cap. */
	modelId: string;
	/**
	 * Injectable for tests. Defaults to `Memory.summarizeThread` on a fresh
	 * composite store whose memory domain is the shared FileMemoryStore.
	 */
	summarize?: (opts: { threadId: string; resourceId: string }) => Promise<{ summary: string }>;
}

/**
 * Compact a thread when it outgrows the recall window. Returns
 * `{ compacted: true, summary }` when a summary was produced and stored;
 * `{ compacted: false }` when compaction is disabled, the thread is missing,
 * below threshold, or already being compacted.
 */
export async function maybeCompactThread(options: MaybeCompactOptions): Promise<CompactResult> {
	const { threadId, resourceId, settings, modelId } = options;
	// Cost guard: autoCompact: false disables the extra LLM calls entirely.
	if (!settings.autoCompact) return { compacted: false };

	const store = new FileMemoryStore();
	const thread = await store.getThreadById({ threadId, resourceId });
	if (!thread) return { compacted: false };

	const { messages } = await store.listMessages({ threadId, perPage: false });
	const messageCount = messages.length;
	const metadata = thread.metadata ?? {};
	const summarizedUpTo =
		typeof metadata.summarizedUpTo === "number" ? metadata.summarizedUpTo : 0;

	// First compaction at 2x the recall window; re-compact only after the
	// thread has grown by a full window since the last summary.
	if (messageCount < settings.lastMessages * 2) return { compacted: false };
	if (messageCount - summarizedUpTo < settings.lastMessages) return { compacted: false };

	// Concurrent guard: add before the call, release in finally. Two tabs
	// sending turns at the same moment must not double-summarize.
	if (compactingThreads.has(threadId)) return { compacted: false };
	compactingThreads.add(threadId);
	try {
		// The injectable summarize only needs the ids; the default closes
		// over the model + modelId for the model-aware budgets.
		const summarize =
			options.summarize ??
			((ids: { threadId: string; resourceId: string }) =>
				defaultSummarize({ ...ids, model: options.model, modelId }));
		const { summary } = await summarize({ threadId, resourceId });
		// Size-cap the stored summary (~5% of the model's context, chars/4
		// matches the U.3 estimate heuristic). A verbose summary injected as
		// opts.system every turn would eat the context it is supposed to save.
		const capChars = resolveSummarySizeTokens(modelId) * 4;
		const cappedSummary = summary.length > capChars ? summary.slice(0, capChars) : summary;
		// The adapter MERGES metadata, so summaryCount keeps counting across
		// compactions. The summary itself is replaced on every re-compaction.
		await store.updateThread({
			id: threadId,
			title: thread.title ?? "",
			metadata: {
				summary: cappedSummary,
				summarizedUpTo: messageCount,
				summaryCount:
					(typeof metadata.summaryCount === "number" ? metadata.summaryCount : 0) + 1,
				lastSummaryAt: new Date().toISOString(),
			},
		});
		return { compacted: true, summary: cappedSummary };
	} finally {
		compactingThreads.delete(threadId);
	}
}

// ---------------------------------------------------------------------------
// Default summarizer
// ---------------------------------------------------------------------------

/**
 * Run Mastra's Observational-Memory Observer over the thread's messages.
 * Non-destructive: summarizeThread returns the summary string and writes
 * nothing to memory — WE own the storage side (metadata update above).
 *
 * The Memory is built on a FRESH composite store (id "copilot-compaction")
 * whose memory domain is the shared FileMemoryStore — the summarizer must
 * read the same messages the chat loop persisted. A raw domain store would
 * fail at first save (runtime resolves storage.getStore("memory")); the
 * shared-memory type is SharedMemoryConfig.storage, which is exactly this
 * composite shape.
 */
async function defaultSummarize(opts: {
	threadId: string;
	resourceId: string;
	model: SummarizeModel;
	modelId: string;
}): Promise<{ summary: string }> {
	const storage = new MastraCompositeStore({
		id: "copilot-compaction",
		default: new InMemoryStore(),
		domains: { memory: new FileMemoryStore() },
	});
	const memory = new Memory({ storage });
	const result = await memory.summarizeThread({
		threadId: opts.threadId,
		resourceId: opts.resourceId,
		model: opts.model,
		// Model-aware input cap (~80% of context, <= 100k): a small-context
		// model never receives a summarization input larger than it can hold.
		maxInputTokens: resolveSummaryTokenCap(opts.modelId),
	});
	return { summary: result.summary };
}
