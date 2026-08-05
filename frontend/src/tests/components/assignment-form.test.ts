/**
 * @file L4 component test — assignment-form.
 *
 * Renders the create/edit form, asserts the 5 dimension checkboxes and the
 * id/title/enabled/criteria_files fields, and drives submit: a valid submit
 * calls onSubmit with the parsed payload (criteria_files split on commas,
 * dimensions from the checkboxes), an empty title is blocked client-side,
 * and a server rejection surfaces inline.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

import AssignmentForm from "$lib/components/assignments/assignment-form.svelte";
import type { AssignmentSummary } from "$lib/services/submissions-api.js";

const DIMENSIONS = [
	"code_quality_design",
	"code_execution_results",
	"assignment_requirements",
	"scientific_programming",
	"creativity",
];

const EXISTING: AssignmentSummary = {
	id: "soil_contamination",
	title: "Soil Contamination by Factories",
	enabled: true,
	criteria_files: ["data/criteria/general.yaml"],
};

describe("AssignmentForm", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders the 5 known dimension checkboxes plus the core fields", () => {
		render(AssignmentForm, { props: { initial: null, onSubmit: vi.fn() } });

		expect(screen.getByLabelText("Id")).toBeTruthy();
		expect(screen.getByLabelText("Title")).toBeTruthy();
		expect(screen.getByLabelText("Criteria files")).toBeTruthy();

		for (const dim of DIMENSIONS) {
			expect(screen.getByRole("checkbox", { name: dim })).toBeTruthy();
		}
	});

	it("submits the parsed payload including dimensions and comma-split criteria_files", async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		render(AssignmentForm, { props: { initial: null, onSubmit } });

		await fireEvent.input(screen.getByLabelText("Id"), {
			target: { value: "quantum_chemistry" },
		});
		await fireEvent.input(screen.getByLabelText("Title"), {
			target: { value: "Quantum Chemistry" },
		});
		await fireEvent.input(screen.getByLabelText("Criteria files"), {
			target: { value: "data/criteria/general.yaml, data/criteria/quantum_chemistry.yaml" },
		});
		// Uncheck the last dimension to prove the payload reflects the checkboxes.
		await fireEvent.click(screen.getByRole("checkbox", { name: "creativity" }));

		await fireEvent.click(screen.getByRole("button", { name: "Create assignment" }));

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith({
			id: "quantum_chemistry",
			title: "Quantum Chemistry",
			enabled: true,
			criteria_files: ["data/criteria/general.yaml", "data/criteria/quantum_chemistry.yaml"],
			dimensions: [
				"code_quality_design",
				"code_execution_results",
				"assignment_requirements",
				"scientific_programming",
			],
		});
	});

	it("blocks submit client-side when the title is empty", async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		render(AssignmentForm, { props: { initial: null, onSubmit } });

		await fireEvent.input(screen.getByLabelText("Id"), {
			target: { value: "empty_title" },
		});
		await fireEvent.input(screen.getByLabelText("Title"), {
			target: { value: "   " },
		});

		await fireEvent.click(screen.getByRole("button", { name: "Create assignment" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText("Title is required")).toBeTruthy();
	});

	it("blocks submit client-side when no dimension is checked", async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		render(AssignmentForm, { props: { initial: null, onSubmit } });

		await fireEvent.input(screen.getByLabelText("Title"), {
			target: { value: "No dimensions" },
		});
		for (const dim of DIMENSIONS) {
			await fireEvent.click(screen.getByRole("checkbox", { name: dim }));
		}

		await fireEvent.click(screen.getByRole("button", { name: "Create assignment" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText("Select at least one dimension")).toBeTruthy();
	});

	it("prefills the form when editing and disables the id field", () => {
		render(AssignmentForm, {
			props: { initial: EXISTING, onSubmit: vi.fn() },
		});

		const idInput = screen.getByLabelText("Id") as HTMLInputElement;
		expect(idInput.value).toBe("soil_contamination");
		expect(idInput.disabled).toBe(true);
		expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
			"Soil Contamination by Factories",
		);
		expect((screen.getByLabelText("Criteria files") as HTMLInputElement).value).toBe(
			"data/criteria/general.yaml",
		);
		expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
	});

	it("surfaces a server rejection as an inline error", async () => {
		const onSubmit = vi.fn().mockRejectedValue(new Error('Assignment "x" already exists'));
		render(AssignmentForm, { props: { initial: null, onSubmit } });

		await fireEvent.input(screen.getByLabelText("Id"), {
			target: { value: "x" },
		});
		await fireEvent.input(screen.getByLabelText("Title"), {
			target: { value: "Duplicate" },
		});

		await fireEvent.click(screen.getByRole("button", { name: "Create assignment" }));

		expect(onSubmit).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => {
			expect(screen.getByText('Assignment "x" already exists')).toBeTruthy();
		});
	});
});
