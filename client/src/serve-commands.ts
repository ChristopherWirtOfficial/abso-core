// abso serve, shot and fetch: previews, screenshots and files out of a box.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { boxOf, runRun, shellWord, undoGitBashPaths } from "./box-commands.ts";
import { type Env, EXIT, type Output, open } from "./command-env.ts";
import { fetchedText, fetchFromBox } from "./fetch.ts";
import { untarGz } from "./tar.ts";

/** abso serve [--version N]: a preview of one version of shared at a stable URL, built once on the server (#37, Playtester 1). */
export async function runServe(args: Parsed, env: Env): Promise<Output> {
	const raw = str(args, "version");
	if (raw !== undefined && !/^\d+$/.test(raw))
		throw new UsageError(`--version is a version number (got ${JSON.stringify(raw)})`);
	const { api } = open(env);
	if (raw === undefined)
		(env.writeErr ?? env.write)(
			"avcs: building a preview of the newest version of shared (once per version; a minute the first time)…\n",
		);
	const s = await api.serve(raw === undefined ? undefined : Number(raw), str(args, "build"), str(args, "out"));
	if (!s.built || !s.url) {
		return {
			exit: EXIT.error,
			text: `The preview of version ${s.version} didn't build${s.exitCode !== undefined ? ` (exit ${s.exitCode})` : ""}: ${s.error ?? "see its output"}.${s.output ? `\nIts output ends:\n${s.output.trimEnd()}` : ""}`,
			json: { ...s },
		};
	}
	return {
		text: [
			`Version ${s.version} of shared: ${s.url}`,
			`${s.cached ? "Already built" : `Built in ${s.seconds} s`}: ${s.files} files, ${Math.round((s.bytes ?? 0) / 1024)} KB. The link needs no token and never changes; it serves exactly this version.`,
		].join("\n"),
		json: { ...s },
	};
}

/**
 * The script abso shot runs in the box (from /w/.avcs-shot, so 'playwright' is
 * the project's own). It reads its setup from AVCS_SHOT and prints marked
 * lines the client picks out: AVCS_SHOT_IMAGE {json}, blocks between
 * AVCS_SHOT_BEGIN <name> and AVCS_SHOT_END, and "eval: ", "page error: ",
 * "console " lines. No backticks or dollar-braces in here: it's a raw string.
 */
