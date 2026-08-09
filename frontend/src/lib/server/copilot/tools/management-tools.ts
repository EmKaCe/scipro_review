/**
 * @file Copilot MANAGEMENT tools — assignment CRUD and settings writes.
 *
 * Four write tools (all `permission: "approval"`):
 *
 *   create-assignment — append an assignment to data/assignments.yaml.
 *   update-assignment — partial update; unspecified fields keep their values.
 *   delete-assignment — remove an assignment; refuses (409) while the
 *     assignment still has a submissions directory. Declared `destructive:
 *     true`, so the approval policy can never auto-approve it (HARD_DENY).
 *   update-settings   — persist the full AppSettings shape (executor, llm,
 *     copilot) to data/settings.yaml.
 *
 * Design rules (plan 4d):
 *   - These tools call the SAME services the API routes call
 *     (assignments-writer, settings writeSettings) — never re-HTTP the route.
 *   - Validation errors from the services pass through as thrown errors; the
 *     agent loop converts failures to tool result ok:false.
 *   - SECRETS: update-settings REJECTS (throws) any payload containing a
 *     key-like field (apiKey/token/secret/password/credential at any depth)
 *     instead of silently scrubbing it. Scrub would let a "success" claim
 *     disagree with what got persisted; reject is safer — the model gets a
 *     hard failure it must explain. Enforcement is two-layered:
 *       (1) every object schema is `.strict()`, so any unknown key — secrets
 *           included — fails Zod validation before run() executes
 *           (unrecognized_keys issue naming the offending key);
 *       (2) run() re-scans its parsed args as defense-in-depth: if the
 *           schema is ever relaxed, a clear error is still thrown before
 *           anything is written. Secrets stay env-only, never in settings.
 *
 * Tools have NO top-level side effects — every service call happens inside
 * run(). This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { z } from "zod";

import type { CopilotRegistry, CopilotTool } from "../registry";
import {
	createAssignment,
	deleteAssignment,
	updateAssignment,
	type AssignmentUpdateInput,
} from "$lib/server/assignments-writer";
import { loadSettings, writeSettings } from "$lib/server/settings";

// ---------------------------------------------------------------------------
// Shared arg schemas
// ---------------------------------------------------------------------------

const assignmentIdArgs = z.object({
	/** Snake_case assignment id (^[a-z0-9_]+$ enforced by the writer). */
	id: z.string().min(1),
});

const createAssignmentArgs = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	enabled: z.boolean().optional(),
	/** Known DimensionKey ids; unknown ids are rejected by the writer. */
	dimensions: z.array(z.string()).optional(),
});

