import {
  detectSilenceBounds,
  measurePeakDb,
  runFfmpeg,
} from "./ffmpeg.js";
import type { BounceOptions, Depth, Format } from "./types.js";

/**
 * `volumedetect` bottoms out at -91 dB, so digital silence is reported as
 * -91 rather than -inf. Anything at or below this floor carries no signal to
 * normalize — without the guard a silent clip would be handed ~90 dB of gain.
 */
const SILENCE_FLOOR_DB = -90.5;

export interface ProcessResult {
  outputPath: string;
  /** Seconds removed from the head and tail, for the summary. */
  trimmedStart: number;
  trimmedEnd: number;
  /** Gain applied by normalization, in dB. */
  gainDb: number;
  foldedToMono: boolean;
  /** True when the source was silent end to end. */
  silent: boolean;
}

/**
 * Applies the whole option set to one rendered WAV and encodes the result.
 *
 * Analysis runs in separate passes so every measurement sees exactly the audio
 * the next stage will act on: silence bounds first, then the peak of the
 * already-trimmed, already-folded signal.
 */
export async function processRenderedFile(
  ffmpeg: string,
  input: string,
  outputPath: string,
  options: BounceOptions,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const probe = await probeInput(ffmpeg, input, signal);

  let trimmedStart = 0;
  let trimmedEnd = 0;
  if (options.trim.start || options.trim.end) {
    const bounds = await detectSilenceBounds(
      ffmpeg,
      input,
      options.trim.thresholdDb,
      signal,
    );
    if (options.trim.start) trimmedStart = bounds.leading;
    if (options.trim.end) trimmedEnd = bounds.trailing;
    // A file that is silent throughout reports one period covering everything.
    if (trimmedStart + trimmedEnd >= bounds.duration - 0.001) {
      trimmedStart = 0;
      trimmedEnd = 0;
    }
  }

  const duration = Math.max(0, probe.duration - trimmedStart - trimmedEnd);
  const trimFilters = buildTrimFilters(trimmedStart, duration, probe.duration);

  let foldedToMono = options.channels.mono;
  if (!foldedToMono && options.channels.monoIfFakeStereo && probe.channels === 2) {
    foldedToMono = await isFakeStereo(ffmpeg, input, signal);
  }
  const channelFilters = buildChannelFilters(
    foldedToMono,
    options.channels.mono,
    probe.channels,
  );

  const fadeFilters = buildFadeFilters(options, duration);

  // Measure the peak of everything that happens before the gain stage, so the
  // fades and the fold-down are already accounted for.
  let gainDb = 0;
  let silent = false;
  if (options.normalize.enabled) {
    const peak = await measurePeakDb(
      ffmpeg,
      input,
      [...trimFilters, ...channelFilters, ...fadeFilters],
      signal,
    );
    if (!Number.isFinite(peak) || peak <= SILENCE_FLOOR_DB) {
      silent = true;
    } else {
      gainDb = options.normalize.targetDb - peak;
    }
  }

  const filters = [
    ...trimFilters,
    ...channelFilters,
    ...fadeFilters,
    ...(gainDb !== 0 ? [`volume=${gainDb.toFixed(4)}dB`] : []),
    ...buildPadFilters(options),
  ];

  // Names are chosen to be free, so never clobber: if the file appeared since,
  // failing is better than silently overwriting someone's bounce.
  const args = ["-n", "-i", input];
  if (filters.length > 0) args.push("-af", filters.join(","));
  args.push(...encoderArgs(options.output.format, options.output.depth));
  if (options.output.sampleRate > 0) {
    args.push("-ar", String(options.output.sampleRate));
  }
  if (options.output.format === "mp3" || options.output.format === "ogg") {
    args.push("-b:a", `${options.output.bitrate}k`);
  }
  args.push(outputPath);

  await runFfmpeg(ffmpeg, args, signal);

  return { outputPath, trimmedStart, trimmedEnd, gainDb, foldedToMono, silent };
}

