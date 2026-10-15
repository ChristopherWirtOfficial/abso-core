// Ask a model how to settle each marker block in one file (#19), the way abso
// pull leaves a held push's file. Prints its pick; changes nothing.
//
//   node scripts/autosettle/settle-one.ts <file> [--via workers-ai|clef|jev] [--model <id>] [--message "<your held push's message>"] [--issue "..."] [--name <path in the project>] [--json]
//
// --via workers-ai (the default) needs workers-ai/ running under wrangler dev; --via jev needs JEV_API_KEY.

import { readFileSync } from "node:fs";
import { findBlocks } from "../../client/src/settle.ts";
import { askClef } from "./clef.ts";
import { ask, dollars, type Hold, PICKS } from "./jev.ts";
import { askWorkersAi } from "./workers-ai.ts";

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
	const model = flag(args, "--model") ? { model: flag(args, "--model")! } : {};
	for (const [i, h] of holds.entries()) {
		if (flag(args, "--via") === "clef") {
			const c = await askClef(h, { model: (flag(args, "--model") as "clef" | "clef-flash" | undefined) ?? "clef" });
			results.push({ block: i + 1, ...c });
			if (!args.includes("--json"))
				console.log(
					`Block ${i + 1} of ${holds.length} in ${h.file}: ${c.pick}, confidence ${c.confidence.toFixed(2)} (${c.by}${c.modelPick ? `, Clef said ${c.modelPick}` : ""})\n  probabilities: ${PICKS.map((k) => `${k} ${(c.probabilities[k] * 100).toFixed(0)}%`).join(", ")}\n  ${c.model}, ${c.ms.toFixed(0)} ms`,
				);
			continue;
		}
		if (flag(args, "--via") !== "jev") {
			const w = await askWorkersAi(h, model);
			results.push({ block: i + 1, ...w });
			if (!args.includes("--json"))
				console.log(
					`Block ${i + 1} of ${holds.length} in ${h.file}: ${w.pick}, confidence ${w.confidence.toFixed(2)}\n  ${w.reason}\n  ${w.model}, ${w.ms.toFixed(0)} ms (model ${w.modelMs} ms), ${w.inputTokens} input tokens`,
				);
			continue;
		}
		const v = await ask(h, model);
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
