/** @file Shared header configuration store — pages write to this, layout reads from it. */

/**
 * Reactive header configuration shared across pages.
 * Individual routes update these values to control the app header's appearance.
 */
export const headerConfig = $state<{
	/** Whether to show the back navigation button. */
	showBack?: boolean;
	/** Breadcrumb label displayed next to the back button. */
	breadcrumb?: string;
	/** Whether to show the save button. */
	showSave?: boolean;
	/** Callback invoked when the save button is clicked. */
	onsaveclick?: () => void;
	/** Whether to show the import button. */
	showImport: boolean;
	/** Callback invoked when the import button is clicked. */
	onimportclick?: () => void;
}>({
	showBack: false,
	breadcrumb: undefined,
	showSave: false,
	onsaveclick: undefined,
	showImport: false,
	onimportclick: undefined,
});
