import * as fs from "node:fs";
import * as path from "node:path";
import type { AudioTrack, ExtensionContext } from "@ableton-extensions/sdk";
import { processRenderedFile } from "./audio.js";
import { findFfmpeg } from "./ffmpeg.js";
import { makeDirectory } from "./sandbox.js";
import { buildFileNames } from "./naming.js";
import type { BounceOptions, BounceTarget, Format } from "./types.js";

type Ctx = ExtensionContext<"1.0.0">;

export interface BounceJob {
  track: AudioTrack<"1.0.0">;
  target: BounceTarget;
}

export interface BounceSummary {
  written: string[];
  /** Clips that produced no file. */
  skipped: Array<{ name: string; reason: string }>;
  /** Files that were written, but with something worth saying about them. */
  notes: Array<{ name: string; reason: string }>;
  cancelled: boolean;
  outputDir: string;
}

const EXTENSIONS: Record<Format, string> = {
  wav: "wav",
  aiff: "aif",
  mp3: "mp3",
  ogg: "ogg",
};

export function extensionFor(format: Format): string {
  return EXTENSIONS[format];
}

/**
 * Renders each clip on its own and post-processes it. Live only exposes a
 * pre-FX arrangement render, so what lands on disk is the clip as the track
 * plays it — clip gain, warping and fades included, track devices not.
 */
export async function runBounce(
  context: Ctx,
  jobs: BounceJob[],
  options: BounceOptions,
  ffmpegPath: string,
  update: (text: string, progress?: number) => Promise<void>,
  signal: AbortSignal,
): Promise<BounceSummary> {
  const ffmpeg = findFfmpeg(ffmpegPath || undefined);
  makeDirectory(options.outputDir);

  const names = buildFileNames(
    jobs.map((job) => job.target),
    options,
    extensionFor(options.output.format),
  );

  const summary: BounceSummary = {
    written: [],
    skipped: [],
    notes: [],
    cancelled: false,
    outputDir: options.outputDir,
  };

  for (const [index, job] of jobs.entries()) {
    if (signal.aborted) {
      summary.cancelled = true;
      break;
    }

    const name = names[index];
    const base = (index / jobs.length) * 100;
    const step = 100 / jobs.length;

    const length = job.target.endTime - job.target.startTime;
    if (length <= 0) {
      summary.skipped.push({ name, reason: "clip has no length" });
      continue;
    }

    await update(`Rendering ${name} (${index + 1}/${jobs.length})`, base);

    let rendered: string | undefined;
    try {
      rendered = await context.resources.renderPreFxAudio(
        job.track,
        job.target.startTime,
        job.target.endTime,
      );

      await update(`Processing ${name} (${index + 1}/${jobs.length})`, base + step * 0.5);

      const outputPath = path.join(options.outputDir, name);
      const result = await processRenderedFile(
        ffmpeg,
        rendered,
        outputPath,
        options,
        signal,
      );
      if (result.silent && options.normalize.enabled) {
        summary.notes.push({ name, reason: "silent, so nothing to normalize" });
      }
      summary.written.push(name);
    } catch (error) {
      if (signal.aborted) {
        summary.cancelled = true;
        break;
      }
      summary.skipped.push({ name, reason: messageOf(error) });
    } finally {
      // The render lands in the extension's temp directory; it is ours to remove.
      if (rendered) fs.rm(rendered, { force: true }, () => {});
    }
  }

  await update("Done", 100);
  return summary;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
