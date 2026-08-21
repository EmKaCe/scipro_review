/**
 * @file Unit tests for the copilot audit log ($lib/server/copilot/audit).
 *
 * Each test gets a fresh temp dir (mkdtemp) and a real DATA_DIR pointing at
 * it — the audit file lives at <DATA_DIR>/copilot/audit.jsonl and is
 * strictly append-only. Covers: line shape, append order, redaction rules
 * (long strings, content keys, credential-like keys), nested dir creation,
 * append-only behavior, and the before/after hooks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	appendAuditEntry,
	createAuditHooks,
	redactArgs,
	type AuditEntry,
} from "$lib/server/copilot/audit";
import { getDataDir } from "$lib/server/metadata";

let dataDir: string;
let auditFile: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-audit-"));
	auditFile = path.join(dataDir, "copilot", "audit.jsonl");
	process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
	delete process.env.DATA_DIR;
});

function baseEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
	return {
		ts: "2026-08-08T12:00:00.000Z",
		tool: "executeNotebook",
		permission: "auto",
		argsRedacted: "{}",
		decision: "auto",
		ok: true,
		...overrides,
	};
}

async function readLines(): Promise<string[]> {
	const raw = await readFile(auditFile, "utf-8");
	return raw.split("\n").filter((line) => line.length > 0);
}

describe("redactArgs", () => {
	it("truncates string values longer than 200 chars with an ellipsis", () => {
		const long = "x".repeat(250);
		const parsed = JSON.parse(
			redactArgs({ prompt: long, nested: { comment: long }, list: [long] }),
		) as Record<string, unknown>;
		expect(parsed["prompt"]).toBe(`${"x".repeat(200)}…`);
		expect(parsed["prompt"]).toHaveLength(201);
		const nested = parsed["nested"] as Record<string, unknown>;
		expect(nested["comment"]).toHaveLength(201);
		expect((nested["comment"] as string).endsWith("…")).toBe(true);
		expect(parsed["list"]).toEqual([`${"x".repeat(200)}…`]);
		// a bare long string argument is truncated too
		expect(JSON.parse(redactArgs(long))).toHaveLength(201);
		// short strings are untouched
		expect(parsed["prompt"]).not.toBe(long);
	});

	it("redacts source/cellSource/notes/content/feedback/reason/justification values case-insensitively", () => {
		const parsed = JSON.parse(
			redactArgs({
				source: "code",
				cellSource: "cell",
				notes: "note",
				content: "content",
				feedback: "fb",
				reason: "why",
				justification: "because",
				Source: "capitalized",
				keep: "visible",
				list: [{ source: "arr-source" }],
			}),
		) as Record<string, unknown>;
		for (const key of [
			"source",
			"cellSource",
			"notes",
			"content",
			"feedback",
			"reason",
			"justification",
			"Source",
		]) {
			expect(parsed[key]).toBe("[redacted]");
		}
		expect(parsed["keep"]).toBe("visible");
		const list = parsed["list"] as Array<Record<string, unknown>>;
		expect(list[0]!["source"]).toBe("[redacted]");
	});

	it("redacts key/token/secret values case-insensitively, including nested objects", () => {
		const parsed = JSON.parse(
			redactArgs({
				apiKey: "abc123",
				access_token: "tok",
				clientSecret: "s3cr3t",
				nested: { api_key: "nested-secret", Token: "t" },
				prompt: "visible",
			}),
		) as Record<string, unknown>;
		expect(parsed["apiKey"]).toBe("[redacted]");
		expect(parsed["access_token"]).toBe("[redacted]");
		expect(parsed["clientSecret"]).toBe("[redacted]");
		const nested = parsed["nested"] as Record<string, unknown>;
		expect(nested["api_key"]).toBe("[redacted]");
		expect(nested["Token"]).toBe("[redacted]");
		expect(parsed["prompt"]).toBe("visible");
	});
});

describe("appendAuditEntry", () => {
	it("writes a single JSON line with exactly the audit fields", async () => {
		await appendAuditEntry(
			baseEntry({ threadId: "thread-42", permission: "approval", decision: "approved" }),
			dataDir,
		);
		const lines = await readLines();
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(parsed).toEqual({
			ts: "2026-08-08T12:00:00.000Z",
			threadId: "thread-42",
			tool: "executeNotebook",
			permission: "approval",
			argsRedacted: "{}",
			decision: "approved",
			ok: true,
		});
		expect(Object.keys(parsed).sort()).toEqual([
			"argsRedacted",
			"decision",
			"ok",
			"permission",
			"threadId",
			"tool",
			"ts",
		]);
	});

	it("preserves append order", async () => {
		await appendAuditEntry(
			baseEntry({ tool: "first", ts: "2026-08-08T10:00:00.000Z" }),
			dataDir,
		);
		await appendAuditEntry(
			baseEntry({
				tool: "second",
				ts: "2026-08-08T11:00:00.000Z",
				decision: "denied",
				ok: false,
			}),
			dataDir,
		);
		const lines = await readLines();
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!)["tool"]).toBe("first");
		expect(JSON.parse(lines[1]!)["tool"]).toBe("second");
	});

	it("creates the copilot dir and missing parent dirs", async () => {
		const nested = path.join(dataDir, "deep", "nested");
		await appendAuditEntry(baseEntry(), nested);
		const lines = (await readFile(path.join(nested, "copilot", "audit.jsonl"), "utf-8"))
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines).toHaveLength(1);
	});

	it("is append-only — existing lines survive later appends verbatim", async () => {
		await appendAuditEntry(baseEntry({ tool: "first" }), dataDir);
		await appendAuditEntry(
			baseEntry({ tool: "second", ts: "2026-08-08T13:00:00.000Z" }),
			dataDir,
		);
		const lines = await readLines();
		expect(lines).toHaveLength(2);
		await appendAuditEntry(
			baseEntry({ tool: "third", ts: "2026-08-08T14:00:00.000Z" }),
			dataDir,
		);
		const after = await readLines();
		expect(after).toHaveLength(3);
		expect(after[0]).toBe(lines[0]);
		expect(after[1]).toBe(lines[1]);
	});

	it("defaults to the resolved DATA_DIR when no dir is given", async () => {
		expect(getDataDir()).toBe(dataDir);
		await appendAuditEntry(baseEntry());
		const lines = await readLines();
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)["tool"]).toBe("executeNotebook");
	});
});

describe("createAuditHooks", () => {
	it("beforeToolCall logs the attempt: ok true, decision auto by default, args redacted", async () => {
		const hooks = createAuditHooks("thread-7");
		await hooks.beforeToolCall({
			tool: "gradeNotebook",
			permission: "approval",
			args: { source: "print(1)", prompt: "grade this" },
		});
		const lines = await readLines();
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(parsed["tool"]).toBe("gradeNotebook");
		expect(parsed["threadId"]).toBe("thread-7");
		expect(parsed["permission"]).toBe("approval");
		expect(parsed["decision"]).toBe("auto");
		expect(parsed["ok"]).toBe(true);
		expect(JSON.parse(parsed["argsRedacted"] as string)).toEqual({
			source: "[redacted]",
			prompt: "grade this",
		});
	});

	it("beforeToolCall forwards an explicit decision", async () => {
		const hooks = createAuditHooks();
		await hooks.beforeToolCall({ tool: "gradeNotebook", args: {}, decision: "denied" });
		const parsed = JSON.parse((await readLines())[0]!) as Record<string, unknown>;
		expect(parsed["decision"]).toBe("denied");
	});

	it("afterToolCall records the outcome with ok from ctx (default true)", async () => {
		const hooks = createAuditHooks();
		await hooks.afterToolCall({
			tool: "gradeNotebook",
			args: {},
			decision: "approved",
			ok: false,
		});
		await hooks.afterToolCall({ tool: "gradeNotebook", args: {} });
		const lines = await readLines();
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]!) as Record<string, unknown>;
		const second = JSON.parse(lines[1]!) as Record<string, unknown>;
		expect(first["ok"]).toBe(false);
		expect(first["decision"]).toBe("approved");
		expect(second["ok"]).toBe(true);
		expect(second["decision"]).toBe("auto");
	});
});