const SHOOTER = String.raw`import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const c = JSON.parse(process.env.AVCS_SHOT);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: c.w, height: c.h } });
const logged = [];
let dropped = 0;
// vite's own connection chatter isn't the game's.
p.on('console', (m) => { if (m.text().startsWith('[vite]')) return; if (logged.length < 30) logged.push(m.type() + ': ' + m.text().split('\n')[0].slice(0, 200)); else dropped++; });
p.on('pageerror', (e) => console.log('page error: ' + String(e).split('\n')[0]));
// Every element in document order, numbered from 1: the same page in the same state gives the same refs.
const inPage = (o) => {
  const skip = ['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'HTML'];
  const els = [...document.querySelectorAll('*')].filter((e) => !skip.includes(e.tagName.toUpperCase()));
  if (o.ref !== undefined) {
    const e = els[o.ref - 1];
    if (!e) return null;
    e.scrollIntoView({ block: 'center', inline: 'center' });
    const r = e.getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  }
  const ROLE = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', SVG: 'img', NAV: 'navigation', MAIN: 'main', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', FORM: 'form', DIALOG: 'dialog', CANVAS: 'canvas', LABEL: 'label', SUMMARY: 'button', P: 'paragraph', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', HEADER: 'banner', FOOTER: 'contentinfo', ARTICLE: 'article', SECTION: 'region', VIDEO: 'video', PROGRESS: 'progressbar', OPTION: 'option' };
  const INPUT = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button', image: 'button' };
  const role = (e) => e.getAttribute('role') || (e.tagName === 'INPUT' ? INPUT[e.type] || 'textbox' : ROLE[e.tagName.toUpperCase()] || 'generic');
  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const own = (e) => squash([...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
  const name = (e, r) => squash(e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('title') || e.getAttribute('placeholder') || (e.tagName === 'INPUT' ? e.value : '') || own(e) || (/^(button|link|heading|option|tab|menuitem)$/.test(r) ? e.textContent : '')).slice(0, 100);
  const INTERACTIVE = /^(button|link|checkbox|radio|tab|menuitem|slider|switch|option|textbox|combobox|canvas)$/;
  const interactive = (e, r) => INTERACTIVE.test(r) || e.hasAttribute('onclick') || e.hasAttribute('tabindex') || getComputedStyle(e).cursor === 'pointer';
  const depthOf = (e) => { let d = 0; for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) d++; return d; };
  const where = (b) => '(' + Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height) + ')';
  const q = o.find ? o.find.toLowerCase() : null;
  const out = [];
  els.forEach((e, i) => {
    if (e === document.body) return;
    const b = e.getBoundingClientRect();
    if (b.width === 0 || b.height === 0 || getComputedStyle(e).visibility === 'hidden') return;
    const r = role(e);
    const n = name(e, r);
    const line = r + (n ? ' "' + n.replace(/"/g, "'") + '"' : '') + ' [ref_' + (i + 1) + '] ' + where(b);
    if (q !== null) {
      if ((r + ' ' + n + ' ' + own(e)).toLowerCase().includes(q) && out.length < 20) out.push(line);
      return;
    }
    if (o.interactive) {
      if (interactive(e, r)) out.push(line);
      return;
    }
    if (r === 'generic' && !n) return;
    const d = depthOf(e);
    if (o.depth === null || d <= o.depth) out.push('  '.repeat(d) + line);
  });
  return out;
};
const block = (name, text, max) => {
  console.log('AVCS_SHOT_BEGIN ' + name);
  console.log(text.length > max ? text.slice(0, max) + '\n... (' + (text.length - max) + ' more characters; --max-chars raises the cap)' : text);
  console.log('AVCS_SHOT_END');
};
const at = async (spec) => {
  if (spec.ref === undefined) return [spec.x, spec.y];
  const pt = await p.evaluate(inPage, { ref: spec.ref });
  if (!pt) { console.log('page error: there is no ref_' + spec.ref + ' on the page (refs come from --tree or --find on the same page and state)'); process.exit(3); }
  return pt;
};
await p.goto(c.url, { waitUntil: 'load' });
if (c.eval !== null || c.clicks.length > 0 || c.mouse !== null) await p.waitForTimeout(1000);
if (c.eval !== null) { const r = await p.evaluate(c.eval); if (r !== undefined) console.log('eval: ' + JSON.stringify(r).slice(0, 300)); }
// Two frames after --eval, so what it changed is drawn before anything clicks it.
if (c.eval !== null) await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
for (const k of c.clicks) { if (k.ms > 0) await p.waitForTimeout(k.ms); const [x, y] = await at(k); await p.mouse.click(x, y); await p.waitForTimeout(300); }
// In small steps from the corner, so the page sees mousemove on the way, as a hand would make it.
if (c.mouse !== null) { const [x, y] = await at(c.mouse); await p.mouse.move(x, y, { steps: 10 }); }
await p.waitForTimeout(c.wait);
if (c.text) block('text', await p.evaluate(() => document.body ? document.body.innerText : ''), c.maxChars);
if (c.tree) block(c.interactive ? 'tree (interactive elements)' : 'tree', (await p.evaluate(inPage, { interactive: c.interactive, depth: c.depth })).join('\n'), c.maxChars);
if (c.find !== null) {
  const found = await p.evaluate(inPage, { find: c.find });
  block('find', found.length > 0 ? found.join('\n') : 'nothing on the page matches', c.maxChars);
}
if (c.image) {
  const clip = c.region ? { x: c.region[0], y: c.region[1], width: c.region[2] - c.region[0], height: c.region[3] - c.region[1] } : null;
  let png = await p.screenshot(clip ? { clip } : {});
  let w = clip ? clip.width : c.w;
  let h = clip ? clip.height : c.h;
  if (c.scale < 1) {
    // Downscaled in a blank page's canvas, so the game's page renders as it would for a player.
    const sw = Math.max(1, Math.round(w * c.scale));
    const sh = Math.max(1, Math.round(h * c.scale));
    const q = await b.newPage();
    const b64 = await q.evaluate(async ([data, sw, sh]) => {
      const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
      const cv = new OffscreenCanvas(sw, sh);
      const g = cv.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, sw, sh);
      const a = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let s = '';
      for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
      return btoa(s);
    }, [png.toString('base64'), sw, sh]);
    png = Buffer.from(b64, 'base64');
    w = sw;
    h = sh;
  }
  writeFileSync(c.out, png);
  console.log('AVCS_SHOT_IMAGE ' + JSON.stringify({ w, h, bytes: png.length }));
}
for (const l of logged) console.log('console ' + l);
if (dropped > 0) console.log('console (' + dropped + ' more messages not shown)');
await b.close();`;

