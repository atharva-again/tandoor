import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-pinned-deps.mjs", import.meta.url));

async function check(t, manifest) {
	const root = await mkdtemp(join(tmpdir(), "pi-pinned-deps-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "package.json"), JSON.stringify(manifest));
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

test("rejects external registry dependency ranges in every direct dependency section", async (t) => {
	const result = await check(t, {
		dependencies: {
			"@earendil-works/pi-agent-core": "^1.2.0",
			"@earendil-works/chord": "~1.2.0",
			external: "^1.0.0",
		},
		devDependencies: { externalDev: "1.x" },
		optionalDependencies: { externalOptional: "*" },
	});
	assert.equal(result.status, 1);
	for (const dependency of [
		"dependencies.external",
		"devDependencies.externalDev",
		"optionalDependencies.externalOptional",
	]) {
		assert.ok(result.stderr.includes(`${dependency} must be pinned`), result.stderr);
	}
	assert.doesNotMatch(result.stderr, /@earendil-works\//);
});

test("accepts internal ranges, exact external versions, exact registry aliases, and non-registry specifiers", async (t) => {
	const result = await check(t, {
		dependencies: {
			"@earendil-works/pi-agent-core": "^1.2.0",
			"@earendil-works/chord": "~1.2.0",
			external: "1.0.0",
			alias: "npm:@earendil-works/pi-ai@1.1.0",
			local: "file:../local",
			workspace: "workspace:*",
		},
		devDependencies: { externalDev: "1.2.0" },
		optionalDependencies: { externalOptional: "1.2.0-rc.1" },
	});
	assert.equal(result.status, 0, result.stderr);
});

test("rejects registry alias ranges", async (t) => {
	const result = await check(t, {
		dependencies: { alias: "npm:@earendil-works/pi-ai@^1.2.0" },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /dependencies\.alias must be pinned/);
});
