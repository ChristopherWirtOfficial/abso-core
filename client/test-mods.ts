// Run the two mods' tests in Claude Code's plugin test kit:
//
//   node client/test-mods.ts
//
// `claude plugin test <dir>` runs every *.test.ts under dir, and the avcs
// mod's plugin folder is all of client/ (its tests and the view's included),
// so each mod is installed into a folder of its own with its test, and the kit
// runs there. Needs the claude CLI.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MODS = [
	{ name: "avcs", install: "install-mod.ts", test: "hooks/register.test.ts", from: here },
	{ name: "avcs-view", install: "install-view.ts", test: "hooks/register.test.ts", from: join(here, "view") },
];

let failed = false;
for (const mod of MODS) {
	const dir = mkdtempSync(join(tmpdir(), `${mod.name}-mod-`));
	try {
		// --unchecked: the install's own check would run these same tests first.
		spawnSync(process.execPath, [join(here, mod.install), dir, "--unchecked"], { stdio: "ignore" });
		copyFileSync(join(mod.from, ...mod.test.split("/")), join(dir, ...mod.test.split("/")));
		console.log(`--- ${mod.name}`);
		const r = spawnSync("claude", ["plugin", "test", dir], { stdio: "inherit", shell: process.platform === "win32" });
		if (r.status !== 0) failed = true;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
process.exit(failed ? 1 : 0);
