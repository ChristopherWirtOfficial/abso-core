// Ask Jev how to settle each marker block in one file (#19), the way abso pull
// leaves a held push's file. Prints Jev's pick and its probabilities; changes nothing.
//
//   node scripts/autosettle/settle-one.ts <file> [--message "<your held push's message>"] [--issue "..."] [--name <path in the project>] [--json]
//
// Needs JEV_API_KEY in the environment.

import { readFileSync } from "node:fs";
import { findBlocks } from "../../client/src/settle.ts";
import { ask, dollars, type Hold, PICKS } from "./jev.ts";

const CONTEXT = 15;
const CLOSE = /^>>>>>>> theirs: (.*?), version (\d+) "(.*)"$/;

/** Each marker block in a file's text as a Hold. */
export function holdsIn(
	text: string,
	file: string,
	extra: { yourMessage?: string; yourAgent?: string; issue?: string } = {},
): Hold[] {
	const lines = text.split(/\r?\n/);
	return findBlocks(lines).map((b) => {
		const close = CLOSE.exec(lines[b.end]!);
		return {
			file,
			base: b.base,
			yours: b.yours,
			theirs: b.theirs,
			before: lines.slice(Math.max(0, b.start - CONTEXT), b.start),
			after: lines.slice(b.end + 1, b.end + 1 + CONTEXT),
			...(close ? { theirAgent: close[1], theirMessage: close[3] } : {}),
			...extra,
		};
	});
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const path = args[0];
	if (!path || path.startsWith("--")) {
		console.error(
			'usage: node scripts/autosettle/settle-one.ts <file> [--message "..."] [--issue "..."] [--name <path>] [--json]',
		);
		process.exit(2);
	}
	const holds = holdsIn(readFileSync(path, "utf8"), flag(args, "--name") ?? path, {
		...(flag(args, "--message") ? { yourMessage: flag(args, "--message") } : {}),
		...(flag(args, "--issue") ? { issue: flag(args, "--issue") } : {}),
	});
	if (holds.length === 0) {
		console.error(`${path} has no marker blocks.`);
		process.exit(1);
	}
	const results = [];
	for (const [i, h] of holds.entries()) {
		const v = await ask(h);
		results.push({ block: i + 1, ...v });
		if (args.includes("--json")) continue;
		const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
		console.log(`Block ${i + 1} of ${holds.length} in ${h.file}: ${v.pick}, confidence ${v.confidence.toFixed(2)}`);
		console.log(`  probabilities: ${PICKS.map((k) => `${k} ${pct(v.probabilities[k])}`).join(", ")}`);
		console.log(
			`  each order: ${v.orders.map((o) => `${o.pick} ${o.confidence.toFixed(2)}`).join(" / ")}; side questions: ${Object.entries(
				v.signs,
			)
				.map(([k, p]) => `${k} ${pct(p)}`)
				.join(", ")}`,
		);
		console.log(
			`  ${v.model}, ${v.ms.toFixed(0)} ms, ${v.inputTokens} input tokens ($${dollars(v.inputTokens).toFixed(6)})`,
		);
	}
	if (args.includes("--json")) console.log(JSON.stringify(results, null, "\t"));
}

if (process.argv[1]?.endsWith("settle-one.ts")) await main();
