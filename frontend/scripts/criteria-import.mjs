#!/usr/bin/env node
/**
 * @file criteria-import.mjs — copy shared criteria from the repo's tracked
 * data/ tree into a runtime data dir (migration helper).
 *
 * Since the single-source-tree model (Docker compose binds ./data straight
 * into /app/data) the app reads criteria directly from the repo tree — a
 * pull is instantly live and NO import step exists in the normal Docker
 * workflow. This script exists for migrating a pre-2.6 named-volume install
 * (`svelte-review-data`) into the repo clone, and for hand-rolled setups
 * that keep DATA_DIR outside the clone.
 *
 *   Migration (one-time, before switching to the bind-mounted compose):
 *     docker run --rm -v svelte-review-data:/src \
 *       -v "$PWD/data:/dst" alpine sh -c "cp -rn /src/. /dst/"
 *
 *   Import from repo (non-Docker DATA_DIR):
 *     node frontend/scripts/criteria-import.mjs \
 *       --data-dir /path/to/runtime/data --apply
 *
 * Safety: any destination file that differs from the repo copy is backed up
 * to <data-dir>/.criteria-backup-<timestamp>/ BEFORE being overwritten, so a
 * pull that conflicts with local teacher-authored edits is never destructive.
 *
 * Copies:            assignments.yaml, grading_config.yaml,
 *                    criteria/*.yaml, scoring/*.yaml
 * Never touches:     submissions/, materials/, copilot/, plagiarism/,
 *                    settings.yaml, .env  (internals stay untracked)
 *
 * Default is a DRY RUN. Pass --apply to write.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_DATA = path.join(ROOT, "data");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const dataDirArg = argValue(args, "--data-dir");

const DEST =
	dataDirArg ??
	process.env.SCIPRO_DATA_DIR ??
	((await dirExists("/app/data")) ? "/app/data" : null);

if (!DEST) {
	console.error(
		"criteria-import: cannot find the runtime data dir.\n" +
			"  • Run inside the container:  docker compose exec frontend node scripts/criteria-import.mjs --apply\n" +
			"  • Or pass the volume path:    node .../criteria-import.mjs --data-dir /path/to/volume/_data --apply",
	);
	process.exit(2);
}

const plan = await collectPlan(REPO_DATA, DEST);
const changed = plan.filter((i) => i.status !== "unchanged");

if (changed.length === 0) {
	console.log("criteria-import: nothing to copy (volume already matches the repo).");
	process.exit(0);
}

console.log(`criteria-import: ${APPLY ? "COPYING" : "DRY RUN —"} ${REPO_DATA} → ${DEST}`);
for (const item of changed) {
	console.log(`  ${item.status === "add" ? "ADD    " : "CHANGE "} ${item.relative}`);
}
console.log(`  ${changed.length} file(s) to write.`);

if (!APPLY) {
	console.log("\nRe-run with --apply to write. Changed destination files are backed up first.");
	process.exit(0);
}

// Back up every destination file that will be overwritten.
const backupDir = path.join(DEST, `.criteria-backup-${Date.now()}`);
const overwritten = changed.filter((i) => i.status === "change");
if (overwritten.length > 0) {
	await mkdir(backupDir, { recursive: true });
	for (const item of overwritten) {
		await cp(item.dest, path.join(backupDir, item.relative), { recursive: true });
	}
	console.log(`criteria-import: backed up ${overwritten.length} local file(s) to ${backupDir}`);
}

for (const item of changed) {
	await copyFile(item.source, item.dest);
}
console.log(`criteria-import: wrote ${changed.length} file(s) from the repo.`);
process.exit(0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect the copy plan for the shared files that differ or are missing. */
async function collectPlan(sourceDir, destDir) {
	const plan = [];
	for (const name of ["assignments.yaml", "grading_config.yaml"]) {
		await planFile(sourceDir, destDir, name, name, plan);
	}
	for (const dir of ["criteria", "scoring"]) {
		const subSource = path.join(sourceDir, dir);
		if (!(await dirExists(subSource))) continue;
		for (const fileName of (await readdir(subSource)).filter((f) => f.endsWith(".yaml"))) {
			await planFile(subSource, path.join(destDir, dir), fileName, `${dir}/${fileName}`, plan);
		}
	}
	return plan;
}

async function planFile(sourceDir, destDir, name, label, plan) {
	const source = path.join(sourceDir, name);
	const dest = path.join(destDir, name);
	if (!(await fileExists(source))) return;
	const destHash = await sha256(dest).catch(() => null);
	const status = destHash === null ? "add" : destHash === (await sha256(source)) ? "unchanged" : "change";
	plan.push({ status, relative: label, source, dest });
}

async function copyFile(source, dest) {
	await mkdir(path.dirname(dest), { recursive: true });
	await writeFile(dest, await readFile(source));
}

async function sha256(file) {
	return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function fileExists(p) {
	return readFile(p).then(() => true, () => false);
}

async function dirExists(p) {
	return readdir(p).then(() => true, () => false);
}

function argValue(args, flag) {
	const i = args.indexOf(flag);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}