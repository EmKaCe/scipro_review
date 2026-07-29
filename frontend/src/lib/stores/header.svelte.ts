/** @file Shared header configuration store — pages write to this, layout reads from it. */

/**
 * Reactive header configuration shared across pages.
 * Individual routes update these values to control the app header's appearance.
 */
export const headerConfig = $state<{
	/** Whether to show the back navigation button (ChevronLeft). */
	showBack?: boolean;
	/** Breadcrumb label displayed after "SciPro Review / Submissions". */
	breadcrumb?: string;
	/** Whether to show the save grade button. */
	showSave?: boolean;
	/** Callback invoked when the save button is clicked. */
	onsaveclick?: () => void;
	/** Whether to show the export YAML button. */
	showExport?: boolean;
	/** Callback invoked when the export button is clicked. */
	onexportclick?: () => void;
	/** Whether to show the import button. */
	showImport: boolean;
	/** Callback invoked when the import button is clicked. */
	onimportclick?: () => void;
	/**
	 * Header visual state.
	 * - "dashboard": no back button, "Submissions" is static text, no action buttons
	 * - "submission": back button visible, "Submissions" is clickable link, action buttons shown
	 */
	headerState?: "dashboard" | "submission";
}>({
	showBack: false,
	breadcrumb: undefined,
	showSave: false,
	onsaveclick: undefined,
	showExport: false,
	onexportclick: undefined,
	showImport: false,
	onimportclick: undefined,
	headerState: "dashboard",
});
