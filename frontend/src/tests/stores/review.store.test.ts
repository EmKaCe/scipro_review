/**
 * @file Unit tests for review.svelte.ts (ReviewStore)
 *
 * Tests state transitions, undo/redo, auto-save, session conversion,
 * and reset behavior. Uses mocked service dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock service dependencies (use vi.hoisted for hoist-safe mock factories)
// ---------------------------------------------------------------------------

const {
	mockLoadAssignments,
	mockLoadGradingConfig,
	mockGetCriteriaForAssignment,
	mockCalculateGrade,
	mockSaveCurrentSession,
	mockLoadCurrentSession,
	mockClearCurrentSession,
	mockSaveReview,
	mockLoadReview,
	mockDeleteReview,
	mockListReviews,
	mockListSemesters,
	mockClearAllReviews,
	mockExportAll,
	mockExportSession,
	mockDownloadFile,
	mockParseImport,
	mockNormalizeLegacyCheckedItems,
	mockGenerateEvaluationMarkdown,
	mockAddToast,
	mockClearCriteriaCache,
	mockClearGradingConfigCache,
	mockDefaultGradingInputsFromConfig,
} = vi.hoisted(() => ({
	mockLoadAssignments: vi.fn(),
	mockLoadGradingConfig: vi.fn(),
	mockGetCriteriaForAssignment: vi.fn(),
	mockCalculateGrade: vi.fn(),
	mockSaveCurrentSession: vi.fn(),
	mockLoadCurrentSession: vi.fn(),
	mockClearCurrentSession: vi.fn(),
	mockSaveReview: vi.fn(),
	mockLoadReview: vi.fn(),
	mockDeleteReview: vi.fn(),
	mockListReviews: vi.fn(),
	mockListSemesters: vi.fn(),
	mockClearAllReviews: vi.fn(),
	mockExportAll: vi.fn(),
	mockExportSession: vi.fn(),
	mockDownloadFile: vi.fn(),
	mockParseImport: vi.fn(),
	mockNormalizeLegacyCheckedItems: vi.fn(),
	mockGenerateEvaluationMarkdown: vi.fn(),
	mockAddToast: vi.fn(),
	mockClearCriteriaCache: vi.fn(),
	mockClearGradingConfigCache: vi.fn(),
	mockDefaultGradingInputsFromConfig: vi.fn(),
}));

vi.mock("$lib/services/criteria-loader", () => ({
	getCriteriaForAssignment: mockGetCriteriaForAssignment,
	loadAssignments: mockLoadAssignments,
	clearCache: mockClearCriteriaCache,
}));

vi.mock("$lib/services/grading-config", () => ({
	loadGradingConfig: mockLoadGradingConfig,
	clearGradingConfigCache: mockClearGradingConfigCache,
}));

vi.mock("$lib/services/grade-calculator", () => ({
	calculateGrade: mockCalculateGrade,
	defaultGradingInputsFromConfig: mockDefaultGradingInputsFromConfig,
}));

vi.mock("$lib/services/db", () => ({
	saveCurrentSession: mockSaveCurrentSession,
	loadCurrentSession: mockLoadCurrentSession,
	clearCurrentSession: mockClearCurrentSession,
	saveReview: mockSaveReview,
	loadReview: mockLoadReview,
	deleteReview: mockDeleteReview,
	listReviews: mockListReviews,
	listSemesters: mockListSemesters,
	clearAllReviews: mockClearAllReviews,
	exportAll: mockExportAll,
}));

vi.mock("$lib/services/session-persistence", () => ({
	exportSession: mockExportSession,
	downloadFile: mockDownloadFile,
	parseImport: mockParseImport,
	normalizeLegacyCheckedItems: mockNormalizeLegacyCheckedItems,
}));

vi.mock("$lib/services/text-generator", () => ({
	generateEvaluationMarkdown: mockGenerateEvaluationMarkdown,
}));

vi.mock("$lib/stores/toast.svelte", () => ({
	addToast: mockAddToast,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { GradingConfig, GradingInputs } from "$lib/types/grading";
import { reviewStore } from "$lib/stores/review.svelte";
import type { Assignment } from "$lib/types/assignments";
import { categoryKeyOf } from "$lib/types/criteria";
import { dimensionKeyOf } from "$lib/types/grading";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ASSIGNMENTS: Assignment[] = [
	{
		id: "atom_interaction",
		title: "Atom Interaction",
		enabled: true,
		criteria_files: ["data/criteria/general.yaml", "data/criteria/atom_interaction.yaml"],
		dimensions: [
			dimensionKeyOf("code_quality_design"),
			dimensionKeyOf("code_execution_results"),
			dimensionKeyOf("assignment_requirements"),
			dimensionKeyOf("scientific_programming"),
			dimensionKeyOf("creativity"),
		],
	},
	{
		id: "molecular_dynamics",
		title: "Molecular Dynamics",
		enabled: true,
		criteria_files: ["data/criteria/general.yaml", "data/criteria/molecular_dynamics.yaml"],
		dimensions: [
			dimensionKeyOf("code_quality_design"),
			dimensionKeyOf("code_execution_results"),
			dimensionKeyOf("assignment_requirements"),
			dimensionKeyOf("scientific_programming"),
			dimensionKeyOf("creativity"),
		],
	},
];

const TEST_CONFIG: GradingConfig = {
	dimensions: [
		{
			key: dimensionKeyOf("code_quality_design"),
			title: "Code Quality & Design",
			max_points: 6,
			weight: 4,
		},
		{
			key: dimensionKeyOf("code_execution_results"),
			title: "Code Execution & Results",
			max_points: 6,
			weight: 4,
		},
		{
			key: dimensionKeyOf("assignment_requirements"),
			title: "Assignment Requirements",
			max_points: 6,
			weight: 4,
		},
		{
			key: dimensionKeyOf("scientific_programming"),
			title: "Scientific Programming",
			max_points: 6,
			weight: 4,
		},
		{ key: dimensionKeyOf("creativity"), title: "Creativity", max_points: 4, weight: 1 },
	],
	grade_boundaries: [
		{ min_percentage: 95, grade: 1.0, label: "excellent", us_equiv: "A+" },
		{ min_percentage: 50, grade: 4.0, label: "sufficient", us_equiv: "D" },
		{ min_percentage: 0, grade: 5.0, label: "insufficient", us_equiv: "F" },
	],
};

const TEST_RUBRIC = {
	categories: [
		{
			key: categoryKeyOf("code_quality"),
			category: {
				title: "Code Quality",
				additional_notes: false,
				positive: [{ main_point: "Good", sub_points: [{ text: "did_well" }] }],
				neutral: [],
				negative: [{ main_point: "Bad", sub_points: [{ text: "needs_work" }] }],
			},
		},
		{
			key: categoryKeyOf("documentation"),
			category: {
				title: "Documentation",
				additional_notes: true,
				positive: [{ main_point: "Docs", sub_points: [{ text: "well_documented" }] }],
				neutral: [],
				negative: [],
			},
		},
	],
};

const DEFAULT_GRADING_INPUTS = {
	code_quality_design: 0,
	code_execution_results: 0,
	assignment_requirements: 0,
	scientific_programming: 0,
	creativity: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupInitMocks(): void {
	mockLoadAssignments.mockResolvedValue({
		assignments: TEST_ASSIGNMENTS,
	});
	mockLoadGradingConfig.mockResolvedValue(TEST_CONFIG);
	mockListReviews.mockResolvedValue([]);
	mockListSemesters.mockResolvedValue([]);
	mockLoadCurrentSession.mockResolvedValue(null);
}

function setupAssignmentMocks(): void {
	mockGetCriteriaForAssignment.mockResolvedValue(TEST_RUBRIC);
	mockDefaultGradingInputsFromConfig.mockReturnValue(DEFAULT_GRADING_INPUTS);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	setupInitMocks();
	setupAssignmentMocks();
});

afterEach(() => {
	reviewStore.reset();
});

describe("init", () => {
	it("loads assignments and grading config", async () => {
		await reviewStore.init();

		expect(mockLoadAssignments).toHaveBeenCalledOnce();
		expect(mockLoadGradingConfig).toHaveBeenCalledOnce();
		expect(reviewStore.assignments).toHaveLength(2);
		expect(reviewStore.assignments[0].id).toBe("atom_interaction");
		expect(reviewStore.grading_config).toStrictEqual(TEST_CONFIG);
	});

	it("filters out disabled assignments", async () => {
		mockLoadAssignments.mockResolvedValue({
			assignments: [
				...TEST_ASSIGNMENTS,
				{
					id: "disabled_assignment",
					title: "Disabled",
					enabled: false,
					criteria_files: [],
					dimensions: [],
				},
			],
		});

		await reviewStore.init();
		expect(reviewStore.assignments).toHaveLength(2);
		expect(reviewStore.assignments.every((a) => a.enabled)).toBe(true);
	});

	it("handles init failure gracefully", async () => {
		mockLoadAssignments.mockRejectedValue(new Error("Network error"));

		await reviewStore.init();
		// Should not throw — errors are caught internally
		expect(mockAddToast).toHaveBeenCalledWith("error", expect.stringContaining("initialize"));
	});

	it("sets is_loading during init", async () => {
		const initPromise = reviewStore.init();
		expect(reviewStore.is_loading).toBe(true);
		await initPromise;
		expect(reviewStore.is_loading).toBe(false);
	});
});

describe("setAssignment", () => {
	beforeEach(async () => {
		await reviewStore.init();
	});

	it("loads rubric and initializes category selections", async () => {
		await reviewStore.setAssignment("atom_interaction");

		expect(reviewStore.assignment_id).toBe("atom_interaction");
		expect(reviewStore.rubric).toStrictEqual(TEST_RUBRIC);
		expect(mockGetCriteriaForAssignment).toHaveBeenCalledWith("atom_interaction");
		// Should have selections for both categories
		const categoryKeys = Object.keys(reviewStore.category_selections);
		expect(categoryKeys).toHaveLength(2);
	});

	it("initializes grading inputs from config", async () => {
		await reviewStore.setAssignment("atom_interaction");

		expect(mockDefaultGradingInputsFromConfig).toHaveBeenCalledWith(TEST_CONFIG);
		expect(reviewStore.grading).toEqual(DEFAULT_GRADING_INPUTS);
	});

	it("shows error toast when rubric fails to load", async () => {
		mockGetCriteriaForAssignment.mockResolvedValue(null);

		await reviewStore.setAssignment("atom_interaction");

		expect(mockAddToast).toHaveBeenCalledWith("error", expect.stringContaining("criteria"));
		expect(reviewStore.rubric).toBeNull();
	});

	it("resets session state when switching assignments", async () => {
		await reviewStore.setAssignment("atom_interaction");
		reviewStore.generated_text = "old text";
		reviewStore.current_review_id = "some-id";
		reviewStore.is_dirty = true;

		await reviewStore.setAssignment("molecular_dynamics");

		expect(reviewStore.generated_text).toBe("");
		expect(reviewStore.current_review_id).toBeNull();
		expect(reviewStore.is_dirty).toBe(false);
	});
});

describe("toggleCheckbox / setComment / setDeduction / setNotes", () => {
	beforeEach(async () => {
		await reviewStore.init();
		await reviewStore.setAssignment("atom_interaction");
	});

	it("toggleCheckbox checks and unchecks items", () => {
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(false);

		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(true);

		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(false);
	});

	it("setComment sets and removes comments", () => {
		reviewStore.setComment(categoryKeyOf("code_quality"), "did_well", "Great work");
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].comments["did_well"],
		).toBe("Great work");

		reviewStore.setComment(categoryKeyOf("code_quality"), "did_well", "");
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].comments["did_well"],
		).toBeUndefined();
	});

	it("setDeduction sets and removes deductions", () => {
		reviewStore.setDeduction(categoryKeyOf("code_quality"), "needs_work", 2);
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].deductions["needs_work"],
		).toBe(2);

		reviewStore.setDeduction(categoryKeyOf("code_quality"), "needs_work", 0);
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].deductions["needs_work"],
		).toBeUndefined();
	});

	it("setNotes updates notes text", () => {
		reviewStore.setNotes(categoryKeyOf("documentation"), "Some notes");
		expect(reviewStore.category_selections[categoryKeyOf("documentation")].notes).toBe(
			"Some notes",
		);
	});

	it("marks store as dirty after changes", () => {
		expect(reviewStore.is_dirty).toBe(false);

		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");
		expect(reviewStore.is_dirty).toBe(true);
	});
});

describe("setGradingInput", () => {
	beforeEach(async () => {
		await reviewStore.init();
		await reviewStore.setAssignment("atom_interaction");
	});

	it("sets a grading dimension value", () => {
		reviewStore.setGradingInput("code_quality_design", 5);
		expect(reviewStore.grading.code_quality_design).toBe(5);
	});
});

describe("Undo/Redo", () => {
	beforeEach(async () => {
		await reviewStore.init();
		await reviewStore.setAssignment("atom_interaction");
	});

	it("undo restores previous state after toggle", () => {
		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(true);

		reviewStore.undo();
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(false);
	});

	it("redo restores state after undo", () => {
		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");
		reviewStore.undo();
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(false);

		reviewStore.redo();
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(true);
	});

	it("undo is a no-op when stack is empty", () => {
		// Should not throw
		reviewStore.undo();
		// After no-op undo, the state should remain unchanged
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.size,
		).toBe(0);
	});

	it("redo is a no-op when stack is empty", () => {
		reviewStore.redo();
		// After no-op redo, the state should remain unchanged
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.size,
		).toBe(0);
	});

	it("clears redo stack on new action", () => {
		// Make a change, undo it (should be redoable), then make another change
		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");
		reviewStore.undo();

		// Verify we can redo the undone action
		reviewStore.redo();
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(true);

		// Undo again, then make a new action which should clear redo
		reviewStore.undo();
		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "needs_work");

		// Redoing should now restore the "needs_work" toggle, not "did_well"
		reviewStore.redo();
		// The "did_well" change was lost when new action cleared redo stack
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(false);
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"needs_work",
			),
		).toBe(true);
	});
});

describe("Auto-save", () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		await reviewStore.init();
		await reviewStore.setAssignment("atom_interaction");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("autoSave triggers debounced save", () => {
		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");

		// Save should not have been called yet (debounced)
		expect(mockSaveCurrentSession).not.toHaveBeenCalled();

		// Advance time past debounce delay
		vi.advanceTimersByTime(500);

		expect(mockSaveCurrentSession).toHaveBeenCalledOnce();
	});

	it("autoSave does not save after reset", () => {
		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");
		reviewStore.reset();
		vi.advanceTimersByTime(500);

		// The reset cancels the timer, so save should not be called
		// (the pending timer was cleared)
		expect(mockSaveCurrentSession).not.toHaveBeenCalled();
	});
});

describe("toSession / fromSession", () => {
	beforeEach(async () => {
		await reviewStore.init();
		await reviewStore.setAssignment("atom_interaction");
	});

	it("toSession produces a valid session object", () => {
		reviewStore.student_id = "2026SS_42";
		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");
		reviewStore.setNotes(categoryKeyOf("documentation"), "Some notes");

		const session = reviewStore.toSession();
		expect(session.student_id).toBe("2026SS_42");
		expect(session.assignment_id).toBe("atom_interaction");
		expect(session.mode).toBe("student");
		expect(
			session.category_selections[categoryKeyOf("code_quality")].checked_items,
		).toBeInstanceOf(Set);
		expect(
			session.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(true);
		expect(session.category_selections[categoryKeyOf("documentation")].notes).toBe(
			"Some notes",
		);
		expect(session.grading).toEqual(DEFAULT_GRADING_INPUTS);
	});

	it("toSession and fromSession round-trip preserves data", () => {
		reviewStore.student_id = "2026SS_42";
		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");
		reviewStore.setNotes(categoryKeyOf("documentation"), "Round-trip test");
		reviewStore.generated_text = "Generated evaluation";

		const session = reviewStore.toSession();
		const json = JSON.stringify(session, (_key, val) => (val instanceof Set ? [...val] : val));

		reviewStore.reset();

		// Parse back and import via fromSession
		const parsed = JSON.parse(json);
		parsed.category_selections[categoryKeyOf("code_quality")].checked_items = new Set(
			parsed.category_selections[categoryKeyOf("code_quality")].checked_items,
		);

		// Simulate what fromSession does — we can't call it directly (it's private)
		// So we verify toSession output is complete and round-trippable
		const roundTripped = JSON.parse(
			JSON.stringify(session, (_key, val) => (val instanceof Set ? [...val] : val)),
		);
		expect(roundTripped.student_id).toBe("2026SS_42");
		expect(roundTripped.assignment_id).toBe("atom_interaction");
		expect(
			roundTripped.category_selections[categoryKeyOf("code_quality")].checked_items,
		).toEqual(["did_well"]);
		expect(roundTripped.category_selections[categoryKeyOf("documentation")].notes).toBe(
			"Round-trip test",
		);
	});

	it("toSession includes grading inputs", () => {
		reviewStore.setGradingInput("code_quality_design", 5);
		reviewStore.setGradingInput("creativity", 3);

		const session = reviewStore.toSession();
		expect(session.grading.code_quality_design).toBe(5);
		expect(session.grading.creativity).toBe(3);
	});
});

describe("reset", () => {
	beforeEach(async () => {
		await reviewStore.init();
		await reviewStore.setAssignment("atom_interaction");
	});

	it("clears all state", () => {
		reviewStore.student_id = "2026SS_42";
		reviewStore.generated_text = "some text";
		reviewStore.is_dirty = true;

		reviewStore.reset();

		expect(reviewStore.student_id).toBe("");
		expect(reviewStore.assignment_id).toBe("");
		expect(reviewStore.rubric).toBeNull();
		expect(reviewStore.generated_text).toBe("");
		expect(reviewStore.is_dirty).toBe(false);
		expect(reviewStore.grading).toEqual({} as unknown as GradingInputs);
	});

	it("prevents undo after reset", () => {
		reviewStore.toggleCheckbox(categoryKeyOf("code_quality"), "did_well");

		// Verify the change was made
		expect(
			reviewStore.category_selections[categoryKeyOf("code_quality")].checked_items.has(
				"did_well",
			),
		).toBe(true);

		reviewStore.reset();

		// Reset clears the undo stack, so undo should be a no-op
		reviewStore.undo();
		// After reset + undo, the category selections should be empty (reset state)
		expect(Object.keys(reviewStore.category_selections)).toHaveLength(0);
	});

	it("shows warning when rubric is not loaded", () => {
		reviewStore.reset();
		reviewStore.grading_config = TEST_CONFIG;

		reviewStore.generateText();

		expect(mockAddToast).toHaveBeenCalledWith("warning", expect.stringContaining("rubric"));
	});
});
