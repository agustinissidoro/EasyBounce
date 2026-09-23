// Verifies the ffmpeg pipeline end to end against generated audio.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processRenderedFile, probeInput } from "../src/audio.js";
import { findFfmpeg, measurePeakDb, supportedFormats } from "../src/ffmpeg.js";
import { DEFAULT_OPTIONS, type BounceOptions } from "../src/types.js";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easybounce-test-"));
const FF = findFfmpeg();
const ff = (args: string[]) => execFileSync(FF, ["-hide_banner", "-y", ...args], { stdio: "pipe" });

// 0.5s silence + 1s tone at -12 dBFS + 0.5s silence. True stereo: L 440 Hz, R 660 Hz.
ff(["-f","lavfi","-i","sine=frequency=440:duration=1","-f","lavfi","-i","sine=frequency=660:duration=1",
    "-filter_complex","[0:a][1:a]join=inputs=2:channel_layout=stereo,volume=-12dB,adelay=500|500,apad=pad_dur=0.5[a]",
    "-map","[a]","-t","2","-c:a","pcm_s24le",`${DIR}/stereo.wav`]);
// Same envelope, but both sides identical -> fake stereo.
ff(["-f","lavfi","-i","sine=frequency=440:duration=1","-af",
    "volume=-12dB,adelay=500,apad=pad_dur=0.5,pan=stereo|c0=c0|c1=c0","-t","2","-c:a","pcm_s24le",`${DIR}/fake.wav`]);

const opts = (o: Partial<BounceOptions>): BounceOptions =>
  ({ ...structuredClone(DEFAULT_OPTIONS), ...o, outputDir: DIR });
