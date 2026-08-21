/**
 * @file Evaluation text generator — transforms rubric selections into
 * structured plain text and Markdown evaluation reports.
 *
 * @see .github/references/schemas/evaluation-output-schema.md
 * @see .github/references/schemas/evaluation-md-schema.md
 */

import type { CategoryKey, MergedRubric, Sentiment } from "../types/criteria.js";
import type { ReviewSession } from "../types/session.js";
import type { GradeResult } from "../types/grading.js";
import type { Evaluation, CategoryFeedback } from "../types/evaluation.js";
import { studentIdOf } from "../types/evaluation.js";

// ---------------------------------------------------------------------------
// Grouped feedback
// ---------------------------------------------------------------------------

/** A single feedback item extracted from rubric selections. */
interface FeedbackItem {
	/** The category key this item belongs to. */
	categoryKey: CategoryKey;
	/** The category title for display. */
	categoryTitle: string;
	/** The sentiment of this item. */
	sentiment: Sentiment;
	/** The main point heading (may be empty string for ungrouped items). */
	mainPoint: string;
	/** The sub-point text. */
	text: string;
	/** Optional comment from the grader. */
	comment?: string;
	/** Optional point deduction. */
	deduction?: number;
}

// ---------------------------------------------------------------------------
// Text generation
// ---------------------------------------------------------------------------

/**
 * Generate a plain-text evaluation report from rubric selections.
 *
 * Groups feedback by sentiment (positive → neutral → negative),
 * then by category within each sentiment section.
 *
 * @param session - The review session with selections
 * @param rubric - The merged rubric with category data
 * @returns Formatted plain-text evaluation string
 */
