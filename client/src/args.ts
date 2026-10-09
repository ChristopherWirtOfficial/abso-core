// Command-line parsing for avcs. Options take their value as the next word or
// after '=' (--agent=alice). -m is short for --message, -c for --carry, -n for --limit.

export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

/** 'optional': a value that may be left off (--check alone), which reads as ''. */
export type FlagKind = "string" | "boolean" | "optional";
export type FlagSpec = Readonly<Record<string, FlagKind>>;

const SHORT: Readonly<Record<string, string>> = { m: "message", h: "help", c: "carry", n: "limit" };

export interface Parsed {
	readonly positionals: readonly string[];
	readonly flags: ReadonlyMap<string, string | boolean>;
	/** Set when a `--` ended option parsing: how many positionals came before it. */
	readonly dashed?: number;
}

/** Parse words against a spec. `rest` stops option parsing at the first positional (for `run <command...>`). */
export function parseArgs(command: string, words: readonly string[], spec: FlagSpec, rest = false): Parsed {
	const all: FlagSpec = { ...spec, json: "boolean", help: "boolean" };
	const flags = new Map<string, string | boolean>();
	const positionals: string[] = [];
	let dashed: number | undefined;
	for (let i = 0; i < words.length; i++) {
		const word = words[i]!;
		if (word === "--") {
			dashed = positionals.length;
			positionals.push(...words.slice(i + 1));
			break;
		}
		if (!word.startsWith("-") || word === "-") {
			if (rest) {
				positionals.push(...words.slice(i));
				break;
			}
			positionals.push(word);
			continue;
		}
		let name: string;
		let inline: string | undefined;
		if (word.startsWith("--")) {
			const eq = word.indexOf("=");
			name = eq >= 0 ? word.slice(2, eq) : word.slice(2);
			inline = eq >= 0 ? word.slice(eq + 1) : undefined;
		} else {
			const long = SHORT[word.slice(1)];
			if (long === undefined) throw new UsageError(`unknown option ${word} for ${command}`);
			name = long;
		}
		const kind = all[name];
		if (kind === undefined) {
			const known = Object.keys(spec).map((n) => `--${n}`);
			throw new UsageError(
				`unknown option --${name} for ${command}${known.length > 0 ? `; its options are ${known.join(", ")}` : "; it takes no options"}`,
			);
		}
		if (kind === "boolean") {
			if (inline !== undefined) throw new UsageError(`--${name} is a switch and takes no value`);
			flags.set(name, true);
			continue;
		}
		let value = inline;
		if (value === undefined && kind === "optional" && (i + 1 >= words.length || words[i + 1]!.startsWith("-")))
			value = "";
		if (value === undefined) {
			if (i + 1 >= words.length) throw new UsageError(`--${name} needs a value`);
			value = words[++i]!;
		}
		if (flags.has(name)) throw new UsageError(`--${name} is given twice`);
		flags.set(name, value);
	}
	return { positionals, flags, ...(dashed === undefined ? {} : { dashed }) };
}

export function str(p: Parsed, name: string): string | undefined {
	const v = p.flags.get(name);
	return typeof v === "string" ? v : undefined;
}

export function bool(p: Parsed, name: string): boolean {
	return p.flags.get(name) === true;
}
