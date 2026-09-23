// Covers file naming rules and the loopback dialog server.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFileNames, sanitize } from "../src/naming.js";
import { DialogServer } from "../src/server.js";
import { DEFAULT_OPTIONS, type BounceOptions, type BounceTarget } from "../src/types.js";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easybounce-names-"));

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(36)} ${detail}`);
  if (!ok) failures += 1;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const targets: BounceTarget[] = [
  { clipName: "Kick", trackName: "Drums", startTime: 0, endTime: 4 },
  { clipName: "Snare/Hat", trackName: "Drums", startTime: 4, endTime: 8 },
  { clipName: "", trackName: "Drums", startTime: 8, endTime: 12 },
  ...Array.from({ length: 8 }, (_, i) => ({ clipName: `C${i}`, trackName: "Drums", startTime: 0, endTime: 1 })),
];
const opts = (o: Partial<BounceOptions>): BounceOptions =>
  ({ ...structuredClone(DEFAULT_OPTIONS), ...o, outputDir: DIR });

const byClip = buildFileNames(targets.slice(0, 3), opts({}), "wav");
check("clip names, slash sanitized, empty falls back to track",
  eq(byClip, ["Kick.wav", "Snare-Hat.wav", "Drums.wav"]), byClip.join(" "));

const byTrack = buildFileNames(targets, opts({ naming: { ...DEFAULT_OPTIONS.naming, mode: "track-index" } }), "wav");
check("track + zero-padded index", byTrack[0] === "Drums 01.wav" && byTrack[10] === "Drums 11.wav", `${byTrack[0]} … ${byTrack[10]}`);

const noPad = buildFileNames(targets, opts({ naming: { ...DEFAULT_OPTIONS.naming, mode: "track-index", padIndex: false, startIndex: 5 } }), "aif");
check("start index + no padding", noPad[0] === "Drums 5.aif" && noPad[5] === "Drums 10.aif", `${noPad[0]} … ${noPad[5]}`);

const custom = buildFileNames(targets.slice(0, 2), opts({ naming: { ...DEFAULT_OPTIONS.naming, mode: "custom-index", customName: "Vox Take" } }), "mp3");
check("custom name + index", eq(custom, ["Vox Take 1.mp3", "Vox Take 2.mp3"]), custom.join(" "));

// Duplicate clip names must not overwrite each other.
const dupes: BounceTarget[] = [0, 1, 2].map(() => ({ clipName: "Loop", trackName: "T", startTime: 0, endTime: 1 }));
const uniq = buildFileNames(dupes, opts({}), "wav");
check("duplicate clip names deduped", eq(uniq, ["Loop.wav", "Loop 2.wav", "Loop 3.wav"]), uniq.join(" "));

// Existing files on disk must not be overwritten either.
fs.writeFileSync(`${DIR}/Kick.wav`, "");
const existing = buildFileNames([targets[0]], opts({}), "wav");
check("existing file on disk avoided", eq(existing, ["Kick 2.wav"]), existing.join(" "));

check("reserved and empty names", sanitize("") === "Clip" && sanitize("con") === "Clip" && sanitize("a?b*c") === "a-b-c",
  `${sanitize("")} ${sanitize("con")} ${sanitize("a?b*c")}`);

// Server: token gating and endpoints.
const server = new DialogServer("<html>ui</html>", {
  context: () => ({ hello: "world" }),
  preview: (request) => [`echoed:${JSON.stringify(request)}`],
});
const url = await server.start();
const page = await (await fetch(url)).text();
check("serves the dialog html", page === "<html>ui</html>", page);
const ctx = await (await fetch(`${url}api/context`)).json();
check("context endpoint", eq(ctx, { hello: "world" }), JSON.stringify(ctx));
const prev = await (await fetch(`${url}api/preview`, { method: "POST", body: JSON.stringify({ a: 1 }) })).json();
check("preview endpoint round-trips body", prev.names[0] === 'echoed:{"a":1}', prev.names[0]);
const base = url.replace(/\/[0-9a-f]{32}\/$/, "");
const bad = await fetch(`${base}/deadbeef/api/context`);
check("wrong token rejected", bad.status === 404, String(bad.status));
await server.stop();
const closed = await fetch(url).then(() => "still up").catch(() => "closed");
check("server stops", closed === "closed", closed);

fs.rmSync(DIR, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
