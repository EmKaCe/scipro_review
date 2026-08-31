/**
 * @file Root layout — teacher entrypoint redirect (2.8.0 wizard).
 *
 * The teacher build (__TEACHER_MODE__) lands on /onboarding until the
 * CORE setup is complete:
 *
 *   redirect = teacher && !dev && !coreComplete
 *
 * Core setup = create-assignment + wire-scoring + llm-provider (the
 * items that gate real grading). docs-index, executor and first-pipeline
 * never block the redirect — they are non-blocking steps.
 *
 * The persisted dismiss flag (POST /api/onboarding/dismiss →
 * data/wizard_state.json) is deliberately NOT consulted by the redirect:
 * a dismissed-but-incomplete install (stale wizard_state.json carried
 * over from an earlier session, or a wizard dismissed before the API key
 * was saved) must still land on the wizard — otherwise the teacher is
 * stranded on the dashboard with a misconfiguration banner and no way
 * back. This is the regression fixed 2026-08-31: the previous gate was
 * dismiss-only, so a stale `data/wizard_state.json` (not gitignored at
 * the time) silently disabled the wizard forever. The flag still exists
 * as the Done step's "Finish" record, but it no longer controls the
 * entrypoint.
 *
 * The onboarding route itself and every /api route are exempt (no
 * redirect loop, no interference with API calls). The student/static
 * build (__TEACHER_MODE__ false) and dev mode return {} immediately.
 *
 * The status probe is wrapped defensively: any network error or non-ok
 * response resolves {} — a broken status endpoint must never block the
 * app (and must never trap the user OUT of the wizard either, so an
 * unverifiable state also redirects — the wizard is re-scrollable/
 * finishable, cost is one extra visit). Each navigation costs one GET;
 * acceptable per the 2.8.0 plan.
 */
import { dev } from "$app/environment";
import { base } from "$app/paths";
import { isRedirect, redirect } from "@sveltejs/kit";
import type { LoadEvent } from "@sveltejs/kit";

export const ssr = false;
export const prerender = true;

/**
 * True when built/run with ADAPTER=node. Read through a typeof guard so
 * the identifier survives vitest (no define applied there) — the same
 * pattern copilot-store's apiMode uses. Evaluated per call, not at module
 * load, so tests can flip the runtime global.
 */
function teacherMode(): boolean {
	return typeof __TEACHER_MODE__ !== "undefined" && __TEACHER_MODE__;
}

/** The status items that gate the redirect (core grading setup). */
const CORE_ITEMS = ["create-assignment", "wire-scoring", "llm-provider"] as const;

export async function load(event: LoadEvent): Promise<Record<string, never>> {
	if (!teacherMode() || dev) return {};

	// Never redirect the onboarding surface itself or any API route.
	const pathname = event.url.pathname;
	const prefix = base || "";
	if (
		pathname === `${prefix}/onboarding` ||
		pathname.startsWith(`${prefix}/onboarding/`) ||
		pathname.startsWith(`${prefix}/api`)
	) {
		return {};
	}

	try {
		const statusResp = await fetch(`${base}/api/onboarding/status`);
		if (!statusResp.ok) throw new Error(`status probe failed (${statusResp.status})`);

		const status = (await statusResp.json()) as {
			items?: { id: string; done: boolean | null }[];
		};

		const byId = new Map((status.items ?? []).map((i) => [i.id, i.done === true]));
		const coreComplete = CORE_ITEMS.every((id) => byId.get(id) === true);

		if (!coreComplete) {
			throw redirect(307, `${base}/onboarding`);
		}
		return {};
	} catch (err) {
		// Rethrow the redirect itself (it is thrown, not an error); any
		// other failure means "don't block the app on a broken endpoint".
		if (isRedirect(err)) throw err;
		return {};
	}
}