/** A click or pointer target: page x,y, or an element's ref from --tree or --find, then (for clicks) ms to wait first. */
interface ShotPoint {
	x?: number;
	y?: number;
	ref?: number;
	ms: number;
}

function shotPoint(s: string, flag: string, wait: boolean): ShotPoint {
	const m = /^(?:(\d{1,5}),\s*(\d{1,5})|ref_(\d{1,6}))(?:\s*[@＠]\s*(\d{1,6}))?$/.exec(s.trim());
	if (!m || (!wait && m[4] !== undefined)) {
		throw new UsageError(
			`${flag} is x,y in page pixels or ref_N (from --tree or --find)${wait ? ", or either with @ms to wait first; several separated by ;" : ""} (got ${JSON.stringify(s)})`,
		);
	}
	const ms = Number(m[4] ?? 0);
	return m[3] !== undefined ? { ref: Number(m[3]), ms } : { x: Number(m[1]), y: Number(m[2]), ms };
}

/** What reading an image costs a model, roughly: about one token per 750 pixels. */
export function imageTokens(w: number, h: number): number {
	return Math.ceil((w * h) / 750);
}

/**
 * abso shot <path>: a look at the folder's game, taken in the box (#37, #39).
 * The box runs the project's vite dev server and Playwright on
 * http://127.0.0.1:4173<path>. By default a PNG comes back to .avcs/shots/
 * (never recorded) or --out. --scale and --region make it smaller; --text,
 * --tree and --find read the page with no image at all. Coordinates are
 * always the page's, whatever the scale or region.
 */
