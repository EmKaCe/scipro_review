// @vitest-environment node
/**
 * @file API-contract tests for the assignments write side:
 *   POST /api/assignments           — create (append, validate, 409 duplicate)
 *   PUT  /api/assignments/[id]      — partial update (404 unknown)
 *   DELETE /api/assignments/[id]    — remove (409 with submissions dir, else 204)
 *
 * Real temp DATA_DIR (mkdtemp) with a fixture assignments.yaml, real
 * Request/Response objects, and direct handler imports like the other route
 * suites. The YAML round-trip test additionally asserts untouched top-level
 * keys survive the atomic rewrite.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as yaml from "js-yaml";

import { GET as listGET, POST as createPOST } from "../../routes/api/assignments/+server";
import { DELETE as itemDELETE, PUT as itemPUT } from "../../routes/api/assignments/[id]/+server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENTS_YAML = `course_name: Scientific Programming
semester: 2026SS
assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
    dimensions:
      - code_quality_design
  - id: molecular_dynamics
    title: Molecular Dynamics
    enabled: false
    criteria_files: []
    dimensions: []
`;

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-assignments-writer-"));
	vi.stubEnv("DATA_DIR", dataDir);
	await writeFile(path.join(dataDir, "assignments.yaml"), ASSIGNMENTS_YAML);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal RequestEvent stub — the routes only touch params + request. */
function makeEvent(
	url: string,
	opts: { params?: Record<string, string>; request?: Request } = {},
): RequestEvent {
	const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
	return {
		url: new URL(absolute),
		params: opts.params ?? {},
		request: opts.request ?? new Request(absolute, { method: "GET" }),
	} as unknown as RequestEvent;
}

