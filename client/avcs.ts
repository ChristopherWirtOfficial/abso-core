// The abso client. Run it as:
//   node client/avcs.ts <command> [options]
// `abso help` lists the commands. `abso hook` is the Claude Code hook; it
// loads only what it needs, since every edit pays for its start-up.

import * as nodeModule from "node:module";

// Node keeps the compiled modules (TypeScript already stripped) in a cache in
// the temp folder. Loading the hook's modules drops from about 55 ms to 11 ms.
// Node 20 has no compile cache, and the built client runs there without one.
(nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();

const argv = process.argv.slice(2);

if (argv[0] === "hook") {
	const { runHook } = await import("./src/hook.ts");
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const result = await runHook(Buffer.concat(chunks).toString("utf8"));
	if (result.stdout) process.stdout.write(result.stdout);
	// Always 0: the hook never stops the agent.
	process.exitCode = 0;
} else if (argv[0] === "mcp") {
	// An MCP server on stdin and stdout, for as long as the client keeps it open.
	const { serveMcp } = await import("./src/mcp.ts");
	await serveMcp(process.stdin, (line) => process.stdout.write(`${line}\n`), process.cwd(), process.env);
} else {
	const { main } = await import("./src/main.ts");
	// Everything printed goes through terminalText: most of it is a server's text (abso-core's terminal-text.ts).
	const { colorsPass, terminalText } = await import("./src/terminal-text.ts");
	const out = (text: string) => process.stdout.write(terminalText(text, colorsPass(process.stdout, process.env)));
	const err = (text: string) => process.stderr.write(terminalText(text, colorsPass(process.stderr, process.env)));
	const result = await main(argv, { cwd: process.cwd(), env: process.env, write: out, writeErr: err });
	if (result.stdout) out(result.stdout);
	if (result.stderr) err(result.stderr);
	process.exitCode = result.exit;
}
