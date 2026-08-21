/**
 * @file Copilot approval policy resolver.
 *
 * This is the policy layer that later maps onto Mastra's requireApproval:
 * given a tool descriptor and the current CopilotSettings (plus an optional
 * per-session allowance counter), it decides whether an invocation should
 * proceed automatically ("auto"), require a human approval card ("ask"), or
 * be refused outright ("blocked").
 *
 * Decision priority (first match wins):
 *   1. denyTools contains the tool name → "blocked" (never callable)
 *   2. destructive flag or HARD_DENY name → "ask" (every mode; the approval
 *      card is still shown so the teacher can explicitly confirm)
 *   3. read-only mode → "blocked" for approval-class tools, "auto" for
 *      auto-class tools
 *   4. auto-approve-all mode → "auto", except ALWAYS_ASK_COST tools → "ask"
 *   5. ask mode (default) → "auto" for auto-class tools; the allowlist
 *      auto-approves approval-class tools up to sessionCap per session
 */

import type { CopilotSettings } from "../settings";
import type { ToolPermission } from "./registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalDecision = "ask" | "auto" | "blocked";

export interface ApprovalPolicyContext {
	settings: CopilotSettings;
	/**
	 * Mutable per-session allowance counter. Required for allowlist
	 * auto-approval: without it the session cap cannot be enforced.
	 */
	session?: { autoApprovedCount: number };
}

export interface ToolDescriptor {
	name: string;
	permission: ToolPermission;
	destructive?: boolean;
}

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Tools that are never auto-approvable, in any mode: they mutate or remove
 * teacher data. The approval card is still shown so the teacher can explicitly
 * confirm the action.
 */
export const HARD_DENY: readonly string[] = ["delete-assignment", "archive-submission"];

/**
 * Expensive / long-running tools that must not run unattended even in
 * auto-approve-all mode (cost guard).
 */
export const ALWAYS_ASK_COST: readonly string[] = ["process-all", "pre-evaluate-all"];

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export function resolveApprovalPolicy(
	tool: ToolDescriptor,
	ctx: ApprovalPolicyContext,
): (input: unknown) => ApprovalDecision {
	return (_input: unknown): ApprovalDecision => {
		const { settings, session } = ctx;

		// 1. Explicit deny list wins over everything — never callable.
		if (settings.denyTools.includes(tool.name)) return "blocked";

		// 2. Destructive / hard-deny tools always ask, in every mode:
		//    never auto-approvable, but the approval card is still shown.
		if (tool.destructive === true || HARD_DENY.includes(tool.name)) return "ask";

		switch (settings.mode) {
			case "read-only": {
				// 3. Read-only: approval-class tools are pre-denied; auto-class
				//    tools are safe to run unattended.
				if (tool.permission === "approval") return "blocked";
				return "auto";
			}
			case "auto-approve-all": {
				// 4. Auto-approve everything except the costly/long-running
				//    tools. sessionCap deliberately does NOT apply here: the
				//    whole point of this mode is unattended bulk processing,
				//    so a per-session budget would defeat it.
				if (ALWAYS_ASK_COST.includes(tool.name)) return "ask";
				return "auto";
			}
			default: {
				// 5. 'ask' (default): auto-class tools run; approval-class tools
				//    are auto-approved only while inside the per-session
				//    allowance. Without a session the cap cannot be enforced,
				//    so we fall back to asking.
				if (tool.permission === "auto") return "auto";
				if (
					session &&
					settings.allowedTools.includes(tool.name) &&
					session.autoApprovedCount < settings.sessionCap
				) {
					session.autoApprovedCount += 1;
					return "auto";
				}
				return "ask";
			}
		}
	};
}
