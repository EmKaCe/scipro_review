/**
 * @file L4 component test — criteria-upload.
 *
 * Renders the upload control with a mocked submissions-api, drives the file
 * input + upload button: the success path calls uploadCriteria with the
 * assignment id and file and forwards the returned fileName via onUploaded;
 * a 400 rejection shows the message inline and does not fire onUploaded.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import CriteriaUpload from "$lib/components/assignments/criteria-upload.svelte";
import * as api from "$lib/services/submissions-api.js";

vi.mock("$lib/services/submissions-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof api>();
	return {
		...actual,
		uploadCriteria: vi.fn(),
	};
});

const mockedUpload = vi.mocked(api.uploadCriteria);

describe("CriteriaUpload", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uploads the selected file and forwards the persisted fileName", async () => {
		mockedUpload.mockResolvedValue({
			fileName: "data/criteria/soil_v2.yaml",
			criteria_files: ["data/criteria/general.yaml", "data/criteria/soil_v2.yaml"],
		});
		const onUploaded = vi.fn();

		render(CriteriaUpload, {
			props: { assignmentId: "soil_contamination", onUploaded },
		});

		const file = new File(["categories:\n  pandas:\n    title: Pandas\n"], "soil_v2.yaml", {
			type: "text/yaml",
		});
		const input = screen.getByLabelText("Criteria YAML file") as HTMLInputElement;
		await fireEvent.change(input, { target: { files: [file] } });

		await fireEvent.click(screen.getByRole("button", { name: "Upload criteria" }));

		await waitFor(() => {
			expect(mockedUpload).toHaveBeenCalledWith("soil_contamination", file);
			expect(onUploaded).toHaveBeenCalledWith("data/criteria/soil_v2.yaml");
		});
	});

	it("disables the upload button until a file is selected", () => {
		render(CriteriaUpload, {
			props: { assignmentId: "soil_contamination", onUploaded: vi.fn() },
		});

		const button = screen.getByRole("button", { name: "Upload criteria" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
	});

	it("shows a 400 message inline and does not fire onUploaded", async () => {
		mockedUpload.mockRejectedValue(
			Object.assign(
				new Error("category key code_formatting already exists in general.yaml"),
				{
					status: 400,
				},
			),
		);
		const onUploaded = vi.fn();

		render(CriteriaUpload, {
			props: { assignmentId: "soil_contamination", onUploaded },
		});

		const file = new File(["categories:\n  code_formatting: {}\n"], "dupe.yaml", {
			type: "text/yaml",
		});
		const input = screen.getByLabelText("Criteria YAML file") as HTMLInputElement;
		await fireEvent.change(input, { target: { files: [file] } });

		await fireEvent.click(screen.getByRole("button", { name: "Upload criteria" }));

		await waitFor(() => {
			expect(
				screen.getByText("category key code_formatting already exists in general.yaml"),
			).toBeTruthy();
		});
		expect(onUploaded).not.toHaveBeenCalled();
	});
});
