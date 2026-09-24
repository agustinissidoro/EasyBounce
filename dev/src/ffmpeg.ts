import { execFile } from "node:child_process";
import * as path from "node:path";
import { isExecutableFile } from "./sandbox.js";

/** Places Homebrew, MacPorts and the common Windows installers put ffmpeg. */
const CANDIDATE_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/opt/local/bin",
  "C:/Program Files/ffmpeg/bin",
  "C:/ffmpeg/bin",
];

export class FfmpegMissingError extends Error {
  constructor() {
    super(
      "ffmpeg was not found. Install it (macOS: `brew install ffmpeg`, " +
        "Windows: `winget install ffmpeg`) or set the ffmpeg path in the bounce dialog.",
    );
    this.name = "FfmpegMissingError";
  }
}

let cached: string | undefined;

/** Resolves an ffmpeg binary, preferring an explicit override. */
export function findFfmpeg(override?: string): string {
  if (override) {
    if (!isExecutable(override)) throw new FfmpegMissingError();
    return override;
  }
  if (cached) return cached;

  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const fromPath = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of [...fromPath, ...CANDIDATE_DIRS]) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (isExecutable(candidate)) {
      cached = candidate;
      return candidate;
    }
  }
  throw new FfmpegMissingError();
}

function isExecutable(file: string): boolean {
  return isExecutableFile(file);
}

/**
 * Runs ffmpeg and resolves with its combined output. Analysis filters such as
 * `volumedetect` write to stderr; listings such as `-encoders` go to stdout.
 */
export function runFfmpeg(
  bin: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-hide_banner", "-nostdin", ...args],
      { signal, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const tail = stderr.trim().split("\n").slice(-6).join("\n");
          reject(new Error(`ffmpeg failed: ${tail || error.message}`));
          return;
        }
        resolve(stderr + stdout);
      },
    );
  });
}

/** Peak level of the input in dBFS, or `-Infinity` for pure silence. */
export async function measurePeakDb(
  bin: string,
  input: string,
  filters: string[],
  signal?: AbortSignal,
): Promise<number> {
  const chain = [...filters, "volumedetect"].join(",");
  const log = await runFfmpeg(
    bin,
    ["-i", input, "-af", chain, "-f", "null", "-"],
    signal,
  );
  const match = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(log);
  return match ? Number(match[1]) : -Infinity;
}

export interface SilenceBounds {
  /** Seconds of silence to remove from the head. */
  leading: number;
  /** Seconds of silence to remove from the tail. */
  trailing: number;
  /** Total duration of the input in seconds. */
  duration: number;
}

/**
 * Finds the silent head and tail of a file using `silencedetect`. Only silence
 * that touches an edge counts — silence in the middle is left alone.
 */
export async function detectSilenceBounds(
  bin: string,
  input: string,
  thresholdDb: number,
  signal?: AbortSignal,
): Promise<SilenceBounds> {
  const log = await runFfmpeg(
    bin,
    [
      "-i",
      input,
      "-af",
      `silencedetect=noise=${thresholdDb}dB:d=0.001`,
      "-f",
      "null",
      "-",
    ],
    signal,
  );

  const duration = parseDuration(log);
  const periods: Array<{ start: number; end: number }> = [];
  let open: number | undefined;

  for (const line of log.split("\n")) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start) {
      open = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (end && open !== undefined) {
      periods.push({ start: open, end: Number(end[1]) });
      open = undefined;
    }
  }
  // An unterminated period runs to the end of the file.
  if (open !== undefined) periods.push({ start: open, end: duration });

  const head = periods.find((p) => p.start <= 0.001);
  const tail = periods.find((p) => p.end >= duration - 0.001);

  return {
    leading: head ? Math.min(head.end, duration) : 0,
    trailing: tail && tail !== head ? Math.max(0, duration - tail.start) : 0,
    duration,
  };
}

function parseDuration(log: string): number {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Which output formats the installed ffmpeg can actually write. Builds differ:
 * `libmp3lame` and `libvorbis` are frequently left out, and finding that out
 * halfway through a bounce is worse than greying the option out up front.
 */
export async function supportedFormats(bin: string): Promise<Record<string, boolean>> {
  let encoders = "";
  try {
    encoders = await runFfmpeg(bin, ["-encoders"]);
  } catch {
    // An ffmpeg that cannot list its encoders still writes PCM.
  }
  return {
    wav: true,
    aiff: true,
    mp3: encoders.includes("libmp3lame"),
    ogg: encoders.includes("libvorbis"),
  };
}