export async function runShot(args: Parsed, env: Env): Promise<Output> {
	// Git Bash turns a bare "/" (or "/x") into a Windows path before abso sees it; take it back.
	const page = undoGitBashPaths(args.positionals, env.env).words[0] ?? "/";
	if (args.positionals.length > 1 || !page.startsWith("/"))
		throw new UsageError('give the page as a path: abso shot "/?mute&t=240"');
	const wait = str(args, "wait") ?? "3000";
	if (!/^\d{1,6}$/.test(wait)) throw new UsageError("--wait is milliseconds after load, like 3000");
	const size = str(args, "size") ?? "1280x720";
	if (!/^\d{2,5}x\d{2,5}$/.test(size)) throw new UsageError("--size is WIDTHxHEIGHT, like 1280x720");
	const [width, height] = size.split("x").map(Number) as [number, number];
	// --eval and --click set the page up before the shot (#37, Builder 7): JS first, then each click, in order.
	const evalJs = str(args, "eval");
	// x,y@ms waits ms before that click (#37, Writer 1): a card --eval or an earlier click brings up may need a draw or two.
	const clicks = (str(args, "click") ?? "")
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.map((s) => shotPoint(s, "--click", true));
	// --mouse leaves the pointer over a point for the shot, for hover cards (#37, Builder 7).
	const mouseSpec = str(args, "mouse");
	const mouse = mouseSpec === undefined ? null : shotPoint(mouseSpec, "--mouse", false);
	for (const pt of [...clicks, ...(mouse ? [mouse] : [])]) {
		if (pt.x !== undefined && (pt.x >= width || pt.y! >= height))
			throw new UsageError(
				`${pt.x},${pt.y} is off the ${size} page; points are page pixels, whatever --scale or --region`,
			);
	}
	// Smaller images (#39): --scale shrinks it, --region takes part of the page at full detail.
	const scaleText = str(args, "scale") ?? "1";
	const scale = Number(scaleText);
	if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(scaleText) || scale < 0.1 || scale > 1)
		throw new UsageError(
			`--scale is 0.1-1, like 0.5 for half the width and height, a quarter of the tokens (got ${JSON.stringify(scaleText)})`,
		);
	const regionSpec = str(args, "region");
	let region: [number, number, number, number] | null = null;
	if (regionSpec !== undefined) {
		const m = /^(\d{1,5}),\s*(\d{1,5}),\s*(\d{1,5}),\s*(\d{1,5})$/.exec(regionSpec.trim());
		const r = m ? ([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number]) : null;
		if (!r || r[2] <= r[0] || r[3] <= r[1] || r[2] > width || r[3] > height) {
			throw new UsageError(
				`--region is x0,y0,x1,y1 in page pixels, inside the ${size} page, with x1 > x0 and y1 > y0 (got ${JSON.stringify(regionSpec)})`,
			);
		}
		region = r;
	}
	// Reading without an image (#39): the page's text, its elements, or the ones matching some text.
	const text = bool(args, "text");
	const tree = bool(args, "tree") || bool(args, "interactive");
	const interactive = bool(args, "interactive");
	const find = str(args, "find") ?? null;
	if (find !== null && find.trim() === "") throw new UsageError("--find needs some text to look for");
	const depthText = str(args, "depth");
	if (depthText !== undefined && !/^\d{1,3}$/.test(depthText))
		throw new UsageError(`--depth is a number of levels (got ${JSON.stringify(depthText)})`);
	const maxText = str(args, "max-chars") ?? "5000";
	if (!/^\d{2,7}$/.test(maxText))
		throw new UsageError(`--max-chars is a number, like 5000 (got ${JSON.stringify(maxText)})`);
	const reads = text || tree || find !== null;
	const image =
		bool(args, "image") ||
		!reads ||
		region !== null ||
		str(args, "scale") !== undefined ||
		str(args, "out") !== undefined;
	const name = `shot-${str(args, "at") !== undefined ? `v${str(args, "at")}-` : ""}${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
	const setup = {
		url: `http://127.0.0.1:4173${page}`,
		w: width,
		h: height,
		wait: Number(wait),
		eval: evalJs ?? null,
		clicks,
		mouse,
		out: `.avcs-shot/${name}`,
		image,
		scale,
		region,
		text,
		tree,
		interactive,
		depth: depthText === undefined ? null : Number(depthText),
		find,
		maxChars: Number(maxText),
	};
	const script = [
		"set -e",
		'stop() { pkill -f "vite --host 127.0.0.1 --port 4173" 2>/dev/null || true; }',
		"stop; trap stop EXIT",
		"[ -d node_modules ] || npm ci --no-audit --no-fund >/tmp/shot-npm.log 2>&1 || { tail -20 /tmp/shot-npm.log; exit 1; }",
		'npx --no-install playwright --version >/dev/null 2>&1 || { echo "abso shot needs playwright in the project\'s devDependencies"; exit 1; }',
		"ls ~/.cache/ms-playwright 2>/dev/null | grep -q chromium || npx --no-install playwright install chromium >/tmp/shot-pw.log 2>&1 || { tail -20 /tmp/shot-pw.log; exit 1; }",
		"(npx --no-install vite --host 127.0.0.1 --port 4173 --strictPort >/tmp/shot-vite.log 2>&1 &)",
		"for i in $(seq 120); do curl -sf -o /dev/null http://127.0.0.1:4173/ && break; sleep 0.5; done",
		'curl -sf -o /dev/null http://127.0.0.1:4173/ || { echo "the vite dev server did not start:"; tail -20 /tmp/shot-vite.log; exit 1; }',
		"mkdir -p .avcs-shot",
		`cat > .avcs-shot/shoot.mjs <<'AVCS_SHOT_EOF'\n${SHOOTER}\nAVCS_SHOT_EOF`,
		`AVCS_SHOT=${shellWord(JSON.stringify(setup))} node .avcs-shot/shoot.mjs`,
	].join("\n");
	const said: string[] = [];
	const keep = (t: string) => void said.push(t);
	const flags = new Map<string, string | boolean>();
	const box = str(args, "box");
	if (box !== undefined) flags.set("box", box);
	// --at shoots a version of the folder's space instead of the folder, as abso run --at runs one (#37, Builder 5).
	const at = str(args, "at");
	if (at !== undefined && !/^\d+$/.test(at))
		throw new UsageError(`--at is a version number (got ${JSON.stringify(at)})`);
	if (at !== undefined) flags.set("at", at);
	const ran = await runRun({ positionals: [script], flags }, { ...env, write: keep, writeErr: keep, runKind: "shot" });
	const lines = said.join("").split("\n");
	// What the page said: --eval's result, uncaught errors and console messages.
	const notes = lines.filter((l) => l.startsWith("eval: ") || l.startsWith("page error: ") || l.startsWith("console "));
	if ((ran.exit ?? 0) !== 0) {
		return {
			exit: ran.exit ?? EXIT.error,
			text: `No shot (exit ${ran.exit}). The box said:\n${said.join("").trimEnd()}`,
			json: { exit: ran.exit, notes },
		};
	}
	const blocks: { name: string; text: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i]!.startsWith("AVCS_SHOT_BEGIN ")) continue;
		const end = lines.indexOf("AVCS_SHOT_END", i + 1);
		blocks.push({
			name: lines[i]!.slice("AVCS_SHOT_BEGIN ".length),
			text: lines.slice(i + 1, end < 0 ? undefined : end).join("\n"),
		});
		if (end > i) i = end;
	}
	const steps = [
		...(evalJs !== undefined ? ["--eval"] : []),
		...(clicks.length > 0 ? [`${clicks.length === 1 ? "1 click" : `${clicks.length} clicks`}`] : []),
		...(mouse !== null
			? [`the pointer at ${mouse.ref !== undefined ? `ref_${mouse.ref}` : `${mouse.x},${mouse.y}`}`]
			: []),
	];
	const head = `${page}${at !== undefined ? ` at version ${at}` : ""}, page ${size}${steps.length > 0 ? `, after ${steps.join(" and ")}` : ""}, ${wait} ms after load`;
	const out: string[] = [];
	let shot: { path: string; w: number; h: number; bytes: number; tokens: number } | null = null;
	if (image) {
		const info = lines.find((l) => l.startsWith("AVCS_SHOT_IMAGE "));
		const { root, api } = open(env);
		void root;
		api.box = boxOf(args, env);
		const gz = await api.boxFiles(`.avcs-shot/${name}`);
		const png = gz === null ? undefined : untarGz(gz).find((e) => e.path === `.avcs-shot/${name}`);
		if (!png || !info)
			return { exit: EXIT.error, text: "The screenshot ran but its file was not in the box.", json: { notes } };
		const { w, h } = JSON.parse(info.slice("AVCS_SHOT_IMAGE ".length)) as { w: number; h: number };
		const path = resolve(env.cwd, str(args, "out") ?? join(".avcs", "shots", name));
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, png.data);
		shot = { path, w, h, bytes: png.data.length, tokens: imageTokens(w, h) };
		const what = [
			region ? `region ${region.join(",")}` : "the whole page",
			...(scale < 1 ? [`scale ${scale}`] : []),
		].join(" at ");
		out.push(`Screenshot of ${head}: ${relative(env.cwd, path) || path}`);
		out.push(
			`  ${w}x${h} pixels (${what}), ${Math.max(1, Math.round(png.data.length / 1024))} KB; about ${shot.tokens} tokens if read. Clicks take page pixels, whatever the scale or region.`,
		);
	} else {
		out.push(`Read ${head} (no image):`);
	}
	for (const b of blocks)
		out.push(`${b.name[0]!.toUpperCase()}${b.name.slice(1)}${b.name === "find" ? ` "${find}"` : ""}:`, b.text);
	if (blocks.some((b) => b.name !== "text"))
		out.push("Click one with --click ref_N (or --mouse ref_N) on the same page and state.");
	out.push(...notes.map((n) => `  ${n}`));
	return {
		text: out.join("\n"),
		json: {
			...(shot ?? {}),
			page,
			pageSize: { w: width, h: height },
			region,
			scale,
			at: at === undefined ? null : Number(at),
			wait: Number(wait),
			eval: evalJs ?? null,
			clicks,
			...Object.fromEntries(blocks.map((b) => [b.name.split(" ")[0], b.text])),
			notes,
		},
	};
}

export async function runFetch(args: Parsed, env: Env): Promise<Output> {
	const { root, api } = open(env);
	api.box = boxOf(args, env);
	const f = await fetchFromBox(root, api, args.positionals);
	const lines = fetchedText(f);
	return { text: lines.length > 0 ? lines.join("\n") : "Nothing fetched.", json: { ...f } };
}
