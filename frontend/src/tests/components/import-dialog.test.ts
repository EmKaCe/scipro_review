/**
 * @file Smoke tests for import-dialog.svelte
 *
 * Tests dialog rendering, drop zone display, file import callback,
 * and close button behavior.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/svelte";
import ImportDialog from "$lib/components/import-dialog.svelte";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("import-dialog.svelte", () => {
	it("renders nothing when open is false", () => {
		const { container } = render(ImportDialog, {
			open: false,
			onclose: vi.fn(),
			onimport: vi.fn(),
		});

		// Dialog should not be in the DOM when closed
		expect(container.textContent?.trim()).toBe("");
	});

	it("renders the dialog when open is true", () => {
		render(ImportDialog, {
			open: true,
			onclose: vi.fn(),
			onimport: vi.fn(),
		});

		// Dialog title should be visible
		expect(screen.getByText("Import Reviews")).toBeDefined();
	});

	it("renders the drop zone area", () => {
		render(ImportDialog, {
			open: true,
			onclose: vi.fn(),
			onimport: vi.fn(),
		});

		// Drop zone text should be visible
		expect(screen.getByText("Drag and drop files here")).toBeDefined();
	});

	it("renders the accept format hint", () => {
		render(ImportDialog, {
			open: true,
			onclose: vi.fn(),
			onimport: vi.fn(),
		});

		expect(screen.getByText(".yaml, .yml, .json")).toBeDefined();
	});

	it("calls onimport when a file is selected via the file input", async () => {
		const onimport = vi.fn();

		render(ImportDialog, {
			open: true,
			onclose: vi.fn(),
			onimport,
		});

		// Get the hidden file input
		const fileInput = document.getElementById("import-file-input") as HTMLInputElement;
		expect(fileInput).not.toBeNull();

		// Create a mock file and trigger selection
		const file = new File(["test content"], "test_review.yaml", { type: "text/yaml" });
		await fireEvent.change(fileInput, { target: { files: [file] } });

		// After selecting a file, the Import button should be enabled.
		// Click the Import button to trigger onimport
		const importButton = screen.getByText("Import");
		expect(importButton).not.toBeNull();
		await fireEvent.click(importButton);

		expect(onimport).toHaveBeenCalledWith(file, true);
	});

	it("calls onclose when Cancel button is clicked", async () => {
		const onclose = vi.fn();

		render(ImportDialog, {
			open: true,
			onclose,
			onimport: vi.fn(),
		});

		const cancelButton = screen.getByText("Cancel");
		expect(cancelButton).not.toBeNull();
		await fireEvent.click(cancelButton);

		expect(onclose).toHaveBeenCalledOnce();
	});

	it("calls onclose when X close button is clicked", async () => {
		const onclose = vi.fn();

		render(ImportDialog, {
			open: true,
			onclose,
			onimport: vi.fn(),
		});

		const closeButton = screen.getByLabelText("Close");
		expect(closeButton).not.toBeNull();
		await fireEvent.click(closeButton);

		expect(onclose).toHaveBeenCalledOnce();
	});

	it("calls onclose when Escape key is pressed", async () => {
		const onclose = vi.fn();

		render(ImportDialog, {
			open: true,
			onclose,
			onimport: vi.fn(),
		});

		const dialog = screen.getByRole("dialog");
		await fireEvent.keyDown(dialog, { key: "Escape" });

		expect(onclose).toHaveBeenCalledOnce();
	});

	it("shows file format badge after selecting a file", async () => {
		render(ImportDialog, {
			open: true,
			onclose: vi.fn(),
			onimport: vi.fn(),
		});

		const fileInput = document.getElementById("import-file-input") as HTMLInputElement;
		const file = new File(["test"], "review.yaml", { type: "text/yaml" });
		await fireEvent.change(fileInput, { target: { files: [file] } });

		// The badge text "YAML v2" should appear
		expect(screen.getByText("YAML v2")).toBeDefined();
	});

	it("shows read-only checkbox option", () => {
		render(ImportDialog, {
			open: true,
			onclose: vi.fn(),
			onimport: vi.fn(),
		});

		expect(screen.getByText("Open as read-only")).toBeDefined();
	});
});
