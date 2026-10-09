// The abso client. Run it as:
//   node client/avcs.ts <command> [options]
// `abso help` lists the commands. `abso hook` is the Claude Code hook; it
// loads only what it needs, since every edit pays for its start-up.

import { enableCompileCache } from "node:module";

// Node keeps the compiled modules (TypeScript already stripped) in a cache in
// the temp folder. Loading the hook's modules drops from about 55 ms to 11 ms.
enableCompileCache();

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
	const result = await main(argv, {
		cwd: process.cwd(),
		env: process.env,
		write: (text) => process.stdout.write(text),
		writeErr: (text) => process.stderr.write(text),
	});
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exitCode = result.exit;
}