function buildTrimFilters(
  start: number,
  duration: number,
  sourceDuration: number,
): string[] {
  if (start <= 0 && duration >= sourceDuration - 0.001) return [];
  const end = start + duration;
  return [`atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)}`, "asetpts=N/SR/TB"];
}

function buildChannelFilters(
  foldToMono: boolean,
  forced: boolean,
  channels: number,
): string[] {
  if (!foldToMono || channels === 1) return [];
  // For real stereo, sum both sides. For fake stereo the sides are identical,
  // so taking the left one avoids the 0.5/0.5 summing gain question entirely.
  return forced ? ["aformat=channel_layouts=mono"] : ["pan=mono|c0=c0"];
}

function buildFadeFilters(options: BounceOptions, duration: number): string[] {
  const filters: string[] = [];
  // Fades are carved out of the audio that is already there, so they are
  // clamped to the region instead of extending it.
  const fadeIn = Math.min(options.fade.inMs / 1000, duration);
  const fadeOut = Math.min(options.fade.outMs / 1000, duration);

  if (fadeIn > 0) {
    filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(6)}`);
  }
  if (fadeOut > 0) {
    filters.push(
      `afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}`,
    );
  }
  return filters;
}

function buildPadFilters(options: BounceOptions): string[] {
  const filters: string[] = [];
  if (options.pad.startMs > 0) {
    filters.push(`adelay=${Math.round(options.pad.startMs)}:all=1`);
  }
  if (options.pad.endMs > 0) {
    filters.push(`apad=pad_dur=${(options.pad.endMs / 1000).toFixed(6)}`);
  }
  return filters;
}

function encoderArgs(format: Format, depth: Depth): string[] {
  switch (format) {
    case "wav":
      return ["-c:a", depth === 16 ? "pcm_s16le" : depth === 24 ? "pcm_s24le" : "pcm_s32le"];
    case "aiff":
      return ["-c:a", depth === 16 ? "pcm_s16be" : depth === 24 ? "pcm_s24be" : "pcm_s32be"];
    case "mp3":
      return ["-c:a", "libmp3lame"];
    case "ogg":
      return ["-c:a", "libvorbis"];
  }
}

export interface Probe {
  channels: number;
  sampleRate: number;
  duration: number;
}

/** Reads channel count, rate and duration out of ffmpeg's own stream log. */
export async function probeInput(
  ffmpeg: string,
  input: string,
  signal?: AbortSignal,
): Promise<Probe> {
  // `-t 0` makes ffmpeg read the header and stop, instead of decoding the
  // whole file just to report what is in it.
  const log = await runFfmpeg(
    ffmpeg,
    ["-i", input, "-t", "0", "-f", "null", "-"],
    signal,
  );

  const stream = /Stream #\d+:\d+[^\n]*: Audio: [^\n]*/.exec(log)?.[0] ?? "";
  const rate = /(\d+) Hz/.exec(stream);
  const layout = /Hz,\s*([^,]+),/.exec(stream)?.[1]?.trim() ?? "stereo";
  const time = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);

  return {
    channels: channelsFromLayout(layout),
    sampleRate: rate ? Number(rate[1]) : 44100,
    duration: time
      ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
      : 0,
  };
}

function channelsFromLayout(layout: string): number {
  if (layout === "mono") return 1;
  if (layout === "stereo") return 2;
  const count = /^(\d+) channels/.exec(layout);
  return count ? Number(count[1]) : 2;
}

/**
 * True when the two sides of a stereo file are identical, i.e. the file is
 * stereo only on paper. Detected by cancelling the sides against each other.
 */
async function isFakeStereo(
  ffmpeg: string,
  input: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const peak = await measurePeakDb(ffmpeg, input, ["pan=mono|c0=0.5*c0-0.5*c1"], signal);
  // -90 dBFS leaves room for dither and float rounding without catching any
  // genuine stereo width.
  return peak <= -90;
}
