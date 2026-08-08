/**
 * @file Unit tests for the copilot tool registry (registry.ts).
 *
 * Covers: duplicate-name rejection, typed argument-validation errors carrying
 * Zod issues, unknown-tool errors, and happy-path execution (schema-validated
 * args passed through to tool.run, result returned, context forwarded).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
	CopilotToolArgumentError,
	CopilotToolNotFoundError,
	createRegistry,
	type CopilotTool,
	type ToolContext,
} from "$lib/server/copilot/registry";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return { signal: new AbortController().signal, ...overrides };
}

const noopTool: CopilotTool = {
	name: "process-all",
	description: "Process all pending submissions",
	permission: "approval",
	inputSchema: z.object({}),
	run: async () => ({}),
};

describe("createRegistry", () => {
	it("rejects duplicate tool names", () => {
		const registry = createRegistry();
		registry.register(noopTool);

		expect(() => registry.register(noopTool)).toThrow(/already registered/);
		expect(() =>
			registry.register({ ...noopTool, description: "renamed description" }),
		).toThrow(/already registered/);
	});

	it("throws a typed error carrying Zod issues for invalid args", async () => {
		const registry = createRegistry();
		const tool: CopilotTool<{ file: string }, string> = {
			name: "grade-submission",
			description: "Grade a submission",
			permission: "approval",
			inputSchema: z.object({ file: z.string() }),
			run: async () => "ok",
		};
		registry.register(tool);

		const err = await registry
			.run("grade-submission", { file: 42 }, makeContext())
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(CopilotToolArgumentError);
		expect((err as CopilotToolArgumentError).toolName).toBe("grade-submission");
		expect((err as CopilotToolArgumentError).issues.length).toBeGreaterThan(0);
		expect((err as CopilotToolArgumentError).message).toContain("grade-submission");
	});

	it("throws for unknown tool names", async () => {
		const registry = createRegistry();

		await expect(registry.run("does-not-exist", {}, makeContext())).rejects.toBeInstanceOf(
			CopilotToolNotFoundError,
		);
		expect(() => registry.get("does-not-exist")).toThrow(CopilotToolNotFoundError);
	});

	it("validates args, executes the tool, and returns the result", async () => {
		const registry = createRegistry();
		let receivedArgs: unknown;
		let receivedCtx: ToolContext | undefined;
		const tool: CopilotTool<{ n: number }, string> = {
			name: "coerce-tool",
			description: "Coerces its input",
			permission: "auto",
			inputSchema: z.object({ n: z.coerce.number() }),
			run: async (args, ctx) => {
				receivedArgs = args;
				receivedCtx = ctx;
				return `ran ${args.n}`;
			},
		};
		registry.register(tool);

		const ctx = makeContext({ submissionId: "sub-1", assignmentId: "assign-1" });
		const result = await registry.run("coerce-tool", { n: "5" }, ctx);

		expect(result).toBe("ran 5");
		expect(receivedArgs).toEqual({ n: 5 }); // parsed/coerced, not the raw input
		expect(receivedCtx).toBe(ctx);
	});

	it("lists registered tools and returns them via get", () => {
		const registry = createRegistry();
		registry.register(noopTool);
		registry.register({ ...noopTool, name: "evaluate-submission" });

		expect(registry.list()).toHaveLength(2);
		expect(
			registry
				.list()
				.map((t) => t.name)
				.sort(),
		).toEqual(["evaluate-submission", "process-all"]);
		expect(registry.get("process-all").permission).toBe("approval");
	});
});