export function generateEvaluationText(session: ReviewSession, rubric: MergedRubric): string {
	const lines: string[] = [];

	lines.push(`Evaluation for ${session.student_id} — ${session.assignment_id}`);
	lines.push("=".repeat(50));
	lines.push("");

	// Group feedback by sentiment
	const sentiments: Sentiment[] = ["positive", "neutral", "negative"];
	const sentimentTitles: Record<Sentiment, string> = {
		positive: "Positive Observations",
		neutral: "General Observations",
		negative: "Areas for Improvement",
	};

	for (const sentiment of sentiments) {
		const items = extractFeedback(session, rubric, sentiment);
		if (items.length === 0) continue;

		lines.push(`## ${sentimentTitles[sentiment]}`);
		lines.push("");

		// Group by category
		const byCategory = groupBy(items, (item) => item.categoryTitle);
		for (const [categoryTitle, categoryItems] of byCategory) {
			lines.push(`**${categoryTitle}**`);
			for (const item of categoryItems) {
				const prefix = item.mainPoint ? `  ${item.mainPoint} — ` : "  • ";
				lines.push(`${prefix}${item.text}`);
				if (item.comment) {
					lines.push(`    Comment: ${item.comment}`);
				}
				if (item.deduction) {
					lines.push(`    Deduction: -${item.deduction} points`);
				}
			}
			lines.push("");

			// Additional notes for this category
			const categoryKey = categoryItems[0].categoryKey;
			const catSel = session.category_selections[categoryKey];
			if (catSel?.notes?.trim()) {
				lines.push(`  Additional Notes: ${catSel.notes}`);
				lines.push("");
			}
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown generation helpers
// ---------------------------------------------------------------------------

/**
 * Generate the YAML frontmatter for a Markdown evaluation report.
 *
 * Includes the student ID, assignment, date, dimension scores, and grade result.
 *
 * @param session - The review session with selections.
 * @param result - The computed grade result.
 * @returns YAML frontmatter string (including `---` delimiters).
 */
export function generateMarkdownFrontmatter(session: ReviewSession, result: GradeResult): string {
	const lines: string[] = [];

	lines.push("---");
	lines.push(`student_id: "${session.student_id}"`);
	lines.push(`assignment: "${session.assignment_id}"`);
	lines.push(`date: "${session.updated_at}"`);
	lines.push("scores:");
	for (const dim of result.dimensions) {
		lines.push(`  ${dim.dimension.key}: ${dim.score}`);
	}
	lines.push("result:");
	lines.push(`  percentage: ${result.percentage.toFixed(1)}`);
	lines.push(`  grade: ${result.grade}`);
	lines.push(`  label: ${result.label}`);
	lines.push("---");

	return lines.join("\n");
}

/**
 * Generate the structured body of a Markdown evaluation report.
 *
 * Groups feedback by sentiment (positive → neutral → negative), then by
 * category, then by main point within each category. Each checked item
 * appears as a Markdown checkbox with optional comments and deductions.
 *
 * @param session - The review session with selections.
 * @param rubric - The merged rubric with category data.
 * @returns Markdown body string (no frontmatter).
 */
export function generateMarkdownBody(session: ReviewSession, rubric: MergedRubric): string {
	const lines: string[] = [];

	const sentiments: Sentiment[] = ["positive", "neutral", "negative"];
	const sentimentTitles: Record<Sentiment, string> = {
		positive: "Positive Observations",
		neutral: "General Observations",
		negative: "Areas for Improvement",
	};

	for (const sentiment of sentiments) {
		const items = extractFeedback(session, rubric, sentiment);
		if (items.length === 0) continue;

		lines.push(`## ${sentimentTitles[sentiment]}`);
		lines.push("");
		lines.push(`<!-- sentiment:${sentiment} -->`);

		// Group by category
		const byCategory = groupBy(items, (item) => item.categoryTitle);
		for (const [categoryTitle, categoryItems] of byCategory) {
			lines.push(`### ${categoryTitle}`);
			lines.push("");

			// Group by main point
			const byMainPoint = groupBy(categoryItems, (item) => item.mainPoint || "");
			for (const [mainPoint, pointItems] of byMainPoint) {
				if (mainPoint) {
					lines.push(`**${mainPoint}**`);
					lines.push("");
				}
				for (const item of pointItems) {
					lines.push(`- [x] ${item.text}`);
					if (item.comment) {
						lines.push(`  > ${item.comment}`);
					}
					if (item.deduction) {
						lines.push(`  (-${item.deduction} points)`);
					}
				}
				lines.push("");
			}
		}

		lines.push(`<!-- /sentiment:${sentiment} -->`);
		lines.push("");
	}

	// Additional notes section
	const additionalNotesSection = renderAdditionalNotesSection(session, rubric);
	if (additionalNotesSection) {
		lines.push(additionalNotesSection);
	}

	return lines.join("\n");
}

/**
 * Render the additional notes section for a Markdown evaluation report.
 *
 * Collects non-empty notes from all rubric categories and formats them
 * as a structured section.
 *
 * @param session - The review session with selections.
 * @param rubric - The merged rubric with category data.
 * @returns Formatted notes section string, or empty string if no notes.
 */
export function renderAdditionalNotesSection(session: ReviewSession, rubric: MergedRubric): string {
	const additionalNotes: { categoryTitle: string; notes: string }[] = [];
	for (const entry of rubric.categories) {
		const catSel = session.category_selections[entry.key];
		if (catSel?.notes?.trim()) {
			additionalNotes.push({
				categoryTitle: entry.category.title,
				notes: catSel.notes.trim(),
			});
		}
	}

	if (additionalNotes.length === 0) return "";

	const lines: string[] = [];
	lines.push("## Additional Notes");
	lines.push("");
	for (const { categoryTitle, notes } of additionalNotes) {
		lines.push(`**${categoryTitle}**: ${notes}`);
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * Render the sentiment section header for a Markdown evaluation report.
 *
 * @param sentiment - The sentiment key.
 * @returns The section header lines including sentiment comment markers.
 */
export function renderSentimentSection(sentiment: Sentiment): string {
	const sentimentTitles: Record<Sentiment, string> = {
		positive: "Positive Observations",
		neutral: "General Observations",
		negative: "Areas for Improvement",
	};

	const lines: string[] = [];
	lines.push(`## ${sentimentTitles[sentiment]}`);
	lines.push("");
	lines.push(`<!-- sentiment:${sentiment} -->`);
	lines.push(`<!-- /sentiment:${sentiment} -->`);
	return lines.join("\n");
}

/**
 * Generate a Markdown evaluation report following the evaluation-md schema.
 *
 * Includes YAML frontmatter with scores and result, followed by
 * structured checkbox sections grouped by category and sentiment.
 *
 * Delegates frontmatter generation to {@link generateMarkdownFrontmatter}
 * and the body to {@link generateMarkdownBody}.
 *
 * @param session - The review session with selections
 * @param rubric - The merged rubric with category data
 * @param result - The computed grade result
 * @returns Formatted Markdown string
 */
export function generateEvaluationMarkdown(
	session: ReviewSession,
	rubric: MergedRubric,
	result: GradeResult,
): string {
	const frontmatter = generateMarkdownFrontmatter(session, result);
	const body = generateMarkdownBody(session, rubric);
	return `${frontmatter}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Evaluation object generation
// ---------------------------------------------------------------------------

/**
 * Generate a full Evaluation object from a review session.
 *
 * This is the canonical output format for export.
 *
 * @param session - The review session with selections
 * @param rubric - The merged rubric with category data
 * @param result - The computed grade result
 * @param reviewer - The reviewer name/identifier
 * @returns Complete Evaluation object
 */
export function generateEvaluation(
	session: ReviewSession,
	rubric: MergedRubric,
	result: GradeResult,
	reviewer: string,
): Evaluation {
	const feedback: Record<string, CategoryFeedback> = {};

	for (const entry of rubric.categories) {
		const catSel = session.category_selections[entry.key];
		if (!catSel) continue;

		feedback[entry.key] = {
			checked: [
				...(catSel.checked_items instanceof Set ? catSel.checked_items : new Set()),
			] as readonly string[],
			comments: { ...catSel.comments },
			deductions: { ...catSel.deductions },
			notes: catSel.notes,
		};
	}

	const scores: Record<string, number> = {};
	for (const dim of result.dimensions) {
		scores[dim.dimension.key as string] = dim.score;
	}

	return {
		student_id: studentIdOf(session.student_id),
		assignment: session.assignment_id,
		reviewer,
		date: session.updated_at.split("T")[0], // ISO date only
		scores: scores as Record<string, number> as Record<never, number>,
		feedback: feedback as Record<string, CategoryFeedback> as Record<
			CategoryKey,
			CategoryFeedback
		>,
		result: {
			percentage: result.percentage,
			grade: result.grade,
			label: result.label,
		},
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract feedback items for a given sentiment from the review session.
 */
function extractFeedback(
	session: ReviewSession,
	rubric: MergedRubric,
	sentiment: Sentiment,
): FeedbackItem[] {
	const items: FeedbackItem[] = [];

	for (const entry of rubric.categories) {
		const catSel = session.category_selections[entry.key];
		if (!catSel) continue;

		const checkedItems =
			catSel.checked_items instanceof Set
				? catSel.checked_items
				: new Set(catSel.checked_items as unknown as string[]);

		const category = entry.category;
		const sentimentPoints = category[sentiment];

		for (const mainPoint of sentimentPoints) {
			for (const subPoint of mainPoint.sub_points) {
				if (checkedItems.has(subPoint.text)) {
					items.push({
						categoryKey: entry.key,
						categoryTitle: category.title,
						sentiment,
						mainPoint: mainPoint.main_point,
						text: subPoint.text,
						comment: catSel.comments[subPoint.text],
						deduction: catSel.deductions[subPoint.text],
					});
				}
			}
		}
	}

	return items;
}

/**
 * Group an array by a key function.
 */
function groupBy<T>(arr: T[], keyFn: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of arr) {
		const key = keyFn(item);
		if (!groups.has(key)) {
			groups.set(key, []);
		}
		groups.get(key)!.push(item);
	}
	return groups;
}
