/**
 * @file Shared editable criteria model for the criteria editor tabs.
 *
 * The visual editor, raw-YAML editor, and preview all work on the same
 * mutable draft shape (`EditableCategory[]`). Pure helpers live here so
 * the tabs wrapper can own the single source of truth while the visual
 * editor stays a controlled component.
 */

import type { CriteriaFile } from "$lib/types/criteria.js";

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export interface EditableSubPoint {
	text: string;
	comment: boolean;
	point_deduction: boolean;
}

export interface EditableMainPoint {
	main_point: string;
	sub_points: EditableSubPoint[];
}

export interface EditableCategory {
	key: string;
	title: string;
	additional_notes: boolean;
	positive: EditableMainPoint[];
	neutral: EditableMainPoint[];
	negative: EditableMainPoint[];
}

export function emptySubPoint(): EditableSubPoint {
	return { text: "", comment: false, point_deduction: false };
}

export function emptyMainPoint(): EditableMainPoint {
	return { main_point: "", sub_points: [] };
}

/** Next unique "new_category" key (new_category_2, ...) not present in `existing`. */
export function nextCategoryKey(existing: string[]): string {
	const taken = new Set(existing);
	if (!taken.has("new_category")) return "new_category";
	let i = 2;
	while (taken.has(`new_category_${i}`)) i++;
	return `new_category_${i}`;
}

export function emptyCategory(existing: string[]): EditableCategory {
	return {
		key: nextCategoryKey(existing),
		title: "New Category",
		additional_notes: true,
		positive: [],
		neutral: [],
		negative: [],
	};
}

function toEditableMainPoint(mp: {
	main_point?: string;
	sub_points?: readonly { text?: string; comment?: boolean; point_deduction?: boolean }[];
}): EditableMainPoint {
	return {
		main_point: mp.main_point ?? "",
		sub_points: (mp.sub_points ?? []).map((sp) => ({
			text: sp.text ?? "",
			comment: sp.comment ?? false,
			point_deduction: sp.point_deduction ?? false,
		})),
	};
}

/**
 * Convert a server/parsed-YAML categories map into the editable draft.
 * Defensive defaults make raw-YAML input safe (missing title/sentiments).
 */
export function fromServerCategories(categories: CriteriaFile["categories"]): EditableCategory[] {
	return Object.entries(categories).map(([key, category]) => ({
		key,
		title: category.title ?? "",
		additional_notes: category.additional_notes ?? false,
		positive: (category.positive ?? []).map(toEditableMainPoint),
		neutral: (category.neutral ?? []).map(toEditableMainPoint),
		negative: (category.negative ?? []).map(toEditableMainPoint),
	}));
}

function toServerMainPoint(mp: EditableMainPoint): Record<string, unknown> {
	return {
		main_point: mp.main_point,
		sub_points: mp.sub_points.map((sp) => {
			const item: Record<string, unknown> = { text: sp.text };
			if (sp.comment) item.comment = true;
			if (sp.point_deduction) item.point_deduction = true;
			return item;
		}),
	};
}

/** Rebuild the server shape from the draft (only truthy flags emitted). */
export function toServerCategories(categories: EditableCategory[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const category of categories) {
		out[category.key] = {
			title: category.title,
			additional_notes: category.additional_notes,
			positive: category.positive.map(toServerMainPoint),
			neutral: category.neutral.map(toServerMainPoint),
			negative: category.negative.map(toServerMainPoint),
		};
	}
	return out;
}

/** Client-side validation shared by the Visual + YAML editors. */
export function validateCategories(categories: EditableCategory[]): string | null {
	if (categories.length === 0) return "Add at least one category before saving.";
	for (const category of categories) {
		if (!category.key) return "Every category needs a key.";
		if (!/^[a-z0-9_]+$/.test(category.key)) {
			return `Category key "${category.key}" must be snake_case (lowercase letters, digits, underscores).`;
		}
		if (!category.title.trim()) return `Category "${category.key}" needs a title.`;
		for (const sentiment of SENTIMENTS) {
			for (const [mpi, mp] of category[sentiment].entries()) {
				// main_point MAY be "" — the schema uses it for ungrouped
				// items (see criteria-schema.md). Only sub-points require text.
				for (const [spi, sp] of mp.sub_points.entries()) {
					if (!sp.text.trim()) {
						return `Category "${category.key}" has an empty sub-point (${sentiment}[${mpi + 1}][${spi + 1}]).`;
					}
				}
			}
		}
	}
	return null;
}
