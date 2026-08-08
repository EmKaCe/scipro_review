/**
 * @file Copilot tool registry — the single place copilot tools are declared
 * and executed.
 *
 * Tools are registered once at server startup (agent.ts wires the actual
 * grading tools). The registry owns two invariants:
 *
 *  1. Tool names are unique — registering a duplicate name throws.
 *  2. Every invocation passes through the tool's Zod inputSchema before
 *     tool.run is called, so tools can trust their args.
 *
 * `permission` ("auto" | "approval") is the tool author's declaration of how
 * the approval policy (permission.ts) treats the tool by default. `destructive`
 * marks tools that mutate or delete teacher data — the sanctioned way to
 * declare the hard-deny set; such tools always require a human in the loop.
 */

import type { ZodIssue, ZodSchema } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolPermission = "auto" | "approval";

export interface CopilotTool<Args = unknown, Result = unknown> {
	/** Unique tool name; duplicates are rejected at registration. */
	name: string;
	/** Human-readable description shown in the approval card / UI. */
	description: string;
	/** How the approval policy treats this tool by default. */
	permission: ToolPermission;
	/**
	 * Marks destructive tools (deletes, destructive rewrites). Destructive
	 * tools are never auto-approvable — the policy always asks for them.
	 */
	destructive?: boolean;
	/** Zod schema validating the args passed to run(). */
	inputSchema: ZodSchema<Args>;
	/** Execute the tool; policy enforcement is handled by the caller. */
	run(args: Args, ctx: ToolContext): Promise<Result>;
}

export interface ToolContext {
	submissionId?: string;
	assignmentId?: string;
	/** Abort signal forwarded from the calling agent run. */
	signal: AbortSignal;
}

export interface CopilotRegistry {
	register(tool: CopilotTool): void;
	get(name: string): CopilotTool;
	list(): CopilotTool[];
	run(name: string, args: unknown, ctx: ToolContext): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a tool's inputSchema rejects the supplied args. */
export class CopilotToolArgumentError extends Error {
	readonly toolName: string;
	/** The Zod issues produced by safeParse — machine-readable failure detail. */
	readonly issues: readonly ZodIssue[];

	constructor(toolName: string, issues: readonly ZodIssue[]) {
		super(
			`Copilot tool "${toolName}" received invalid arguments (${issues.length} validation error${
				issues.length === 1 ? "" : "s"
			}); see issues for details`,
		);
		this.name = "CopilotToolArgumentError";
		this.toolName = toolName;
		this.issues = issues;
	}
}

/** Thrown when run()/get() is called with a name that was never registered. */
export class CopilotToolNotFoundError extends Error {
	readonly toolName: string;

	constructor(toolName: string) {
		super(`Unknown copilot tool "${toolName}"`);
		this.name = "CopilotToolNotFoundError";
		this.toolName = toolName;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRegistry(): CopilotRegistry {
	const tools = new Map<string, CopilotTool>();

	return {
		register(tool: CopilotTool): void {
			if (tools.has(tool.name)) {
				throw new Error(`Copilot tool "${tool.name}" is already registered`);
			}
			tools.set(tool.name, tool);
		},

		get(name: string): CopilotTool {
			const tool = tools.get(name);
			if (!tool) throw new CopilotToolNotFoundError(name);
			return tool;
		},

		list(): CopilotTool[] {
			return [...tools.values()];
		},

		async run(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
			const tool = this.get(name); // throws CopilotToolNotFoundError for unknown names
			const parsed = tool.inputSchema.safeParse(args);
			if (!parsed.success) {
				throw new CopilotToolArgumentError(tool.name, parsed.error.issues);
			}
			return tool.run(parsed.data, ctx);
		},
	};
}
