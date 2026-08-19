import { createContext, getContext, hasContext, setContext } from "svelte";

/**
 * Root tooltip state shared between Trigger, Content and Arrow.
 * Exposed as getters so sibling components read the LIVE $state values.
 */
export interface TooltipContext {
	readonly open: boolean;
	readonly stateAttr: string;
	readonly triggerId: string;
	readonly contentId: string;
	readonly pointerDown: boolean;
	readonly ignoreNonKeyboardFocus: boolean;
	readonly disabled: boolean;
	/** Open immediately (focus). */
	openTooltip: () => void;
	/** Open after the configured delay (pointer enter). */
	scheduleOpen: () => void;
	/** Close immediately (blur / escape / outside click). */
	closeTooltip: () => void;
	/** Pointer left the trigger: close or cancel the pending delay. */
	triggerLeave: () => void;
	/** Trigger clicked: close unless disableCloseOnTriggerClick. */
	toggleOnClick: () => void;
	setPointerDown: () => void;
	clearPointerDown: () => void;
}

/** Context handle provided by <Tooltip> and consumed by Trigger/Content/Arrow. */
export const tooltipRootContext = createContext<TooltipContext>();

/** Optional global defaults provided by <TooltipProvider> (app layout). */
export interface TooltipProviderContext {
	delayDuration: number;
	skipDelayDuration: number;
	disableHoverableContent: boolean;
}

const tooltipProviderKey = Symbol("tooltip-provider");

export function getTooltipProvider(): TooltipProviderContext | undefined {
	return hasContext(tooltipProviderKey)
		? getContext<TooltipProviderContext>(tooltipProviderKey)
		: undefined;
}

export function setTooltipProvider(ctx: TooltipProviderContext): TooltipProviderContext {
	return setContext(tooltipProviderKey, ctx);
}
