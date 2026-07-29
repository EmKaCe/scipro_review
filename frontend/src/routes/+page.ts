import { redirect } from "@sveltejs/kit";
import { dev } from "$app/environment";

/**
 * In teacher mode, redirect the root page to the submissions dashboard.
 * The student home remains at `/` only in student (static) builds.
 */
export function load() {
	if (!dev && __TEACHER_MODE__) {
		throw redirect(307, "/submissions");
	}
	return {};
}
