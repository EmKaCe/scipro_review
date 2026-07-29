import { redirect } from "@sveltejs/kit";
import { dev } from "$app/environment";
import { base } from "$app/paths";

export const prerender = false;

/**
 * Teacher-mode guard.
 * Redirects to the home page when __TEACHER_MODE__ is false (static/student build).
 * In dev mode the route is always accessible for testing regardless of the flag.
 */
export function load() {
	if (!dev && !__TEACHER_MODE__) {
		throw redirect(307, base || "/");
	}
	return {};
}
