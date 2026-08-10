/**
 * @file Cross-route per-process persist lock.
 *
 * The results.json and metadata.json stores are single-file maps: parallel
 * read-modify-write sequences from different routes (batch process, batch
 * pre-evaluate) would clobber each other's updates (and collide on the
 * same-ms temp file). This module owns ONE promise chain shared by every
 * route that persists to those stores, so a pre-evaluation run and a
 * process run can never interleave their write sections — even though the
 * slow upstream calls (executor / KI Connect) stay outside the lock.
 *
 * Per-process in-memory state (single Node process in dev and Docker).
 */

let persistChain: Promise<void> = Promise.resolve();

/**
 * Serialize `fn` behind the shared lock: it runs after every previously
 * queued persist section (regardless of that section's outcome), and its
 * own failure never poisons the chain for later callers.
 */
export function withPersistLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = persistChain.then(fn, fn);
	persistChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}
