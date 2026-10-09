// abso mcp: an MCP server on stdin and stdout (#42, #44). Each tool is one avcs
// command, run by the same code as the command line and answering with the
// same text, so the CLI and the tools can't drift apart and an agent learns
// one set of words. The folder and the token come from where the server runs,
// as for the CLI: .avcs/config.json, and AVCS_TOKEN or ~/.avcs/token.
//
//   claude mcp add avcs -- node <repo>/client/avcs.ts mcp
//
// The protocol is JSON-RPC 2.0, one message per line, with no library: the
// client uses nothing outside Node.

import { resolve } from "node:path";
import { clientVersion } from "./client-version.ts";
import { commandTable, main } from "./main.ts";

/**
 * The commands served as tools: reading, and the writes an agent makes every
 * day. The box commands (run, shot, bisect, prep, logs, fetch) stream for
 * minutes and stay in the shell, as do setting a folder up (init, join) and
 * the ones that rewrite history or move between drafts.
 */
export const MCP_COMMANDS = [
	"status",
	"log",
	"show",
	"diff",
	"files",
	"who",
	"where",
	"blame",
	"why",
	"ci",
	"news",
	"announce",
	"start",
	"record",
	"sync",
	"publish",
	"unqueue",
	"restore",
	"settle",
	"check-ignore",
	"labels",
	"mv",
	"review",
	"note",
	"notes",
	"issues",
	"issue",
	"search",
	"ask",
	"waiting",
	"answer",
] as const;

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface Tool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

/** A tool's name: the command, with _ for - (check-ignore is check_ignore). */
const toolName = (command: string): string => command.replace(/-/g, "_");

export function mcpTools(): Tool[] {
	const table = commandTable();
	return MCP_COMMANDS.map((command) => {
		const def = table[command]!;
		const flags = Object.fromEntries(
			Object.entries(def.flags).map(([flag, kind]) => [
				flag,
				kind === "boolean"
					? { type: "boolean", description: `--${flag}` }
					: {
							type: "string",
							description: kind === "optional" ? `--${flag} "<value>"; "" gives --${flag} alone` : `--${flag} <value>`,
						},
			]),
		);
		return {
			name: toolName(command),
			description: `${def.usage}\n${def.about}`,
			inputSchema: {
				type: "object",
				properties: {
					args: {
						type: "array",
						items: { type: "string" },
						description: "The words after the command, as on the command line: files, versions, text.",
					},
					folder: {
						type: "string",
						description: "The abso folder to run in (default: the folder this server started in).",
					},
					json: { type: "boolean", description: "Answer with the command's JSON (as --json) instead of its text." },
					...flags,
				},
				additionalProperties: false,
			},
		};
	});
}

/** The command line a tool call stands for: flags as --name=value, then the words after --. */
export function argvFor(command: string, input: Readonly<Record<string, unknown>>): string[] {
	const def = commandTable()[command]!;
	const argv = [command];
	for (const [flag, kind] of Object.entries(def.flags)) {
		const value = input[flag];
		if (value === undefined || value === null || value === false) continue;
		if (kind === "boolean") argv.push(`--${flag}`);
		else argv.push(`--${flag}=${String(value)}`);
	}
	const words = Array.isArray(input.args) ? input.args.map(String) : [];
	if (words.length > 0) argv.push("--", ...words);
	return argv;
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/**
 * Serve MCP on `lines` (each one JSON-RPC message), answering through `send`.
 * Calls run one at a time, since a command's news is gathered process-wide.
 */
export async function serveMcp(
	input: AsyncIterable<Buffer | string>,
	send: (line: string) => void,
	cwd: string,
	env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
	let queue: Promise<void> = Promise.resolve();
	const reply = (id: Message["id"], result: unknown) => send(JSON.stringify({ jsonrpc: "2.0", id, result }));
	const fail = (id: Message["id"], code: number, message: string) =>
		send(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));

	const handle = async (msg: Message): Promise<void> => {
		const { id, method, params = {} } = msg;
		const isRequest = id !== undefined && id !== null;
		switch (method) {
			case "initialize": {
				const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
				return reply(id, {
					protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
					capabilities: { tools: {} },
					serverInfo: { name: "abso", version: clientVersion() },
					instructions:
						"abso, the agent-first version control client. Each tool is the abso command of the same name and answers with the command line's text. Box runs (abso run, shot, bisect) stay in the shell.",
				});
			}
			case "ping":
				return reply(id, {});
			case "tools/list":
				return reply(id, { tools: mcpTools() });
			case "tools/call": {
				const name = typeof params.name === "string" ? params.name : "";
				const command = MCP_COMMANDS.find((c) => toolName(c) === name);
				if (command === undefined) return fail(id, -32602, `no tool ${JSON.stringify(name)}; tools/list names them`);
				const args = (params.arguments ?? {}) as Record<string, unknown>;
				const folder = typeof args.folder === "string" && args.folder !== "" ? resolve(cwd, args.folder) : cwd;
				let streamed = "";
				const result = await main(argvFor(command, args), {
					cwd: folder,
					env,
					write: (t) => (streamed += t),
					writeErr: (t) => (streamed += t),
				});
				// Text only: Claude Code shows the model structuredContent in place of the text when both are there,
				// and the point is the command line's words. json: true answers with the JSON instead.
				const text =
					args.json === true && result.data
						? JSON.stringify({ ...result.data, exit: result.exit }, null, 2)
						: [streamed, result.stdout, result.stderr]
								.map((t) => t.replace(/\n+$/, ""))
								.filter((t) => t !== "")
								.join("\n");
				return reply(id, {
					content: [{ type: "text", text: text === "" ? "(no output)" : text }],
					// Exit 1 is a failure; 2 (refused) and 3 (still queued) are answers the text explains.
					isError: result.exit === 1,
				});
			}
			default:
				// Notifications (no id) need no answer; an unknown request does.
				if (isRequest) fail(id, -32601, `abso mcp doesn't know ${JSON.stringify(method)}`);
		}
	};

	let buffer = "";
	for await (const chunk of input) {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line === "") continue;
			let msg: Message;
			try {
				msg = JSON.parse(line) as Message;
			} catch {
				fail(null, -32700, "not JSON");
				continue;
			}
			queue = queue
				.then(() => handle(msg))
				.catch((e: unknown) => fail(msg.id, -32603, e instanceof Error ? e.message : String(e)));
		}
	}
	await queue;
}
