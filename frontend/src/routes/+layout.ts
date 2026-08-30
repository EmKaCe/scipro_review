/**
 * @file Root layout — teacher entrypoint redirect (2.8.0 wizard).
 *
 * The teacher build (__TEACHER_MODE__) lands on /onboarding until the core
 * setup items are complete or the wizard was dismissed once:
 *
 *   redirect = teacher && !dev && !coreComplete && !dismissed
 *
 * where coreComplete = llm-provider done:true AND create-assignment AND
 * wire-scoring both done:true (the seed step's items). docs-index and
 * first-pipeline NEVER gate the redirect — non-blocking steps. The
 * onboarding route itself and every /api route are exempt (no redirect
 * loop, no interference with API calls). The student/static build
 * (__TEACHER_MODE__ false) and dev mode return {} immediately.
 *
 * Both probes (status + dismiss) are wrapped defensively: any network
 * error or non-ok response resolves {} — a broken status endpoint must
 * never block the app. Each navigation costs two GETs; acceptable per
 * the 2.8.0 plan.
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
		const [statusResp, dismissResp] = await Promise.all([
			fetch(`${base}/api/onboarding/status`),
			fetch(`${base}/api/onboarding/dismiss`),
		]);
		if (!statusResp.ok || !dismissResp.ok) return {};

		const [status, dismiss] = (await Promise.all([
			statusResp.json(),
			dismissResp.json(),
		])) as [
			{ items?: { id: string; done: boolean | null }[] },
			{ dismissed?: boolean },
		];

		const byId = new Map((status.items ?? []).map((i) => [i.id, i]));
		const providerDone = byId.get("llm-provider")?.done === true;
		const assignmentDone = byId.get("create-assignment")?.done === true;
		const scoringDone = byId.get("wire-scoring")?.done === true;
		const coreComplete = providerDone && assignmentDone && scoringDone;

		if (!coreComplete && dismiss.dismissed !== true) {
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