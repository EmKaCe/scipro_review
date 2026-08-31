/**
 * @file Root layout — teacher entrypoint redirect (2.8.0 wizard).
 *
 * The teacher build (__TEACHER_MODE__) lands on /onboarding until the
 * wizard is dismissed once — dismissal is the ONLY gate:
 *
 *   redirect = teacher && !dev && dismissed !== true
 *
 * Setup completeness deliberately does NOT gate the redirect: a
 * pre-provisioned install (restored backup, docker compose with a carried
 * over data/ directory, or a clone whose tracked config is already
 * complete) would otherwise never see the wizard — and the dismiss
 * semantics ("show once per fresh setup") make completeness the wrong
 * signal. Once the teacher finishes or skips the wizard, the persisted
 * flag (POST /api/onboarding/dismiss → data/wizard_state.json) means the
 * app opens straight to the dashboard from then on.
 *
 * The onboarding route itself and every /api route are exempt (no
 * redirect loop, no interference with API calls). The student/static
 * build (__TEACHER_MODE__ false) and dev mode return {} immediately.
 *
 * Probes are wrapped defensively: any network error or non-ok response
 * resolves {} — a broken status/dismiss endpoint must never block the
 * app (and must never trap the user OUT of the wizard either, so a
 * dismissed-but-unverifiable state also redirects — the wizard is
 * re-scrollable/finishable, cost is one extra visit). Each navigation
 * costs two GETs; acceptable per the 2.8.0 plan.
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
		const dismissResp = await fetch(`${base}/api/onboarding/dismiss`);
		if (!dismissResp.ok) throw new Error(`dismiss probe failed (${dismissResp.status})`);

		const dismiss = (await dismissResp.json()) as { dismissed?: boolean };
		if (dismiss.dismissed !== true) {
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