/** Build a JSON request for the given method. */
function jsonRequest(url: string, method: string, body: unknown): Request {
	const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
	return new Request(absolute, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Assert a handler rejects with a SvelteKit HttpError (status + body.message). */
async function expectApiError(
	promise: Promise<unknown>,
	status: number,
	messagePart?: string,
): Promise<void> {
	try {
		await promise;
	} catch (err) {
		const e = err as { status?: number; body?: { message?: string } };
		expect(e.status).toBe(status);
		if (messagePart !== undefined) {
			expect(e.body?.message).toContain(messagePart);
		}
		return;
	}
	expect.unreachable(`expected handler to fail with ${status}`);
}

/** GET /api/assignments — the enabled-only list, as { assignments }. */
async function listEnabled(): Promise<Array<{ id: string; title: string; enabled: boolean }>> {
	const res = await listGET();
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		assignments: Array<{ id: string; title: string; enabled: boolean }>;
	};
	return body.assignments;
}

// ---------------------------------------------------------------------------
// POST /api/assignments
// ---------------------------------------------------------------------------

describe("POST /api/assignments", () => {
	it("creates an assignment, appends it after existing entries, and GET lists it", async () => {
		const res = await createPOST(
			makeEvent("/api/assignments", {
				request: jsonRequest("/api/assignments", "POST", {
					id: "quantum_chemistry",
					title: "Quantum Chemistry",
					criteria_files: ["data/criteria/quantum_chemistry.yaml"],
					dimensions: ["creativity", "code_quality_design"],
				}),
			}),
		);
		expect(res.status).toBe(201);
		const created = (await res.json()) as {
			id: string;
			title: string;
			enabled: boolean;
			criteria_files: string[];
		};
		expect(created).toEqual({
			id: "quantum_chemistry",
			title: "Quantum Chemistry",
			enabled: true, // defaults to true
			criteria_files: ["data/criteria/quantum_chemistry.yaml"],
		});

		const listed = await listEnabled();
		// Appended after the existing enabled assignment (order preserved).
		expect(listed.map((a) => a.id)).toEqual(["soil_contamination", "quantum_chemistry"]);
	});

	it("409s when the id already exists", async () => {
		await expectApiError(
			createPOST(
				makeEvent("/api/assignments", {
					request: jsonRequest("/api/assignments", "POST", {
						id: "soil_contamination",
						title: "Duplicate",
					}),
				}),
			),
			409,
			"already exists",
		);
	});

	it("400s for an invalid id", async () => {
		await expectApiError(
			createPOST(
				makeEvent("/api/assignments", {
					request: jsonRequest("/api/assignments", "POST", {
						id: "My Assign!",
						title: "Bad id",
					}),
				}),
			),
			400,
			"Invalid assignment id",
		);
	});

	it("400s for an unknown dimension", async () => {
		await expectApiError(
			createPOST(
				makeEvent("/api/assignments", {
					request: jsonRequest("/api/assignments", "POST", {
						id: "new_assignment",
						title: "New Assignment",
						dimensions: ["not_a_real_dimension"],
					}),
				}),
			),
			400,
			'Unknown dimension "not_a_real_dimension"',
		);
	});

	it("400s for an empty title", async () => {
		await expectApiError(
			createPOST(
				makeEvent("/api/assignments", {
					request: jsonRequest("/api/assignments", "POST", {
						id: "new_assignment",
						title: "   ",
					}),
				}),
			),
			400,
			"title",
		);
	});
});

// ---------------------------------------------------------------------------
// PUT /api/assignments/[id]
// ---------------------------------------------------------------------------

describe("PUT /api/assignments/[id]", () => {
	it("toggles enabled to false and GET no longer lists it", async () => {
		const res = await itemPUT(
			makeEvent("/api/assignments/soil_contamination", {
				params: { id: "soil_contamination" },
				request: jsonRequest("/api/assignments/soil_contamination", "PUT", {
					enabled: false,
					title: "Soil Contamination v2",
				}),
			}),
		);
		expect(res.status).toBe(200);
		const updated = (await res.json()) as { id: string; enabled: boolean; title: string };
		expect(updated.enabled).toBe(false);
		expect(updated.title).toBe("Soil Contamination v2");

		// Enabled-only list omits it now.
		const listed = await listEnabled();
		expect(listed.map((a) => a.id)).not.toContain("soil_contamination");
	});

	it("404s for an unknown id", async () => {
		await expectApiError(
			itemPUT(
				makeEvent("/api/assignments/nope", {
					params: { id: "nope" },
					request: jsonRequest("/api/assignments/nope", "PUT", { enabled: false }),
				}),
			),
			404,
			'Assignment "nope" not found',
		);
	});
});

// ---------------------------------------------------------------------------
// DELETE /api/assignments/[id]
// ---------------------------------------------------------------------------

describe("DELETE /api/assignments/[id]", () => {
	it("409s when the assignment has a submissions directory", async () => {
		await mkdir(path.join(dataDir, "submissions", "soil_contamination"), { recursive: true });
		await writeFile(
			path.join(dataDir, "submissions", "soil_contamination", "metadata.json"),
			"{}",
		);

		await expectApiError(
			itemDELETE(
				makeEvent("/api/assignments/soil_contamination", {
					params: { id: "soil_contamination" },
					request: new Request("http://localhost/api/assignments/soil_contamination", {
						method: "DELETE",
					}),
				}),
			),
			409,
			"has submissions",
		);

		// Still listed (registry untouched).
		const listed = await listEnabled();
		expect(listed.map((a) => a.id)).toContain("soil_contamination");
	});

	it("204s and removes the entry; GET omits it", async () => {
		const res = await itemDELETE(
			makeEvent("/api/assignments/molecular_dynamics", {
				params: { id: "molecular_dynamics" },
				request: new Request("http://localhost/api/assignments/molecular_dynamics", {
					method: "DELETE",
				}),
			}),
		);
		expect(res.status).toBe(204);

		const listed = await listEnabled();
		expect(listed.map((a) => a.id)).not.toContain("molecular_dynamics");

		// Second delete → 404.
		await expectApiError(
			itemDELETE(
				makeEvent("/api/assignments/molecular_dynamics", {
					params: { id: "molecular_dynamics" },
					request: new Request("http://localhost/api/assignments/molecular_dynamics", {
						method: "DELETE",
					}),
				}),
			),
			404,
			'Assignment "molecular_dynamics" not found',
		);
	});
});

// ---------------------------------------------------------------------------
// YAML round-trip
// ---------------------------------------------------------------------------

describe("assignments.yaml round-trip", () => {
	it("persists the new entry and preserves untouched top-level keys", async () => {
		// Create + partial update.
		const created = await createPOST(
			makeEvent("/api/assignments", {
				request: jsonRequest("/api/assignments", "POST", {
					id: "atom_interaction",
					title: "Atom Interaction",
					enabled: true,
					criteria_files: ["data/criteria/atom_interaction.yaml"],
					dimensions: ["scientific_programming"],
				}),
			}),
		);
		expect(created.status).toBe(201);

		const updated = await itemPUT(
			makeEvent("/api/assignments/atom_interaction", {
				params: { id: "atom_interaction" },
				request: jsonRequest("/api/assignments/atom_interaction", "PUT", {
					title: "Atom Interaction v2",
					enabled: false,
				}),
			}),
		);
		expect(updated.status).toBe(200);

		const parsed = yaml.load(
			await readFile(path.join(dataDir, "assignments.yaml"), "utf-8"),
		) as {
			course_name: string;
			semester: string;
			assignments: Array<{ id: string; title: string; enabled: boolean }>;
		};

		// Untouched top-level keys preserved through both rewrites.
		expect(parsed.course_name).toBe("Scientific Programming");
		expect(parsed.semester).toBe("2026SS");

		// New entry present with the updated fields; originals still there.
		const byId = new Map(parsed.assignments.map((a) => [a.id, a]));
		expect(byId.get("atom_interaction")).toMatchObject({
			id: "atom_interaction",
			title: "Atom Interaction v2",
			enabled: false,
			criteria_files: ["data/criteria/atom_interaction.yaml"],
			dimensions: ["scientific_programming"],
		});
		expect(byId.has("soil_contamination")).toBe(true);
		expect(byId.has("molecular_dynamics")).toBe(true);
	});
});
