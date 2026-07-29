/**
 * @file Stub submissions data service.
 *
 * Phase 2: Returns hardcoded mock data.
 * Phase 3: Replaced with fetch() calls to /api/submissions endpoints.
 *
 * The interface stays the same — only the implementation changes.
 */

import type { SubmissionMeta, SubmissionDetail } from "$lib/types/submissions.js";

// ---------------------------------------------------------------------------
// Stub data
// ---------------------------------------------------------------------------

const STUB_METAS: SubmissionMeta[] = [
	{
		id: "1",
		studentId: "2026SS_03",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "executed",
		cellSummary: "6 cells, 1 diff",
		createdAt: "2026-07-28T10:00:00Z",
		updatedAt: "2026-07-28T10:05:00Z",
	},
	{
		id: "2",
		studentId: "2026SS_07",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "error",
		createdAt: "2026-07-28T10:01:00Z",
		updatedAt: "2026-07-28T10:04:00Z",
	},
	{
		id: "3",
		studentId: "2026SS_12",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "pre-evaluated",
		cellSummary: "6 cells, 2 diff",
		preEvalGrade: 2.7,
		createdAt: "2026-07-28T10:02:00Z",
		updatedAt: "2026-07-28T10:06:00Z",
	},
	{
		id: "4",
		studentId: "2026SS_17",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "graded",
		cellSummary: "6 cells, 0 diff",
		preEvalGrade: 1.3,
		teacherGrade: 1.7,
		createdAt: "2026-07-28T10:03:00Z",
		updatedAt: "2026-07-28T10:10:00Z",
	},
	{
		id: "5",
		studentId: "2026SS_22",
		assignmentId: "soil_contamination",
		semester: "2026SS",
		status: "pending",
		createdAt: "2026-07-28T10:08:00Z",
		updatedAt: "2026-07-28T10:08:00Z",
	},
];

const STUB_DETAILS: Record<string, SubmissionDetail> = {
	"1": {
		...STUB_METAS[0],
		status: "executed",
		cells: [
			{ index: 0, type: "markdown", source: "# Data Loading\n", marker: "different" },
			{
				index: 1,
				type: "code",
				source: 'import pandas as pd\ndf = pd.read_csv("soil_samples.csv")\n',
				output: "Dataset loaded: (50, 6)",
				marker: "different",
			},
			{
				index: 2,
				type: "code",
				source: "from sklearn.cluster import KMeans\nkmeans = KMeans(n_clusters=3)\n",
				output: "KMeans(n_clusters=3)",
				marker: "same",
			},
			{
				index: 3,
				type: "code",
				source: "clusters = kmeans.fit_predict(df[['x', 'y']])",
				output: "Cluster labels assigned",
				marker: "different",
			},
			{
				index: 4,
				type: "code",
				source: "from scipy.optimize import curve_fit\nresult = curve_fit(model_func, x, y)",
				output: "Optimization converged",
				marker: "different",
			},
			{
				index: 5,
				type: "markdown",
				source: "## Results\nThe clustering shows three distinct zones...",
				marker: "different",
			},
		],
	},
	"3": {
		...STUB_METAS[2],
		cells: [
			{ index: 0, type: "markdown", source: "# Analysis\n", marker: "different" },
			{
				index: 1,
				type: "code",
				source: "import numpy as np\nimport pandas as pd\n",
				output: "",
				marker: "different",
			},
			{
				index: 2,
				type: "code",
				source: 'df = pd.read_csv("soil_samples.csv")',
				output: "(50, 6)",
				marker: "same",
			},
			{
				index: 3,
				type: "code",
				source: "kmeans = KMeans(n_clusters=4, random_state=0)\ndf['cluster'] = kmeans.fit_predict(df[['x','y']])",
				output: "",
				marker: "questionable",
			},
			{
				index: 4,
				type: "code",
				source: "result = curve_fit(model_func, x_data, y_data)",
				error: "NameError: name 'curve_fit' is not defined\nDid you forget to import from scipy.optimize?",
				marker: "error",
			},
			{
				index: 5,
				type: "markdown",
				source: "## Comments\nGood results overall.",
				marker: "different",
			},
		],
	},
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return all stub submissions for the dashboard. */
export function listSubmissions(): SubmissionMeta[] {
	return [...STUB_METAS];
}

/** Return a single submission's full detail, or null if not found. */
export function getSubmission(id: string): SubmissionDetail | null {
	return STUB_DETAILS[id] ?? null;
}
