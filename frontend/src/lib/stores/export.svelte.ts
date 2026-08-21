/** @file Export sub-store — manages YAML/MD/JSON export, import, and download. */
import type { ReviewSession } from "../types/session.js";
import type { MergedRubric } from "../types/criteria.js";
import type { GradeResult } from "../types/grading.js";
import type { ExportFormat } from "../types/persistence.js";
import {
	exportSession,
	downloadFile,
	parseImport,
	normalizeLegacyCheckedItems,
} from "../services/session-persistence.js";
import { generateEvaluationMarkdown } from "../services/text-generator.js";

/**
 * Manages export/import functionality for review sessions.
 *
 * This store is responsible for:
 * - Exporting reviews in YAML, Markdown, and JSON formats
 * - Importing reviews from YAML/JSON files
 * - Generating evaluation text
 * - Triggering file downloads
 *
 * This store is stateless — it operates on data passed to its methods.
 */
export class ExportStore {
	// -----------------------------------------------------------------------
	// Export
	// -----------------------------------------------------------------------

	/**
	 * Export a review session in the specified format.
	 *
	 * @param session - The review session
	 * @param rubric - The merged rubric
	 * @param gradeResult - The computed grade result
	 * @param format - The export format
	 * @param reviewer - The reviewer name
	 * @returns The exported content string
	 */
	exportReview(
		session: ReviewSession,
		rubric: MergedRubric,
		gradeResult: GradeResult,
		format: ExportFormat,
		reviewer: string,
	): string {
		return exportSession(session, rubric, gradeResult, format, reviewer);
	}

	/**
	 * Generate evaluation Markdown text from a session.
	 *
	 * @param session - The review session
	 * @param rubric - The merged rubric
	 * @param gradeResult - The computed grade result
	 * @returns The generated Markdown text
	 */
	generateText(session: ReviewSession, rubric: MergedRubric, gradeResult: GradeResult): string {
		return generateEvaluationMarkdown(session, rubric, gradeResult);
	}

	/**
	 * Trigger a browser download of the exported file.
	 *
	 * @param content - The file content
	 * @param filename - The download filename
	 * @param mimeType - The MIME type
	 */
	download(content: string, filename: string, mimeType: string): void {
		downloadFile(content, filename, mimeType);
	}

	/**
	 * Export and download a review in the specified format.
	 *
	 * @param session - The review session
	 * @param rubric - The merged rubric
	 * @param gradeResult - The computed grade result
	 * @param format - The export format
	 * @param reviewer - The reviewer name
	 */
	exportAndDownload(
		session: ReviewSession,
		rubric: MergedRubric,
		gradeResult: GradeResult,
		format: ExportFormat,
		reviewer: string,
	): void {
		const content = this.exportReview(session, rubric, gradeResult, format, reviewer);

		const extensions: Record<ExportFormat, string> = {
			yaml: "yaml",
			md: "md",
			json: "json",
		};

		const mimeTypes: Record<ExportFormat, string> = {
			yaml: "text/yaml",
			md: "text/markdown",
			json: "application/json",
		};

		const filename = `${session.student_id}_${session.assignment_id}.${extensions[format]}`;
		this.download(content, filename, mimeTypes[format]);
	}

	// -----------------------------------------------------------------------
	// Import
	// -----------------------------------------------------------------------

	/**
	 * Parse an imported file into a ReviewSession.
	 *
	 * @param text - The file content
	 * @param filename - The filename (used to detect format)
	 * @returns The parsed session, or null if parsing failed
	 */
	parseImport(text: string, filename: string): ReviewSession | null {
		return parseImport(text, filename);
	}

	/**
	 * Normalize legacy checked items against a loaded rubric.
	 *
	 * @param session - The session to normalize
	 * @param rubric - The loaded rubric
	 */
	normalizeLegacy(session: ReviewSession, rubric: MergedRubric): void {
		normalizeLegacyCheckedItems(session, rubric);
	}
}
