/**
 * @file L4 component test — assignment-selector (props-driven, no defaults).
 *
 * The selector renders EXACTLY what it is given via props: options come from
 * the `assignments` prop, the selection from `selected`, and user changes are
 * reported through `onChange`. There is deliberately no hardcoded default
 * array — the empty-options recurrence guard test below fails if anyone ever
 * reintroduces one.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

import AssignmentSelector from "$lib/components/submissions/assignment-selector.svelte";

const OPTIONS = [
	{ id: "soil_contamination", label: "Soil Contamination by Factories" },
	{ id: "a1-web-konzeption", label: "A1 — Web-Konzeption", disabled: true },
];

describe("AssignmentSelector", () => {
	it("renders enabled options from props and marks disabled ones disabled", () => {
		render(AssignmentSelector, {
			props: { assignments: OPTIONS, selected: "soil_contamination" },
		});

		const options = screen.getAllByRole("option") as HTMLOptionElement[];
		expect(options).toHaveLength(2);
		expect(options[0]!.value).toBe("soil_contamination");
		expect(options[0]!.textContent).toBe("Soil Contamination by Factories");
		expect(options[0]!.disabled).toBe(false);
		expect(options[1]!.value).toBe("a1-web-konzeption");
		expect(options[1]!.textContent).toBe("A1 — Web-Konzeption");
		expect(options[1]!.disabled).toBe(true);
	});

	it("recurrence guard: shows the empty placeholder when assignments=[] (no hardcoded defaults)", () => {
		const { container } = render(AssignmentSelector, {
			props: { assignments: [], selected: "" },
		});

		// The placeholder option is `hidden`, so it is excluded from the
		// accessibility tree — query the raw DOM.
		const options = container.querySelectorAll("select option");
		expect(options).toHaveLength(1);
		const placeholder = options[0] as HTMLOptionElement;
		expect(placeholder.value).toBe("");
		expect(placeholder.textContent).toBe("No assignments configured");
		expect(placeholder.disabled).toBe(true);
		expect(placeholder.hidden).toBe(true);
	});

	it("fires onChange with the selected value", async () => {
		const onChange = vi.fn();
		render(AssignmentSelector, {
			props: {
				assignments: [
					{ id: "soil_contamination", label: "Soil Contamination by Factories" },
					{ id: "atom_interaction", label: "Atom Interaction" },
				],
				selected: "soil_contamination",
				onChange,
			},
		});

		await fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "atom_interaction" },
		});

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith("atom_interaction");
	});
});
