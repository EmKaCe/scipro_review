#!/usr/bin/env node
/**
 * @file criteria-export.mjs — copy teacher-authored criteria from a runtime
 * data dir into the repo's tracked data/ tree (host / migration helper).
 *
 * Since the single-source-tree model (Docker compose binds ./data straight
 * into /app/data) the app writes criteria DIRECTLY into the repo tree — no
 * export step exists in the UI or normal Docker workflow. This script is only
 * for setups that keep DATA_DIR outside the repo clone (hand-rolled
 * deployments, or recovering data from a pre-2.6 named-volume install):
 * it copies the shared files back so they can be committed.
 *
 * Copies:            assignments.yaml, grading_config.yaml,
 *                    criteria/*.yaml, scoring/*.yaml
 * Never touches:     submissions/, materials/, copilot/, plagiarism/,
 *                    settings.yaml, .env  (internals stay untracked)
 *
 * Usage:
 *   node frontend/scripts/criteria-export.mjs \
 *     --data-dir /path/to/runtime/data --apply
 *
 * Default is a DRY RUN (prints what would change). Pass --apply to write.
 * Exit code 0 even when nothing changed.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_DATA = path.join(ROOT, "data");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const dataDirArg = argValue(args, "--data-dir");

const SOURCE =
	dataDirArg ??
	process.env.SCIPRO_DATA_DIR ??
	((await dirExists("/app/data")) ? "/app/data" : null);

if (!SOURCE) {
	console.error(
		"criteria-export: cannot find the runtime data dir.\n" +
			"  • Run inside the container:  docker compose exec frontend node scripts/criteria-export.mjs --apply\n" +
			"  • Or pass the volume path:    node .../criteria-export.mjs --data-dir /path/to/volume/_data --apply",
	);
	process.exit(2);
}

const plan = await collectPlan(SOURCE, REPO_DATA);
const changed = plan.filter((i) => i.status !== "unchanged");

if (changed.length === 0) {
	console.log("criteria-export: nothing to copy (all shared files already match the repo).");
	process.exit(0);
}

console.log(`criteria-export: ${APPLY ? "COPYING" : "DRY RUN —"} ${SOURCE} → ${REPO_DATA}`);
for (const item of changed) {
	console.log(`  ${item.status === "add" ? "ADD    " : "CHANGE "} ${item.relative}`);
}
console.log(`  ${changed.length} file(s) to write.`);

if (!APPLY) {
	console.log("\nRe-run with --apply to write. Then commit:");
	console.log('  git add data && git commit -m "criteria: export authored changes"');
	process.exit(0);
}

for (const item of changed) {
	await copyFile(item.source, item.dest);
}
console.log(`criteria-export: wrote ${changed.length} file(s). Commit them with:`);
console.log('  git add data && git commit -m "criteria: export authored changes"');
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
			await planFile(
				subSource,
				path.join(destDir, dir),
				fileName,
				`${dir}/${fileName}`,
				plan,
			);
		}
	}
	return plan;
}

async function planFile(sourceDir, destDir, name, label, plan) {
	const source = path.join(sourceDir, name);
	const dest = path.join(destDir, name);
	if (!(await fileExists(source))) return;
	const destHash = await sha256(dest).catch(() => null);
	const status =
		destHash === null ? "add" : destHash === (await sha256(source)) ? "unchanged" : "change";
	plan.push({ status, relative: label, source, dest });
}

async function copyFile(source, dest) {
	await mkdir(path.dirname(dest), { recursive: true });
	await writeFile(dest, await readFile(source));
}

async function sha256(file) {
	return createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
}

async function fileExists(p) {
	return readFile(p).then(
		() => true,
		() => false,
	);
}

async function dirExists(p) {
	return readdir(p).then(
		() => true,
		() => false,
	);
}

function argValue(args, flag) {
	const i = args.indexOf(flag);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
