// Install or update the abso mod in Claude Code's skills folder
// (~/.claude/skills/avcs, or the folder given), which every Claude Code
// session on the machine loads when it starts. A chat keeps the mod it
// started with, so restart open chats (or the app) to load a new install.
//
//   node client/install-mod.ts [folder] [--rollback] [--unchecked]
//
// It stamps the mod with the last commit that changed its files, checks a
// staged copy (claude plugin validate, then the mod's tests in the plugin
// test kit), and only then moves the files into place, keeping the ones they
// replace: --rollback puts those back. --unchecked skips the check. The files
// and the details are in src/install.ts.
//
// Once it's installed, `abso hook` (the command hook) stands down, so no edit
// is sent twice.

import { modDir } from "./src/hook.ts";
import { AVCS_MOD, runInstaller } from "./src/install.ts";

runInstaller(AVCS_MOD, "install-mod.ts", modDir());
