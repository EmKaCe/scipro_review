/**
 * @file GET /api/submissions/[id]/export — download the grading YAML.
 *
 * Serializes the submission record + grading state via export-service.ts
 * and returns it as a Content-Disposition attachment named
 * <studentId>.yaml. Export works in any status (partial grading exports
 * are allowed); graded records carry the full state.
 */

import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { assignmentExists, getAssignmentById, resolveAssignmentId } from "$lib/server/assignments";
import { buildGradingYaml, buildStudentYaml } from "$lib/server/export-service";
import { getSubmission } from "$lib/server/metadata";
import { readPlagiarismResult } from "$lib/server/plagiarism/cache";
import { reviewStatusOf } from "$lib/server/plagiarism/structural";

/**
 * The export format:
 *   ?kind=student (default) — v2 evaluation-output YAML the student webapp
 *       can import: identity, scores, feedback, notes. NO plagiarism verdicts,
 *       NO lifecycle status, NO internal fields. Filename: <studentId>.yaml.
 *   ?kind=teacher — full teacher YAML (status, file_name, timestamps, rubric,
 *       scores, notes) PLUS the plagiarism audit block (pairs + review
 *       statuses). Filename: <studentId>-teacher.yaml.
 */
export async function GET(event: RequestEvent): Promise<Response> {
	const studentId = event.params.id;
	if (!studentId) {
		throw error(400, "Missing submission id");
	}
	const assignmentId = await resolveAssignmentId(event.url.searchParams.get("assignment"));
	if (!assignmentId) {
		throw error(404, "No assignments configured");
	}
	if (!(await assignmentExists(assignmentId))) {
		throw error(404, `Assignment "${assignmentId}" not found`);
	}

	const record = await getSubmission(assignmentId, studentId);
	if (!record) {
		throw error(404, `Submission "${studentId}" not found in assignment "${assignmentId}"`);
	}

	const kind = event.url.searchParams.get("kind") === "teacher" ? "teacher" : "student";
	const assignment = await getAssignmentById(assignmentId);

	if (kind === "teacher") {
		// Teacher copy: full record + plagiarism audit (pairs involving this
		// submission, with the teacher's review status per pair).
		const result = await readPlagiarismResult(assignmentId);
		const plagiarism = result
			? {
					pairs: result.pairs
						.filter((p) => p.studentA === studentId || p.studentB === studentId)
						.map((p) => ({
							studentB: p.studentA === studentId ? p.studentB : p.studentA,
							severity:
								p.cellOverlap >= 0.6
									? "high"
									: p.cellOverlap >= 0.35 || p.notebookOverlap >= 0.5
										? "medium"
										: p.cellOverlap >= 0.15
											? "low"
											: "none",
							notebookOverlap: p.notebookOverlap,
							reviewStatus: reviewStatusOf(p),
						})),
				}
			: undefined;
		const yamlText = buildGradingYaml(record, {
			assignmentTitle: assignment?.title,
			plagiarism,
		});
		return new Response(yamlText, {
			headers: {
				"Content-Type": "application/yaml; charset=utf-8",
				"Content-Disposition": `attachment; filename="${record.studentId}-teacher.yaml"`,
			},
		});
	}

	const yamlText = buildStudentYaml(record, { assignmentTitle: assignment?.title });
	return new Response(yamlText, {
		headers: {
			"Content-Type": "application/yaml; charset=utf-8",
			"Content-Disposition": `attachment; filename="${record.studentId}.yaml"`,
		},
	});
}
