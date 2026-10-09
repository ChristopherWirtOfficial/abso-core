// Loaded before every test file (npm test: node --import). New folders are made as .abso or .avcs by what mods
// are installed (state-dir.ts newFolderDir), so a test must not read this machine's ~/.claude: it gets a Claude
// folder with one mod from before the rename installed, which keeps new folders on .avcs. The tests of that
// choice (new-folder-dir.test.ts) pass their own folders.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claude = mkdtempSync(join(tmpdir(), "abso-test-claude-"));
const mod = join(claude, "skills", "avcs");
mkdirSync(mod, { recursive: true });
writeFileSync(join(mod, ".avcs-install.json"), JSON.stringify({ mod: "avcs", version: "0.1.0+0000000" }));
process.env.CLAUDE_CONFIG_DIR = claude;
