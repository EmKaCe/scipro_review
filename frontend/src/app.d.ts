// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	/** Application version string injected by Vite from package.json. */
	const APP_VERSION: string;
	/** True when built/run with ADAPTER=node (teacher Docker mode). */
	const __TEACHER_MODE__: boolean;
}

export {};
