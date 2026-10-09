// Install or update the avcs-view mod (#12): a status line and a pane, in
// chats whose folder is an abso folder, showing the space, the draft, who
// else is on the same files, and recent news. It goes into Claude Code's
// skills folder (~/.claude/skills/avcs-view, or the folder given), which
// every session on the machine loads when it starts; restart open chats to
// load a new install.
//
//   node client/install-view.ts [folder] [--rollback] [--unchecked]
//
// Like install-mod.ts, it stamps the mod with its commit, checks a staged
// copy before moving the files into place, and keeps the ones they replace
// for --rollback (src/install.ts). Its tests run in Claude Code's plugin test
// kit: node client/test-mods.ts

import { runInstaller, skillsFolder, VIEW_MOD } from "./src/install.ts";

runInstaller(VIEW_MOD, "install-view.ts", skillsFolder(VIEW_MOD.name));