const updateAssignmentArgs = z.object({
	id: z.string().min(1),
	title: z.string().min(1).optional(),
	enabled: z.boolean().optional(),
	dimensions: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// update-settings schema (mirrors the /api/settings PUT validation)
// ---------------------------------------------------------------------------

/** Finite number > 0 — mirrors the route's posInt check (z.number alone would accept Infinity). */
const positiveFinite = z.number().refine((n) => Number.isFinite(n) && n > 0, {
	message: "must be a finite positive number",
});

/**
 * Full AppSettings wire shape, `.strict()` at every level so unknown keys —
 * including key-like secrets — fail validation instead of being silently
 * stripped. Mirrors isAppSettings() in routes/api/settings/+server.ts.
 */
const updateSettingsArgs = z
	.object({
		executor: z
			.object({
				requestTimeoutMs: positiveFinite,
				notebookTimeoutMs: positiveFinite,
				cellTimeoutS: positiveFinite,
			})
			.strict(),
		llm: z
			.object({
				baseUrl: z.string().min(1),
				model: z.string().min(1),
				timeoutMs: positiveFinite,
			})
			.strict(),
		copilot: z
			.object({
				mode: z.enum(["ask", "read-only", "auto-approve-all"]),
				allowedTools: z.array(z.string()),
				denyTools: z.array(z.string()),
				approvalTtlSeconds: positiveFinite,
				sessionCap: positiveFinite,
				// Recall window: finite integer in 1-50 (matches the route guard).
				lastMessages: z
					.number()
					.int()
					.min(1)
					.max(50)
					.refine((n) => Number.isFinite(n), {
						message: "must be a finite integer between 1 and 50",
					}),
				// Automatic compaction toggle (Task V).
				autoCompact: z.boolean(),
			})
			.strict(),
	})
	.strict();

// ---------------------------------------------------------------------------
// Secret detection (defense-in-depth; see module docstring)
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERN = /api_?key|token|secret|password|credential/i;

/**
 * Recursively locate a key-like field (apiKey, access_token, clientSecret, …)
 * in a parsed payload. Returns its path ("$.llm.apiKey") or null. Same pattern
 * the context tools use to scrub get-settings output — here inverted into a
 * hard rejection for the write direction.
 */
function findSecretKey(value: unknown, path = "$"): string | null {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const found = findSecretKey(value[i], `${path}[${i}]`);
			if (found) return found;
		}
		return null;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (SECRET_KEY_PATTERN.test(key)) return `${path}.${key}`;
			const found = findSecretKey(item, `${path}.${key}`);
			if (found) return found;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const createAssignmentTool: CopilotTool<z.infer<typeof createAssignmentArgs>> = {
	name: "create-assignment",
	description:
		"Create a new assignment in data/assignments.yaml: id (snake_case, ^[a-z0-9_]+$), title, enabled, and grading dimensions. Throws on invalid ids, unknown dimensions, or duplicate ids.",
	permission: "approval",
	inputSchema: createAssignmentArgs,
	run: async (args) => createAssignment(args),
};

const updateAssignmentTool: CopilotTool<z.infer<typeof updateAssignmentArgs>> = {
	name: "update-assignment",
	description:
		"Partially update an assignment: only the provided fields (title/enabled/dimensions) change; unspecified fields keep their current values. Throws when the id is unknown or a provided field is invalid.",
	permission: "approval",
	inputSchema: updateAssignmentArgs,
	run: async (args) => {
		// Build the partial input explicitly so unspecified fields are never
		// touched — the writer only rewrites keys present in the input.
		const input: AssignmentUpdateInput = {};
		if (args.title !== undefined) input.title = args.title;
		if (args.enabled !== undefined) input.enabled = args.enabled;
		if (args.dimensions !== undefined) input.dimensions = args.dimensions;
		return updateAssignment(args.id, input);
	},
};

const deleteAssignmentTool: CopilotTool<z.infer<typeof assignmentIdArgs>> = {
	name: "delete-assignment",
	description:
		"Delete an assignment from data/assignments.yaml. Refuses (409) while the assignment still has a submissions directory on disk — move or delete submissions first. Destructive: always requires explicit approval.",
	permission: "approval",
	destructive: true,
	inputSchema: assignmentIdArgs,
	run: async (args) => {
		await deleteAssignment(args.id);
		return { deleted: args.id };
	},
};

const updateSettingsTool: CopilotTool<z.infer<typeof updateSettingsArgs>> = {
	name: "update-settings",
	description:
		"Persist the full application settings (executor timeouts, LLM endpoint/model, copilot approval policy) to data/settings.yaml and return the stored settings. API keys and secrets are never accepted — payloads containing key-like fields are rejected.",
	permission: "approval",
	inputSchema: updateSettingsArgs,
	run: async (args) => {
		// Defense-in-depth secret rejection: the strict schema already rejects
		// unknown keys before run(); this guarantees a clear error even if the
		// schema is ever relaxed. A settings payload with a key-like field
		// must NEVER be persisted — secrets stay env-only.
		const secretPath = findSecretKey(args);
		if (secretPath) {
			throw new Error(
				`update-settings: refusing to persist secret-like field at ${secretPath} — API keys and tokens stay environment-only`,
			);
		}
		await writeSettings(args);
		return loadSettings();
	},
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the four management tools on the given registry (all approval). */
export function registerManagementTools(registry: CopilotRegistry): void {
	// Idempotent: skip tools already registered (buildAgent can re-run after
	// __resetAgentForTests, and the registry rejects duplicate names).
	const existing = new Set(registry.list().map((t) => t.name));
	for (const tool of [
		createAssignmentTool,
		updateAssignmentTool,
		deleteAssignmentTool,
		updateSettingsTool,
	]) {
		if (!existing.has(tool.name)) registry.register(tool);
	}
}