const dur = async (f: string) => (await probeInput(FF, f)).duration;
const chans = async (f: string) => (await probeInput(FF, f)).channels;
const rate = async (f: string) => (await probeInput(FF, f)).sampleRate;
const codec = (f: string) => JSON.parse(execFileSync(FF.replace(/ffmpeg(\.exe)?$/, "ffprobe$1"),
  ["-v","quiet","-print_format","json","-show_streams",f]).toString()).streams[0].codec_name;

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(40)} ${detail}`);
  if (!ok) failures += 1;
};

// 1. No options: length and channel count untouched.
await processRenderedFile(FF, `${DIR}/stereo.wav`, `${DIR}/o1.wav`, opts({}));
check("baseline keeps 2.0 s / stereo", Math.abs((await dur(`${DIR}/o1.wav`)) - 2) < 0.02 && (await chans(`${DIR}/o1.wav`)) === 2,
  `${(await dur(`${DIR}/o1.wav`)).toFixed(3)}s ${await chans(`${DIR}/o1.wav`)}ch`);

// 2. Trim both silent edges.
const trimOpts = { trim: { start: true, end: true, thresholdDb: -60 } };
let r = await processRenderedFile(FF, `${DIR}/stereo.wav`, `${DIR}/o2.wav`, opts(trimOpts));
const d2 = await dur(`${DIR}/o2.wav`);
check("trim both edges -> 1.0 s", Math.abs(d2 - 1) < 0.03, `${d2.toFixed(3)}s cut ${r.trimmedStart.toFixed(3)}/${r.trimmedEnd.toFixed(3)}`);

// 3. Trim start only.
r = await processRenderedFile(FF, `${DIR}/stereo.wav`, `${DIR}/o3.wav`, opts({ trim: { start: true, end: false, thresholdDb: -60 } }));
check("trim start only -> 1.5 s", Math.abs((await dur(`${DIR}/o3.wav`)) - 1.5) < 0.03, `${(await dur(`${DIR}/o3.wav`)).toFixed(3)}s`);

// 4. Normalize a -12 dBFS source to -0.3 dBFS.
await processRenderedFile(FF, `${DIR}/stereo.wav`, `${DIR}/o4.wav`, opts({ ...trimOpts, normalize: { enabled: true, targetDb: -0.3 } }));
const p4 = await measurePeakDb(FF, `${DIR}/o4.wav`, []);
check("normalize peak to -0.3 dBFS", Math.abs(p4 + 0.3) < 0.15, `${p4} dBFS`);

// 5. Forced mono.
await processRenderedFile(FF, `${DIR}/stereo.wav`, `${DIR}/o5.wav`, opts({ channels: { mono: true, monoIfFakeStereo: false } }));
check("forced mono -> 1 channel", (await chans(`${DIR}/o5.wav`)) === 1, `${await chans(`${DIR}/o5.wav`)}ch`);

// 6. Fake-stereo detection: folds the fake file, leaves the real one alone.
const fakeOpts = { channels: { mono: false, monoIfFakeStereo: true } };
const rFake = await processRenderedFile(FF, `${DIR}/fake.wav`, `${DIR}/o6a.wav`, opts(fakeOpts));
const rReal = await processRenderedFile(FF, `${DIR}/stereo.wav`, `${DIR}/o6b.wav`, opts(fakeOpts));
check("fake stereo folded, real kept", rFake.foldedToMono && !rReal.foldedToMono && (await chans(`${DIR}/o6a.wav`)) === 1 && (await chans(`${DIR}/o6b.wav`)) === 2,
  `fake=${await chans(`${DIR}/o6a.wav`)}ch real=${await chans(`${DIR}/o6b.wav`)}ch`);

// 7. Fades must not change the length.
await processRenderedFile(FF, `${DIR}/stereo.wav`, `${DIR}/o7.wav`, opts({ ...trimOpts, fade: { inMs: 200, outMs: 200 } }));
const d7 = await dur(`${DIR}/o7.wav`);
const headPeak = await measurePeakDb(FF, `${DIR}/o7.wav`, ["atrim=start=0:end=0.02"]);
check("fades keep length, attenuate head", Math.abs(d7 - d2) < 0.005 && headPeak < -30, `${d7.toFixed(3)}s head ${headPeak} dBFS`);

// 8. Padding does add time.
await processRenderedFile(FF, `${DIR}/stereo.wav`, `${DIR}/o8.wav`, opts({ ...trimOpts, pad: { startMs: 250, endMs: 500 } }));
check("pad adds 0.75 s", Math.abs((await dur(`${DIR}/o8.wav`)) - (d2 + 0.75)) < 0.03, `${(await dur(`${DIR}/o8.wav`)).toFixed(3)}s`);

// 9. Formats, depth and sample rate.
const available = await supportedFormats(FF);
console.log("encoders available:", available);
for (const [format, ext, expected] of [["wav","wav","pcm_s16le"],["aiff","aif","pcm_s24be"],["mp3","mp3","mp3"],["ogg","ogg","vorbis"]] as const) {
  if (!available[format]) { console.log(`SKIP  ${format} — not in this ffmpeg build`); continue; }
  const depth = format === "aiff" ? 24 : 16;
  const file = `${DIR}/o9.${ext}`;
  await processRenderedFile(FF, `${DIR}/stereo.wav`, file, opts({ output: { format, depth, sampleRate: 48000, bitrate: 192 } }));
  check(`${format} @48k`, codec(file) === expected && (await rate(file)) === 48000, `${codec(file)} ${await rate(file)} Hz`);
}

// 10. A fully silent input must not be trimmed away to nothing.
ff(["-f","lavfi","-i","anullsrc=channel_layout=stereo:sample_rate=44100","-t","1","-c:a","pcm_s24le",`${DIR}/silent.wav`]);
const rSilent = await processRenderedFile(FF, `${DIR}/silent.wav`, `${DIR}/o10.wav`, opts({ ...trimOpts, normalize: { enabled: true, targetDb: -0.3 } }));
check("silent input survives intact", rSilent.silent && Math.abs((await dur(`${DIR}/o10.wav`)) - 1) < 0.02, `${(await dur(`${DIR}/o10.wav`)).toFixed(3)}s silent=${rSilent.silent}`);

fs.rmSync(DIR, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
