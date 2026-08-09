/**
 * @file Unit tests for the copilot approval policy resolver (permission.ts).
 *
 * Covers the decision rules in priority order:
 *   1. denyTools blocks everything (even auto-class tools), and wins over the
 *      hard-deny ask rule.
 *   2. destructive / HARD_DENY tools always ask — in every mode, including
 *      auto-approve-all and read-only.
 *   3. read-only blocks approval-class tools while auto-class tools still run.
 *   4. auto-approve-all auto-approves approval-class tools except
 *      ALWAYS_ASK_COST (cost/long-running) — sessionCap does not apply.
 *   5. ask mode prompts for approval-class tools; the allowlist auto-approves
 *      up to sessionCap per session, then prompts resume.
 */
import { describe, expect, it } from "vitest";

import {
	ALWAYS_ASK_COST,
	HARD_DENY,
	resolveApprovalPolicy,
	type ApprovalDecision,
	type ApprovalPolicyContext,
	type ToolDescriptor,
} from "$lib/server/copilot/permission";
import type { CopilotSettings } from "$lib/server/settings";

function settings(overrides: Partial<CopilotSettings> = {}): CopilotSettings {
	return {
		mode: "ask",
		allowedTools: [],
		denyTools: [],
		approvalTtlSeconds: 60,
		sessionCap: 20,
		lastMessages: 16,
		autoCompact: true,
		...overrides,
	};
}

function decide(
	tool: ToolDescriptor,
	ctx: ApprovalPolicyContext,
	input: unknown = {},
): ApprovalDecision {
	return resolveApprovalPolicy(tool, ctx)(input);
}

function approvalTool(name = "evaluate-submission"): ToolDescriptor {
	return { name, permission: "approval" };
}

function autoTool(name = "read-results"): ToolDescriptor {
	return { name, permission: "auto" };
}

function session(count = 0): { autoApprovedCount: number } {
	return { autoApprovedCount: count };
}

describe("resolveApprovalPolicy", () => {
	describe("rule 1 — denyTools wins over everything", () => {
		it("blocks even auto-class tools", () => {
			const ctx: ApprovalPolicyContext = {
				settings: settings({ denyTools: ["read-results"] }),
			};
			expect(decide(autoTool("read-results"), ctx)).toBe("blocked");
		});

		it("blocks approval-class tools regardless of mode", () => {
			const ctx: ApprovalPolicyContext = {
				settings: settings({
					mode: "auto-approve-all",
					denyTools: ["evaluate-submission"],
				}),
			};
			expect(decide(approvalTool("evaluate-submission"), ctx)).toBe("blocked");
		});

		it("wins over the hard-deny ask rule", () => {
			const ctx: ApprovalPolicyContext = {
				settings: settings({ denyTools: ["delete-assignment"] }),
			};
			expect(decide(approvalTool("delete-assignment"), ctx)).toBe("blocked");
		});
	});

	describe("rule 2 — hard-deny / destructive always ask", () => {
		it("HARD_DENY tools ask even in auto-approve-all mode", () => {
			const ctx: ApprovalPolicyContext = { settings: settings({ mode: "auto-approve-all" }) };
			for (const name of HARD_DENY) {
				expect(decide(approvalTool(name), ctx)).toBe("ask");
				expect(decide(autoTool(name), ctx)).toBe("ask");
			}
		});

		it("HARD_DENY tools ask even in read-only mode", () => {
			const ctx: ApprovalPolicyContext = { settings: settings({ mode: "read-only" }) };
			expect(decide(approvalTool("delete-assignment"), ctx)).toBe("ask");
		});

		it("destructive tools ask even in auto-approve-all mode", () => {
			const ctx: ApprovalPolicyContext = { settings: settings({ mode: "auto-approve-all" }) };
			expect(decide({ ...approvalTool("regrade-all"), destructive: true }, ctx)).toBe("ask");
		});

		it("destructive tools ask even in read-only mode", () => {
			const ctx: ApprovalPolicyContext = { settings: settings({ mode: "read-only" }) };
			expect(decide({ ...approvalTool("regrade-all"), destructive: true }, ctx)).toBe("ask");
		});
	});

	describe("rule 3 — read-only mode", () => {
		it("blocks approval-class tools while auto-class tools still run", () => {
			const ctx: ApprovalPolicyContext = { settings: settings({ mode: "read-only" }) };
			expect(decide(approvalTool(), ctx)).toBe("blocked");
			expect(decide(autoTool(), ctx)).toBe("auto");
		});
	});

	describe("rule 4 — auto-approve-all mode", () => {
		it("auto-approves approval-class tools", () => {
			const ctx: ApprovalPolicyContext = { settings: settings({ mode: "auto-approve-all" }) };
			expect(decide(approvalTool(), ctx)).toBe("auto");
			expect(decide(autoTool(), ctx)).toBe("auto");
		});

		it("ALWAYS_ASK_COST tools ask even in auto-approve-all mode", () => {
			const ctx: ApprovalPolicyContext = { settings: settings({ mode: "auto-approve-all" }) };
			for (const name of ALWAYS_ASK_COST) {
				expect(decide(approvalTool(name), ctx)).toBe("ask");
			}
		});

		it("does not consume the session allowance in auto-approve-all mode", () => {
			const ctx: ApprovalPolicyContext = {
				settings: settings({
					mode: "auto-approve-all",
					allowedTools: ["evaluate-submission"],
				}),
				session: session(),
			};
			expect(decide(approvalTool(), ctx)).toBe("auto");
			expect(ctx.session!.autoApprovedCount).toBe(0); // sessionCap does not apply here
		});
	});

	describe("rule 5 — ask mode (default)", () => {
		it("prompts for approval-class tools", () => {
			const ctx: ApprovalPolicyContext = { settings: settings() };
			expect(decide(approvalTool(), ctx)).toBe("ask");
		});

		it("lets auto-class tools run without prompting", () => {
			const ctx: ApprovalPolicyContext = { settings: settings() };
			expect(decide(autoTool(), ctx)).toBe("auto");
		});

		it("allowlist auto-approves approval tools up to sessionCap, then prompts resume", () => {
			const ctx: ApprovalPolicyContext = {
				settings: settings({ allowedTools: ["evaluate-submission"], sessionCap: 2 }),
				session: session(),
			};

			expect(decide(approvalTool(), ctx)).toBe("auto");
			expect(ctx.session!.autoApprovedCount).toBe(1);
			expect(decide(approvalTool(), ctx)).toBe("auto");
			expect(ctx.session!.autoApprovedCount).toBe(2);
			// Cap reached: prompting resumes, counter is not incremented further.
			expect(decide(approvalTool(), ctx)).toBe("ask");
			expect(ctx.session!.autoApprovedCount).toBe(2);
		});

		it("does not auto-approve without a session (cap cannot be enforced)", () => {
			const ctx: ApprovalPolicyContext = {
				settings: settings({ allowedTools: ["evaluate-submission"] }),
			};
			expect(decide(approvalTool(), ctx)).toBe("ask");
		});

		it("does not auto-approve tools outside the allowlist", () => {
			const ctx: ApprovalPolicyContext = {
				settings: settings({ allowedTools: ["other-tool"] }),
				session: session(),
			};
			expect(decide(approvalTool(), ctx)).toBe("ask");
			expect(ctx.session!.autoApprovedCount).toBe(0);
		});
	});
});
